import test from "node:test";
import assert from "node:assert/strict";
import {
	dbConfig,
	idempiereDbSchema,
	rowQuery,
	readIdempiereDb,
	TABLES,
} from "../src/tools/idempiere-db.ts";

const env = {
	IDEMPIERE_DB_ENABLED: "true",
	IDEMPIERE_DB_URL: "postgres://blindmotion_mcp_reader:test-only@db.example.test/erp",
	IDEMPIERE_DB_CLIENT_ID: "1000000",
	IDEMPIERE_DB_ORG_IDS: "0,1000001",
};
const status = {
	role: "blindmotion_mcp_reader",
	read_only: "on",
	rolsuper: false,
	rolcreaterole: false,
	rolcreatedb: false,
	rolreplication: false,
	rolbypassrls: false,
	rolinherit: false,
	has_memberships: false,
};
function mock({ role = status, fail = false, data = [] } = {}) {
	const calls = [];
	let closed = false;
	return {
		calls,
		get closed() {
			return closed;
		},
		connect: async () => {},
		end: async () => {
			closed = true;
		},
		query: async (text, values) => {
			calls.push({ text, values });
			if (text.includes("current_user AS role")) return { rows: [role] };
			if (text.includes("information_schema.columns"))
				return { rows: TABLES.scans.columns.map((column_name) => ({ column_name })) };
			if (text.startsWith("SELECT left(")) {
				if (fail) throw Error("secret password and private database details");
				return { rows: data };
			}
			return { rows: [] };
		},
	};
}
test("disabled and unsafe configurations fail before any connection", async () => {
	let called = false;
	await assert.rejects(
		readIdempiereDb({ action: "status" }, {}, () => {
			called = true;
		}),
		/disabled/,
	);
	assert.equal(called, false);
	for (const patch of [
		{ IDEMPIERE_DB_CLIENT_ID: "0" },
		{ IDEMPIERE_DB_ORG_IDS: "" },
		{ IDEMPIERE_DB_URL: env.IDEMPIERE_DB_URL + "?sslmode=disable" },
		{ IDEMPIERE_DB_URL: env.IDEMPIERE_DB_URL.replace("blindmotion_mcp_reader", "postgres") },
		{ IDEMPIERE_DB_SCHEMA: "public;drop table x" },
	])
		assert.throws(() => dbConfig({ ...env, ...patch }));
	assert.equal(dbConfig(env).connection.ssl.rejectUnauthorized, true);
});
test("no raw SQL or caller identifiers; strict bounded arguments", () => {
	for (const input of [
		{ action: "sql", sql: "select 1" },
		{ action: "rows", table: "pg_authid" },
		{ action: "rows", table: "scans", limit: 51 },
		{ action: "count", table: "items", record_id: 1 },
		{ action: "columns" },
		{ action: "rows", table: "scans", before_id: 1, record_id: 2 },
		{ action: "status", sql: "delete" },
	])
		assert.equal(idempiereDbSchema.safeParse(input).success, false);
});
test("query always scopes tenant/org and parameterises IDs and limit", () => {
	const input = idempiereDbSchema.parse({
		action: "rows",
		table: "scans",
		record_id: 10,
		limit: 5,
	});
	const q = rowQuery(input, dbConfig(env), [...TABLES.scans.columns]);
	assert.match(q.text, /ad_client_id = \$1 AND ad_org_id = ANY\(\$2::integer\[\]\)/);
	assert.match(q.text, /"bld_mtm_scan_id" = \$3/);
	assert.match(q.text, /LIMIT \$4/);
	assert.deepEqual(q.values, [1000000, [0, 1000001], 10, 6]);
	assert.doesNotMatch(q.text, /SELECT \*/);
	assert.throws(() => rowQuery(input, dbConfig(env), ["barcode"]), /scope columns/);
});
test("role guard rejects elevated or inherited access and rolls back", async () => {
	for (const patch of [
		{ rolsuper: true },
		{ rolinherit: true },
		{ has_memberships: true },
		{ rolbypassrls: true },
		{ read_only: "off" },
		{ role: "adempiere" },
	]) {
		const client = mock({ role: { ...status, ...patch } });
		await assert.rejects(
			readIdempiereDb({ action: "status" }, env, () => client),
			/restricted reader/,
		);
		assert.equal(client.calls.at(-1).text, "ROLLBACK");
		assert.equal(client.closed, true);
	}
});
test("successful read uses read-only transaction and keyset pagination", async () => {
	const client = mock({
		data: [{ bld_mtm_scan_id: "7" }, { bld_mtm_scan_id: "6" }, { bld_mtm_scan_id: "5" }],
	});
	const result = await readIdempiereDb(
		{ action: "rows", table: "scans", limit: 2 },
		env,
		() => client,
	);
	assert.equal(result.rows.length, 2);
	assert.equal(result.next_before_id, 6);
	assert.equal(client.calls[0].text, "BEGIN TRANSACTION READ ONLY");
	assert.equal(client.calls.at(-1).text, "ROLLBACK");
	assert.equal(client.closed, true);
});
test("driver errors are redacted and connection closed", async () => {
	const client = mock({ fail: true });
	await assert.rejects(
		readIdempiereDb({ action: "rows", table: "scans" }, env, () => client),
		(e) => !e.message.includes("secret password") && e.message.includes("read failed"),
	);
	assert.equal(client.calls.at(-1).text, "ROLLBACK");
	assert.equal(client.closed, true);
});
test("metadata queries bind schema/table; count is tenant scoped", async () => {
	for (const action of ["columns", "indexes", "triggers", "count"]) {
		const client = mock();
		await readIdempiereDb({ action, table: "scans" }, env, () => client);
		const query = client.calls.at(-2);
		if (action === "count") {
			assert.match(query.text, /ad_client_id = \$1/);
			assert.deepEqual(query.values, [1000000, [0, 1000001]]);
		} else assert.deepEqual(query.values, ["adempiere", "bld_mtm_scan"]);
		assert.equal(client.closed, true);
	}
});
