# ERP operations service

This is a prepared implementation, not an installed service. No database was backed up,
restored or modified during development. Production writes are not implemented.

## Architecture and trust boundaries

The existing owner-authenticated Cloudflare MCP calls a dedicated HTTPS Cloudflare
Tunnel hostname protected by a Cloudflare Access service-token policy. The local
Python 3 service listens only on 127.0.0.1:8789 and additionally verifies a random
bearer token. It accepts four strict request shapes: status, preview, start and job.
There is no remote shell, arbitrary SQL, download endpoint or caller-selected target.
Credentials, configuration, SQL and executables stay on the ERP server.

Three separate PostgreSQL services are required: production backup reader, test backup
reader and test administrator. The source account must have sufficient SELECT rights
for a complete pg_dump, including large objects if present, and no production write or
administration rights. The test administrator needs CREATEDB and membership in the
test owner role and must own the test database. It must not own or administer the
production database. Do not reuse the production application owner/superuser. Review
effective PUBLIC grants and connection privileges before commissioning.

This implementation restores using --no-owner and --no-privileges, assigning restored
objects to the configured TEST owner. Re-establish required TEST-only grants in the
overlay. Roles/tablespaces, application binaries, plugins, attachments and filesystem
configuration are not copied by pg_dump. Match the test application/bundle version to
production and inventory external assets separately. Dumps are stored locally; provide
encrypted disks/storage, an off-host backup copy and a retention policy independently.

## Installation (requires server administrator access)

1. Independently identify production/test DB names, server addresses/ports and database
   roles, the TEST systemd unit and its JDBC settings. Keep production and TEST services
   distinct. Verify supported PostgreSQL client/server versions, disk space, locale,
   extensions and restore permissions. The supplied commands use /usr/bin PostgreSQL
   binaries; install/select the matching version before enabling the service.
2. Install on the TEST application VM, where systemctl controls only its local unit.
   Record its exact hostname and the output of `sha256sum /etc/machine-id` in
   test_hostname and test_machine_sha256. The service verifies both on startup
   and preflight. Verify that the production VM has a distinct machine ID.
   Create a dedicated Linux user/group `blindmotion-erp-ops`. Install service.py as
   root-owned, non-writable by this user under /opt/blindmotion-erp-ops. Install the
   systemd unit. Create /etc/blindmotion with root ownership and restricted access.
3. Populate config.example.json as /etc/blindmotion/erp-maintenance.json, root-owned
   0640, group blindmotion-erp-ops. Generate a random token (at least 32 random bytes).
   Populate identities with independently observed values, not guessed IP addresses.
   Keep refresh_enabled=false until local acceptance passes.
4. Create three libpq service entries in a root-owned 0640 file with the service
   group. Install the pgpass file as the service user with mode 0600 in the
   root-controlled configuration directory. Pin host, port, dbname, user and verify-full TLS/CA for remote
   connections. For local Unix sockets, use explicitly configured peer authentication.
   No password appears in subprocess arguments, API requests or API results.
5. Replace the fail-closed overlay/verification examples with reviewed SQL for the
   ACTUAL schema. Restore into a disposable candidate manually and prove staging
   connection, disabled mail and all outbound schedulers/integrations. Root-owned
   isolation and health probes must exit nonzero on failure and print no secrets.
   Isolation must be verified independently of SQL: prevent a cloned database or
   scheduler from reaching live integrations. The health probe must wait/retry for
   test application readiness and prove it uses the intended database/staging source.
6. Permit ONLY these exact commands through sudoers (adjust the verified TEST unit
   in both config and sudoers). Do not grant wildcard shell or systemctl access:

   ```sudoers
   blindmotion-erp-ops ALL=(root) NOPASSWD: /usr/bin/systemctl stop idempiere.service, /usr/bin/systemctl start idempiere.service
   ```

7. Route the dedicated Cloudflare Tunnel hostname to 127.0.0.1:8789; configure an
   Access service-token policy before publishing the route. No port 8789 or database
   port needs public exposure. Configure the Worker secrets ERP_MAINTENANCE_URL
   (HTTPS origin ending /), ERP_MAINTENANCE_TOKEN, ERP_MAINTENANCE_ACCESS_CLIENT_ID
   and ERP_MAINTENANCE_ACCESS_CLIENT_SECRET. Leave ERP_MAINTENANCE_ENABLED unset
   until local/remote acceptance. The reader's separate existing credentials stay unchanged.
8. Start the API and test status, unauthorised requests, backup previews/starts and
   retained dump hashes. Prove a restore into a disposable database. Then set
   refresh_enabled=true, restart the API, and enable the Worker flag. Preview refresh,
   inspect its concrete plan and run it with its hash and a single UUID request ID.

## Refresh and recovery

Plans expire after 15 minutes and bind server/database identities, DB OIDs, config and
overlay/probe hashes. A single-use plan plus unique request ID makes retries safe.
Poll the same job after timeouts; do not invent a new start request to retry blindly.
SQLite retains jobs/plans and a cross-process lock prevents overlapping jobs.

The service dumps test and production in custom format, checks archive listings and
SHA-256, creates an isolated candidate, restores with exit-on-error, applies TEST settings
and asserts them before stopping TEST. It blocks old test connections, terminates only
sessions for that test name, renames old test to test*_old_<job> and candidate to the
configured test name, then starts TEST and runs its health probe. Production is only
used through the backup-reader connection. No database is dropped by this service.

A failed cutover leaves TEST stopped and marks needs_operator. A restart marks any
unfinished job needs_operator and blocks new jobs. It does not guess whether to repeat
database renames. An administrator must inspect pg_database and the recorded job:
retain a failed candidate under another TEST name, rename the retained old TEST back,
set ALLOW_CONNECTIONS true, verify original TEST settings/isolation, then start TEST.
After reconciling the exact state, mark that job reconciled in the local SQLite store
under administrator control. No remote API can clear this guard. A failed pre-cutover
job leaves the working test database intact; retain/clean its candidate manually.

Backups carry file hashes/listability checks; only a successful candidate restore
proves the production archive restored. Standalone backups still need regular restore
drills. The pre-refresh test dump is taken while TEST runs; the old database retained
at cutover is the most recent rollback state. Do not delete either until accepted.

## Developer validation

`python3 -m unittest discover -s ops/erp-maintenance -p 'test_*.py'`

`npm run test:idempiere-db`

Tests use fake subprocess/database transports, never a live ERP. A real disposable
PostgreSQL restore, role checks, SQL overlay, systemd/Tunnel installation and final
end-to-end acceptance remain required on the server.
