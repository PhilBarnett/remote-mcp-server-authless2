import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location("service", Path(__file__).with_name("service.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.root.chmod(0o700)
        self.config_path = self.root / "config.json"
        c = json.loads(Path(__file__).with_name("config.example.json").read_text())
        c.update(state_dir=str(self.root), production_db="production", test_db="testerp", test_owner="testowner", refresh_enabled=True)
        for key in ("pg_service_file", "pgpass_file", "overlay_sql", "verify_sql", "isolation_probe", "health_probe"):
            p = self.root / key
            p.write_text("installed test fixture")
            p.chmod(0o600)
            c[key] = str(p)
        for service in c["identities"]:
            c["identities"][service].update(address="127.0.0.1", port="5432")
        self.c = c
        self.config_path.write_text(json.dumps(c))
        self.config_path.chmod(0o600)
        self.calls = []
        self.fail_at = None
        def run(args, config, **kwargs):
            self.calls.append(args)
            if self.fail_at and any(self.fail_at in x for x in args):
                raise m.MaintenanceError("FAKE_SECRET_DRIVER_ERROR")
            if args[0] == "/usr/bin/pg_dump":
                Path(args[args.index("--file") + 1]).write_bytes(b"fake custom archive")
            if args[0] == "/usr/bin/psql" and "--command" in args:
                sql = args[-1]
                if sql.startswith("SELECT json_build_object"):
                    service = args[args.index("--dbname") + 1].split("=", 1)[1]
                    db = {c["production_service"]: "production", c["test_service"]: "testerp", c["admin_service"]: "postgres"}[service]
                    return json.dumps({"database": db, "address": "127.0.0.1", "port": "5432",
                                       "role": c["identities"][service]["role"], "oid": 100})
            return ""
        self.engine = m.Engine(str(self.config_path), run)

    def tearDown(self):
        self.tmp.cleanup()

    def prepared(self, operation="refresh_test"):
        preview = self.engine.preview(operation)
        with self.engine.connect() as db:
            plan = json.loads(db.execute("SELECT body FROM plans WHERE hash=?", (preview["plan_sha256"],)).fetchone()[0])
        return preview, plan

    def run_job(self, plan):
        job = str(uuid.uuid4())
        with self.engine.connect() as db:
            db.execute("INSERT INTO jobs VALUES(?,?,?,?)", (job, "fixture", "queued", "{}"))
        lock = open(self.root / "fixture.lock", "a")
        self.engine.execute(job, plan, lock)
        return self.engine.job(job)

    def test_preview_performs_no_database_writes(self):
        preview, _ = self.prepared()
        self.assertEqual(preview["operation"], "refresh_test")
        self.assertEqual(len(preview["plan_sha256"]), 64)
        self.assertFalse(any("CREATE DATABASE" in " ".join(args) for args in self.calls))

    def test_refresh_restores_candidate_before_stopping_test_and_never_writes_source(self):
        _, plan = self.prepared()
        result = self.run_job(plan)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(len(result["backups"]), 2)
        restore = next(i for i, args in enumerate(self.calls) if args[0] == "/usr/bin/pg_restore" and "--dbname" in args)
        stop = next(i for i, args in enumerate(self.calls) if "stop" in args)
        self.assertLess(restore, stop)
        for args in self.calls:
            if args[0] == "/usr/bin/psql" and any("CREATE DATABASE" in x or "ALTER DATABASE" in x for x in args):
                self.assertIn("service=" + self.c["admin_service"], args)
                self.assertNotIn('"production"', args[-1])
        self.assertFalse(any("DROP DATABASE" in " ".join(args) for args in self.calls))

    def test_restore_failure_leaves_test_running(self):
        _, plan = self.prepared()
        self.fail_at = "--exit-on-error"
        result = self.run_job(plan)
        self.assertEqual(result["status"], "failed")
        self.assertFalse(any("stop" in args for args in self.calls))
        self.assertNotIn("FAKE_SECRET", json.dumps(result))

    def test_cutover_failure_stops_test_and_requires_operator(self):
        _, plan = self.prepared()
        self.fail_at = 'RENAME TO'
        result = self.run_job(plan)
        self.assertEqual(result["status"], "needs_operator")
        self.assertTrue(result["needs_operator"])
        self.assertFalse(any("start" in args for args in self.calls))
        self.assertEqual(self.calls[-1][-2:], ["stop", self.c["test_unit"]])

    def test_changed_overlay_invalidates_plan_before_backups(self):
        preview, _ = self.prepared()
        Path(self.c["overlay_sql"]).write_text("changed")
        with self.assertRaisesRegex(m.MaintenanceError, "PLAN_CHANGED"):
            self.engine.start(preview["plan_sha256"], str(uuid.uuid4()))
        self.assertFalse(any(args[0] == "/usr/bin/pg_dump" for args in self.calls))

    def test_duplicate_start_returns_same_job_and_plan_cannot_be_replayed(self):
        preview, _ = self.prepared("backup_test")
        job = str(uuid.uuid4())
        def fake_start(thread):
            thread._args[2].close()
        with patch.object(m.threading.Thread, "start", fake_start):
            self.engine.start(preview["plan_sha256"], job)
        repeat = self.engine.start(preview["plan_sha256"], job)
        self.assertEqual(repeat["job_id"], job)
        with self.assertRaisesRegex(m.MaintenanceError, "STALE_OR_USED_PLAN"):
            self.engine.start(preview["plan_sha256"], str(uuid.uuid4()))

    def test_restart_blocks_new_jobs_pending_reconciliation(self):
        with self.engine.connect() as db:
            db.execute("INSERT INTO jobs VALUES(?,?,?,?)", (str(uuid.uuid4()), "previous", "running", "{}"))
        engine = m.Engine(str(self.config_path), self.engine.run)
        preview = engine.preview("backup_test")
        with self.assertRaisesRegex(m.MaintenanceError, "OPERATOR_RECONCILIATION"):
            engine.start(preview["plan_sha256"], str(uuid.uuid4()))

    def test_expired_plan_rejected(self):
        preview, _ = self.prepared()
        with self.engine.connect() as db:
            db.execute("UPDATE plans SET expires=?", (int(time.time()) - 1,))
        with self.assertRaisesRegex(m.MaintenanceError, "STALE_OR_USED_PLAN"):
            self.engine.start(preview["plan_sha256"], str(uuid.uuid4()))

    def test_target_and_configuration_guards(self):
        for change in ({"test_db": "production"}, {"test_db": "erp"}, {"test_unit": "idempiere.service"},
                       {"production_db": "prod;drop"}, {"production_service": self.c["test_service"]}):
            with self.subTest(change=change):
                self.config_path.write_text(json.dumps({**self.c, **change}))
                with self.assertRaises(m.MaintenanceError):
                    m.load_config(self.config_path)


if __name__ == "__main__":
    unittest.main()
