#!/usr/bin/env python3
"""Fixed-operation ERP backup/test-refresh service. No SQL or commands from callers."""
import argparse
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import socket
import sqlite3
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OPERATIONS = {"backup_production", "backup_test", "refresh_test"}
IDENT = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
STEPS = ["verify source and target", "back up current test", "dump production",
         "restore isolated candidate", "apply and verify test settings",
         "stop test application", "retain old test and switch databases",
         "start and check test application"]


class MaintenanceError(Exception):
    pass


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def protected(path):
    p = Path(path)
    st = p.lstat()
    if p.is_symlink() or not p.is_file() or st.st_uid != 0 or st.st_mode & 0o022:
        raise MaintenanceError("UNTRUSTED_CONFIGURATION")
    return p


def load_config(path):
    c = json.loads(protected(path).read_text())
    for k in ("production_db", "test_db", "test_owner", "admin_db"):
        if not IDENT.fullmatch(c[k]):
            raise MaintenanceError("INVALID_CONFIGURATION")
    if not (c["test_db"].startswith("test") or c["test_db"].endswith("_test")) or c["production_db"] == c["test_db"]:
        raise MaintenanceError("UNSAFE_TARGET")
    if c["admin_db"] in (c["production_db"], c["test_db"]):
        raise MaintenanceError("ADMIN_REQUIRES_MAINTENANCE_DATABASE")
    hostname = c.get("test_hostname", "")
    machine_hash = c.get("test_machine_sha256", "")
    if (not re.fullmatch(r"[a-z0-9_-]*test[a-z0-9_-]*", hostname)
            or socket.gethostname() != hostname
            or not re.fullmatch(r"[a-f0-9]{64}", machine_hash)
            or digest("/etc/machine-id") != machine_hash):
        raise MaintenanceError("TEST_HOST_IDENTITY_MISMATCH")
    if not re.fullmatch(r"(?:idempiere|[a-z0-9_-]*test[a-z0-9_-]*)\.service", c["test_unit"]):
        raise MaintenanceError("UNSAFE_TEST_UNIT")
    if len(c["token"]) < 43:
        raise MaintenanceError("INVALID_AUTHENTICATION")
    for k in ("production_service", "test_service", "admin_service"):
        if not IDENT.fullmatch(c[k]):
            raise MaintenanceError("INVALID_SERVICE")
    if protected(c["pg_service_file"]).stat().st_mode & 0o027:
        raise MaintenanceError("SECRET_FILE_PERMISSIONS")
    passfile = Path(c["pgpass_file"])
    st = passfile.lstat()
    if passfile.is_symlink() or not passfile.is_file() or st.st_uid != os.geteuid() or st.st_mode & 0o077:
        raise MaintenanceError("SECRET_FILE_PERMISSIONS")
    for k in ("overlay_sql", "verify_sql", "isolation_probe", "health_probe"):
        protected(c[k])
    if len({c[k] for k in ("production_service", "test_service", "admin_service")}) != 3:
        raise MaintenanceError("SEPARATE_DATABASE_SERVICES_REQUIRED")
    c["config_sha256"] = digest(path)
    root = Path(c["state_dir"])
    if not root.is_absolute() or root.is_symlink() or root.stat().st_mode & 0o077:
        raise MaintenanceError("STATE_DIRECTORY_PERMISSIONS")
    return c


def command(args, c, *, capture=True):
    # Child stderr may contain passwords/connection details. Never persist or return it.
    env = {"PATH": "/usr/bin:/bin", "HOME": "/var/lib/blindmotion-erp-ops",
           "PGSERVICEFILE": c["pg_service_file"], "PGPASSFILE": c["pgpass_file"],
           "PGCONNECT_TIMEOUT": "10", "LANG": "C.UTF-8"}
    try:
        result = subprocess.run(args, env=env, stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=7200, check=True)
        return result.stdout.decode().strip() if capture else ""
    except (subprocess.SubprocessError, OSError):
        raise MaintenanceError("COMMAND_FAILED") from None


class Engine:
    def __init__(self, config_path, run=command):
        self.config_path = config_path
        self.c = load_config(config_path)
        self.run = run
        self.root = Path(self.c["state_dir"])
        self.db = self.root / "jobs.sqlite"
        with self.connect() as db:
            db.executescript("""CREATE TABLE IF NOT EXISTS plans
                (hash TEXT PRIMARY KEY, body TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS jobs
                (id TEXT PRIMARY KEY, plan_hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT NOT NULL);
                CREATE UNIQUE INDEX IF NOT EXISTS plan_once ON jobs(plan_hash);""")
            # Never silently repeat a destructive job interrupted by restart/power loss.
            db.execute("UPDATE jobs SET state='needs_operator', result=? WHERE state IN ('queued','running')",
                       (json.dumps({"ok": False, "error_code": "INTERRUPTED_JOB", "needs_operator": True}),))

    def connect(self):
        return sqlite3.connect(self.db, timeout=10)

    def conn(self, service, database=None):
        return "service=" + service + (" dbname=" + database if database else "")

    def sql(self, service, sql, database=None):
        return self.run(["/usr/bin/psql", "-X", "--no-password", "--set=ON_ERROR_STOP=1", "-At",
                         "--dbname", self.conn(service, database), "--command", sql], self.c)

    def identity(self, service, expected_db):
        raw = self.sql(service, "SELECT json_build_object('database',current_database(), 'address',"
                       "coalesce(inet_server_addr()::text,'local'), 'port',current_setting('port'),"
                       " 'role',current_user, 'oid',oid, 'encoding',pg_encoding_to_char(encoding),"
                       " 'locale_provider',datlocprovider, 'collation',datcollate, 'ctype',datctype)"
                       " FROM pg_database WHERE datname=current_database()")
        value = json.loads(raw)
        if value["database"] != expected_db:
            raise MaintenanceError("DATABASE_IDENTITY_MISMATCH")
        # Admin-installed expected identities bind services to independently verified servers/roles.
        expected = self.c["identities"][service]
        if any(str(value[k]) != str(expected[k]) for k in ("address", "port", "role")):
            raise MaintenanceError("SERVER_IDENTITY_MISMATCH")
        return value

    def preflight(self, operation):
        if load_config(self.config_path)["config_sha256"] != self.c["config_sha256"]:
            raise MaintenanceError("CONFIG_CHANGED_RESTART_REQUIRED")
        c = self.c
        identities = {}
        for service, name in ((c["production_service"], c["production_db"]),
                              (c["test_service"], c["test_db"]),
                              (c["admin_service"], c["admin_db"])):
            identities[service] = self.identity(service, name)
        source, target, admin = [identities[c[k]] for k in ("production_service", "test_service", "admin_service")]
        if (source["address"], source["port"], source["database"]) == (target["address"], target["port"], target["database"]):
            raise MaintenanceError("SOURCE_EQUALS_TARGET")
        if (target["address"], target["port"]) != (admin["address"], admin["port"]):
            raise MaintenanceError("ADMIN_SERVER_MISMATCH")
        if operation == "refresh_test" and (
                source["encoding"], source["locale_provider"], source["collation"], source["ctype"]
        ) != ("UTF8", "c", "C", "C"):
            raise MaintenanceError("SOURCE_ENCODING_OR_LOCALE_MISMATCH")
        # This root-owned probe must certify isolation of the TEST application, including outbound jobs/email.
        self.run([c["isolation_probe"]], c)
        if operation == "refresh_test" and not c.get("refresh_enabled", False):
            raise MaintenanceError("REFRESH_NOT_COMMISSIONED")
        return {"operation": operation, "identities": identities, "config": c["config_sha256"],
                "files": {k: digest(c[k]) for k in ("overlay_sql", "verify_sql", "isolation_probe", "health_probe")}}

    def preview(self, operation):
        if operation not in OPERATIONS:
            raise MaintenanceError("INVALID_OPERATION")
        body = self.preflight(operation)
        body.update(expires_at=int(time.time()) + 900, nonce=secrets.token_hex(16))
        encoded = json.dumps(body, sort_keys=True)
        sha = hashlib.sha256(encoded.encode()).hexdigest()
        with self.connect() as db:
            db.execute("INSERT INTO plans(hash,body,expires) VALUES(?,?,?)", (sha, encoded, body["expires_at"]))
        return {"ok": True, "plan_sha256": sha, "expires_at": body["expires_at"], "operation": operation,
                "steps": STEPS if operation == "refresh_test" else ["verify source and target", "create and checksum backup"]}

    def start(self, sha, request_id):
        try:
            if str(uuid.UUID(request_id)) != request_id or not re.fullmatch(r"[a-f0-9]{64}", sha):
                raise ValueError()
        except (ValueError, TypeError):
            raise MaintenanceError("INVALID_REQUEST") from None
        # One process/job at a time, including multiple HTTP threads and duplicate starts.
        lock = open(self.root / "maintenance.lock", "a")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock.close()
            with self.connect() as db:
                old = db.execute("SELECT plan_hash FROM jobs WHERE id=?", (request_id,)).fetchone()
            if old and old[0] == sha:
                return self.job(request_id)
            raise MaintenanceError("JOB_BUSY") from None
        try:
            with self.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                old = db.execute("SELECT plan_hash FROM jobs WHERE id=?", (request_id,)).fetchone()
                if old:
                    if old[0] != sha:
                        raise MaintenanceError("REQUEST_ID_REUSED")
                    lock.close()
                    return self.job(request_id)
                if db.execute("SELECT 1 FROM jobs WHERE state='needs_operator'").fetchone():
                    raise MaintenanceError("OPERATOR_RECONCILIATION_REQUIRED")
                row = db.execute("SELECT body,expires,used FROM plans WHERE hash=?", (sha,)).fetchone()
                if not row or row[1] < time.time() or row[2]:
                    raise MaintenanceError("STALE_OR_USED_PLAN")
                plan = json.loads(row[0])
                if self.preflight(plan["operation"]) != {k: v for k, v in plan.items() if k not in ("expires_at", "nonce")}:
                    raise MaintenanceError("PLAN_CHANGED")
                db.execute("UPDATE plans SET used=1 WHERE hash=?", (sha,))
                db.execute("INSERT INTO jobs VALUES(?,?,?,?)", (request_id, sha, "queued", "{}"))
            threading.Thread(target=self.execute, args=(request_id, plan, lock), daemon=False).start()
            return {"ok": True, "job_id": request_id, "status": "queued"}
        except Exception:
            lock.close()
            raise

    def job(self, job_id):
        if not re.fullmatch(r"[a-f0-9-]{36}", job_id):
            raise MaintenanceError("INVALID_JOB")
        with self.connect() as db:
            row = db.execute("SELECT state,result FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            raise MaintenanceError("JOB_NOT_FOUND")
        return {"ok": row[0] == "succeeded", "job_id": job_id, "status": row[0], **json.loads(row[1])}

    def state(self, job, status, **public):
        with self.connect() as db:
            db.execute("UPDATE jobs SET state=?,result=? WHERE id=?", (status, json.dumps(public), job))

    def backup(self, service, job, label):
        path = self.root / (label + "_" + job + ".dump")
        # A new private filename; never overwrite an existing backup.
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        self.run(["/usr/bin/pg_dump", "--no-password", "--format=custom", "--file", str(path),
                  "--dbname", self.conn(service)], self.c, capture=False)
        if path.stat().st_size == 0:
            raise MaintenanceError("EMPTY_BACKUP")
        self.run(["/usr/bin/pg_restore", "--list", str(path)], self.c, capture=False)
        result = {"name": path.name, "sha256": digest(path)}
        (path.with_suffix(".manifest.json")).write_text(json.dumps(result))
        return path, result

    def execute(self, job, plan, lock):
        c = self.c.copy()
        stopped = False
        switched = False
        backups = []
        candidate = c["test_db"] + "_new_" + job.replace("-", "")[:12]
        retained = c["test_db"] + "_old_" + job.replace("-", "")[:12]
        try:
            self.state(job, "running")
            if self.preflight(plan["operation"]) != {k: v for k, v in plan.items() if k not in ("expires_at", "nonce")}:
                raise MaintenanceError("PLAN_CHANGED")
            if plan["operation"] != "refresh_test":
                key = "production_service" if plan["operation"] == "backup_production" else "test_service"
                _, backup = self.backup(c[key], job, plan["operation"])
                self.state(job, "succeeded", backups=[backup])
                return
            # Do not stop the working test application unless candidate restore and SQL checks passed.
            _, old_backup = self.backup(c["test_service"], job, "test_before")
            backups.append(old_backup)
            source, source_backup = self.backup(c["production_service"], job, "production")
            backups.append(source_backup)
            admin = c["admin_service"]
            self.sql(admin, f'CREATE DATABASE "{candidate}" OWNER "{c["test_owner"]}" TEMPLATE template0'
                     " ENCODING 'UTF8' LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C'")
            self.run(["/usr/bin/pg_restore", "--no-password", "--exit-on-error",
                      "--no-owner", "--no-privileges", "--no-subscriptions", "--role", c["test_owner"], "--dbname", self.conn(admin, candidate), str(source)], c, capture=False)
            # Overlay SQL/verification are root-owned installation files, never caller supplied.
            for key in ("overlay_sql", "verify_sql"):
                self.run(["/usr/bin/psql", "-X", "--no-password", "--set=ON_ERROR_STOP=1", "--single-transaction",
                          "--dbname", self.conn(admin, candidate), "--file", c[key]], c, capture=False)
            self.run([c["isolation_probe"]], c)
            # Freeze the final test state for rollback. Only the configured test service is stopped.
            self.run(["/usr/bin/sudo", "-n", "/usr/bin/systemctl", "stop", c["test_unit"]], c, capture=False)
            stopped = True
            self.sql(admin, f'ALTER DATABASE "{c["test_db"]}" ALLOW_CONNECTIONS false')
            self.sql(admin, f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='{c['test_db']}' AND pid<>pg_backend_pid()")
            self.sql(admin, f'ALTER DATABASE "{c["test_db"]}" RENAME TO "{retained}"')
            self.sql(admin, f'ALTER DATABASE "{candidate}" RENAME TO "{c["test_db"]}"')
            switched = True
            self.run(["/usr/bin/sudo", "-n", "/usr/bin/systemctl", "start", c["test_unit"]], c, capture=False)
            self.run([c["health_probe"]], c)
            self.state(job, "succeeded", backups=backups)
        except Exception:
            # After any cutover step fails, retain databases and stop TEST for explicit operator recovery.
            # Never guess at a rename state or restart an unverified database after interruption.
            if stopped or switched:
                try:
                    self.run(["/usr/bin/sudo", "-n", "/usr/bin/systemctl", "stop", c["test_unit"]], c, capture=False)
                except Exception:
                    pass
            self.state(job, "needs_operator" if stopped else "failed", backups=backups,
                       error_code="TEST_RECOVERY_REQUIRED" if stopped else "JOB_FAILED", needs_operator=stopped)
        finally:
            lock.close()


def serve(engine, port):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            status = 200
            value = {"ok": False, "error_code": "REQUEST_REJECTED"}
            try:
                if self.path != "/v1/maintenance" or not hmac.compare_digest(
                        self.headers.get("Authorization", ""), "Bearer " + engine.c["token"]):
                    raise MaintenanceError("UNAUTHORISED")
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 4096:
                    raise MaintenanceError("INVALID_BODY")
                data = json.loads(self.rfile.read(size))
                action = data.get("action")
                allowed = {"status": {"action"}, "preview": {"action", "operation"},
                           "start": {"action", "plan_sha256", "request_id", "confirmation"},
                           "job": {"action", "job_id"}}
                if action not in allowed or set(data) != allowed[action]:
                    raise MaintenanceError("INVALID_REQUEST")
                if action == "status":
                    value = {"ok": True, "status": "available"}
                elif action == "preview":
                    value = engine.preview(data["operation"])
                elif action == "job":
                    value = engine.job(data["job_id"])
                elif data["confirmation"] == "CONFIRM ERP MAINTENANCE PLAN":
                    value = engine.start(data["plan_sha256"], data["request_id"])
                else:
                    raise MaintenanceError("CONFIRMATION_REQUIRED")
            except MaintenanceError as error:
                value = {"ok": False, "error_code": str(error)}
            except Exception:
                status = 400
            payload = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
    # Expose only through a separately authenticated Cloudflare Tunnel/Access application.
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="/etc/blindmotion/erp-maintenance.json")
    parser.add_argument("--port", type=int, default=8789)
    args = parser.parse_args()
    serve(Engine(args.config), args.port)
