# iDempiere direct database reader

`read_idempiere_database` extends the existing authenticated MCP with direct PostgreSQL reads. It is disabled unless explicitly configured. No database credentials, role creation, network changes or database migrations are performed by the tool. No live database has been tested during implementation.

## Scope

Actions: `status`, `columns`, `indexes`, `triggers`, `rows`, `count`. All except status require table: `scans`, `scanpoints`, `production`, `items`, `cuts`. There is no caller-supplied SQL, table name, schema, hostname or credentials. Row/count queries enforce one configured business client and explicit organisation IDs. System-client reads are refused. Schema/index/trigger metadata is scoped to the five named tables, not to row tenants.

Rows use an explicit production-related column projection (no customer records, descriptions, accounting tables or binary payloads), max 50 rows, 512 characters per field, and 128 KB per response. Values are text, including booleans/dates. Missing optional columns are reported; absent ID/client/org columns block row reads. Rows sort by primary ID descending; pass returned `next_before_id` as `before_id` for the next page. This ordering is by ID, not claimed to be by event time. Counts have an 8-second server timeout and can fail for large tables.

Each request uses a fresh connection, a `READ ONLY` transaction, server statement/lock limits, a client query timeout, role verification and rollback/close in `finally`. Raw driver errors are never returned. Never use document completion flags as evidence of a physical scan. This reader cannot provide the installed OSGi binary version: obtain it from the server's bundle inventory separately.

## Deployment prerequisites (administrator)

1. Identify the actual PostgreSQL database, schema, business `AD_Client_ID`, and authorised `AD_Org_ID`s. Do not infer these IDs from examples below or use the System tenant. Check whether a replica is available for reads.
2. Create a dedicated role using an administrator's secure PostgreSQL session, e.g.:

```sql
CREATE ROLE blindmotion_mcp_reader LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3;
ALTER ROLE blindmotion_mcp_reader SET default_transaction_read_only = on;
ALTER ROLE blindmotion_mcp_reader SET statement_timeout = '8s';
ALTER ROLE blindmotion_mcp_reader SET lock_timeout = '1s';
```

Set a unique password through a secure prompt such as psql `\password blindmotion_mcp_reader`; never commit it or paste it in chat. The role must not own database objects, inherit privileges or belong to other roles. Do not reuse the iDempiere application/database-owner account. Confirm public grants do not confer writes, object creation, or execution of unsafe custom functions. Do not alter shared PUBLIC grants without impact review.

Grant `CONNECT` on the actual database and `USAGE` on its actual application schema to this role. Grant SELECT only on the five audit tables:

```sql
-- Replace schema/database identifiers with the independently verified names.
-- Example below uses the conventional schema, not a discovered live value.
GRANT USAGE ON SCHEMA adempiere TO blindmotion_mcp_reader;
GRANT SELECT ON adempiere.bld_mtm_scan, adempiere.bld_mtm_scanpoint,
  adempiere.bld_mtom_production, adempiere.bld_mtom_item_line,
  adempiere.bld_mtom_cuts TO blindmotion_mcp_reader;
```

Table grants are a database ceiling; the MCP additionally enforces column and tenant/org restrictions. For stronger isolation on a shared multi-tenant database, provision a reporting database or enforce suitable row policies for this role before enabling it. Review all existing grants and object ownership. Do not grant SELECT on all tables, future tables or any write privileges.

3. Provide an approved network route from the Worker to PostgreSQL, with certificate verification and a certificate hostname matching the connection hostname. Do not expose port 5432 to the entire internet or disable certificate validation. Private origin reachability is an infrastructure prerequisite, not solved by this code. If using Workers VPC/Hyperdrive instead, implement and test that binding explicitly; this version uses a direct TLS connection with `pg`, not a Hyperdrive binding.
4. Add Worker secrets using Cloudflare's secure dashboard or `wrangler secret put` prompts:
   - `IDEMPIERE_DB_URL`: `postgresql://blindmotion_mcp_reader:<encoded-password>@<verified-db-host>:5432/<database>`. No query parameters. URL-encode the password. It must be a PostgreSQL endpoint, not the ERP web URL.
   - `IDEMPIERE_DB_CA`: optional PEM CA certificate for a private CA; certificate verification stays enabled.
   - `IDEMPIERE_DB_CLIENT_ID`: verified business tenant ID.
   - `IDEMPIERE_DB_ORG_IDS`: comma-separated explicitly authorised org IDs. Include `0` only if needed for shared records within that business tenant.
   - `IDEMPIERE_DB_SCHEMA`: actual schema, defaults to `adempiere`.
   - `IDEMPIERE_DB_ENABLED`: set to `true` only after prerequisites are complete.

No credentials or environment values belong in repository files. The existing MCP OAuth/owner authentication remains required. Deployment alone must leave the database reader disabled while credentials/network are absent. Confirm who has access to the existing connector before enabling this additional data source.

## Verification and rollback

Run `npm run test:idempiere-db`, `npm run type-check`, and `npx wrangler deploy --dry-run`. Unit tests use a mock transport and cannot certify live TLS, ACLs, schema or networking.

After approved deployment/configuration, call `status`, then `columns` for each table. Read two scoped scanpoint/scan rows and inspect `indexes`/`triggers`; test that out-of-scope record IDs return no rows. Verify rejected writes using a separate controlled administrator test of the reader account, not by introducing a write tool. Do not process production documents or inventory as a connection test. Confirm returned timestamps' database timezone before building dashboard aggregation.

To disable reads, remove/set `IDEMPIERE_DB_ENABLED=false`. To revoke access, an administrator can disable the dedicated LOGIN, terminate its sessions if needed, and revoke its grants. Revert the code PR independently. No production records need restoration because the reader performs no writes.
