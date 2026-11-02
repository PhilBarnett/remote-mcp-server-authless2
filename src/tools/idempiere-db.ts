import { z } from "zod";
import pg from "pg";

// This is a named-query reader, not a SQL console. Identifiers never come from callers.
export const TABLES = {
	scans: {
		name: "bld_mtm_scan",
		key: "bld_mtm_scan_id",
		columns: [
			"bld_mtm_scan_id",
			"ad_client_id",
			"ad_org_id",
			"created",
			"updated",
			"isactive",
			"barcode",
			"bld_mtm_scanpoint_id",
			"ad_user_id",
			"m_locator_id",
			"processed",
		],
	},
	scanpoints: {
		name: "bld_mtm_scanpoint",
		key: "bld_mtm_scanpoint_id",
		columns: [
			"bld_mtm_scanpoint_id",
			"ad_client_id",
			"ad_org_id",
			"created",
			"updated",
			"isactive",
			"name",
			"bld_scanpoint_type_id",
			"m_locator_id",
			"isendpoint",
		],
	},
	production: {
		name: "bld_mtom_production",
		key: "bld_mtom_production_id",
		columns: [
			"bld_mtom_production_id",
			"ad_client_id",
			"ad_org_id",
			"documentno",
			"created",
			"updated",
			"docstatus",
			"processed",
			"posted",
			"iscomplete",
			"movementdate",
			"datepromised",
			"c_order_id",
		],
	},
	items: {
		name: "bld_mtom_item_line",
		key: "bld_mtom_item_line_id",
		columns: [
			"bld_mtom_item_line_id",
			"ad_client_id",
			"ad_org_id",
			"created",
			"updated",
			"bld_mtom_production_id",
			"c_orderline_id",
			"m_product_id",
			"barcode",
			"iscomplete",
			"completed",
			"isprocessed",
			"isrework",
		],
	},
	cuts: {
		name: "bld_mtom_cuts",
		key: "bld_mtom_cuts_id",
		columns: [
			"bld_mtom_cuts_id",
			"ad_client_id",
			"ad_org_id",
			"created",
			"updated",
			"bld_mtom_item_line_id",
			"m_product_id",
			"barcode",
			"isactive",
		],
	},
} as const;

export const idempiereDbSchema = z
	.object({
		action: z.enum(["status", "columns", "indexes", "triggers", "rows", "count"]),
		table: z.enum(["scans", "scanpoints", "production", "items", "cuts"]).optional(),
		limit: z.number().int().min(1).max(50).default(20),
		before_id: z.number().int().positive().max(2147483647).optional(),
		record_id: z.number().int().positive().max(2147483647).optional(),
	})
	.strict()
	.superRefine((v, ctx) => {
		if (v.action !== "status" && !v.table)
			ctx.addIssue({ code: "custom", message: "table is required" });
		if (v.action !== "rows" && (v.before_id || v.record_id))
			ctx.addIssue({ code: "custom", message: "ID filters require rows" });
		if (v.before_id && v.record_id)
			ctx.addIssue({ code: "custom", message: "Use one ID filter" });
	});

export type DbEnv = {
	IDEMPIERE_DB_ENABLED?: string;
	IDEMPIERE_DB_URL?: string;
	IDEMPIERE_DB_CA?: string;
	IDEMPIERE_DB_SCHEMA?: string;
	IDEMPIERE_DB_CLIENT_ID?: string;
	IDEMPIERE_DB_ORG_IDS?: string;
};
type Row = Record<string, unknown>;
export type DbClient = {
	connect(): Promise<unknown>;
	query(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
	end(): Promise<unknown>;
};
export class DbReadError extends Error {}
const identifier = /^[a-z_][a-z0-9_]{0,62}$/;
const quote = (name: string) => {
	if (!identifier.test(name)) throw new DbReadError("Invalid database identifier.");
	return `"${name}"`;
};

export function dbConfig(env: DbEnv) {
	if (env.IDEMPIERE_DB_ENABLED !== "true")
		throw new DbReadError(
			"iDempiere database reader is disabled. Deployment and restricted credentials are required.",
		);
	const schema = env.IDEMPIERE_DB_SCHEMA || "adempiere";
	if (!identifier.test(schema)) throw new DbReadError("Invalid configured database schema.");
	const positive = (s: string) => /^[1-9][0-9]{0,9}$/.test(s) && Number(s) <= 2147483647;
	const orgText = env.IDEMPIERE_DB_ORG_IDS?.split(",").map((s) => s.trim()) ?? [];
	if (
		!positive(env.IDEMPIERE_DB_CLIENT_ID || "") ||
		!orgText.length ||
		orgText.length > 20 ||
		orgText.some((s) => s !== "0" && !positive(s))
	)
		throw new DbReadError("An explicit business client and organisation scope is required.");
	let url: URL;
	try {
		url = new URL(env.IDEMPIERE_DB_URL || "");
	} catch {
		throw new DbReadError("Database connection secret is missing or invalid.");
	}
	if (
		!["postgres:", "postgresql:"].includes(url.protocol) ||
		!url.hostname ||
		!url.password ||
		decodeURIComponent(url.username) !== "blindmotion_mcp_reader" ||
		!/^\/[A-Za-z0-9_-]+$/.test(url.pathname) ||
		url.search ||
		url.hash
	)
		throw new DbReadError(
			"Use a restricted database URL without query parameters; TLS is enforced separately.",
		);
	return {
		schema,
		clientId: Number(env.IDEMPIERE_DB_CLIENT_ID),
		orgIds: orgText.map(Number),
		connection: {
			host: url.hostname,
			port: Number(url.port || 5432),
			database: url.pathname.slice(1),
			user: "blindmotion_mcp_reader",
			password: decodeURIComponent(url.password),
			ssl: {
				rejectUnauthorized: true,
				...(env.IDEMPIERE_DB_CA ? { ca: env.IDEMPIERE_DB_CA } : {}),
			},
			application_name: "blindmotion-mcp-readonly",
			connectionTimeoutMillis: 5000,
			query_timeout: 10000,
			statement_timeout: 8000,
			lock_timeout: 1000,
			options: "-c default_transaction_read_only=on -c search_path=pg_catalog",
		},
	};
}

export function rowQuery(
	input: z.infer<typeof idempiereDbSchema>,
	config: ReturnType<typeof dbConfig>,
	available: string[],
) {
	const table = TABLES[input.table!];
	if (![table.key, "ad_client_id", "ad_org_id"].every((c) => available.includes(c)))
		throw new DbReadError("Required identity/scope columns are absent. No rows read.");
	const columns = table.columns.filter((c) => available.includes(c));
	const values: unknown[] = [config.clientId, config.orgIds];
	let where = `ad_client_id = $1 AND ad_org_id = ANY($2::integer[])`;
	if (input.record_id) {
		values.push(input.record_id);
		where += ` AND ${quote(table.key)} = $3`;
	}
	if (input.before_id) {
		values.push(input.before_id);
		where += ` AND ${quote(table.key)} < $3`;
	}
	const target = `${quote(config.schema)}.${quote(table.name)}`;
	if (input.action === "count")
		return { text: `SELECT count(*)::text AS count FROM ${target} WHERE ${where}`, values };
	values.push(input.limit + 1);
	// Bound string values in SQL as well as bounding the returned JSON. No descriptions, customer details or blobs.
	const selection = columns.map((c) => `left(${quote(c)}::text, 512) AS ${quote(c)}`).join(", ");
	return {
		text: `SELECT ${selection} FROM ${target} WHERE ${where} ORDER BY ${quote(table.key)} DESC LIMIT $${values.length}`,
		values,
	};
}

export async function readIdempiereDb(
	raw: unknown,
	env: DbEnv,
	factory: (config: ReturnType<typeof dbConfig>["connection"]) => DbClient = (c) =>
		new pg.Client(c) as unknown as DbClient,
) {
	const input = idempiereDbSchema.parse(raw);
	const config = dbConfig(env);
	const client = factory(config.connection);
	let begun = false;
	try {
		await client.connect();
		await client.query("BEGIN TRANSACTION READ ONLY");
		begun = true;
		await client.query("SET LOCAL statement_timeout = '8s'");
		await client.query("SET LOCAL lock_timeout = '1s'");
		const status = (
			await client.query(`SELECT current_user AS role, current_setting('transaction_read_only') AS read_only,
      r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls, r.rolinherit,
      EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS has_memberships
      FROM pg_roles r WHERE r.rolname = current_user`)
		).rows[0];
		if (
			!status ||
			status.role !== "blindmotion_mcp_reader" ||
			status.read_only !== "on" ||
			[
				"rolsuper",
				"rolcreaterole",
				"rolcreatedb",
				"rolreplication",
				"rolbypassrls",
				"rolinherit",
				"has_memberships",
			].some((k) => status[k] !== false)
		)
			throw new DbReadError(
				"Database role does not meet the restricted reader requirements.",
			);
		let result: Record<string, unknown>;
		if (input.action === "status") {
			result = {
				connected: true,
				read_only: true,
				role: status.role,
				client_id: config.clientId,
				organisation_ids: config.orgIds,
				schema: config.schema,
				tables: Object.keys(TABLES),
			};
		} else {
			const table = TABLES[input.table!];
			const params = [config.schema, table.name];
			const columns = (
				await client.query(
					`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position LIMIT 200`,
					params,
				)
			).rows;
			if (!columns.length)
				throw new DbReadError("Table is absent or not visible to the reader.");
			const available = columns.map((c) => String(c.column_name));
			let rows: Row[],
				next: number | null = null;
			if (input.action === "columns") rows = columns;
			else if (input.action === "indexes")
				rows = (
					await client.query(
						"SELECT indexname, left(indexdef, 2048) AS definition FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname LIMIT 100",
						params,
					)
				).rows;
			else if (input.action === "triggers")
				rows = (
					await client.query(
						`SELECT t.tgname AS name, left(pg_get_triggerdef(t.oid), 2048) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND NOT t.tgisinternal ORDER BY t.tgname LIMIT 100`,
						params,
					)
				).rows;
			else {
				const query = rowQuery(input, config, available);
				rows = (await client.query(query.text, query.values)).rows;
				if (input.action === "rows" && rows.length > input.limit) {
					rows = rows.slice(0, input.limit);
					next = Number(rows[rows.length - 1][table.key]);
				}
			}
			result = {
				action: input.action,
				table: input.table,
				read_only: true,
				client_id: config.clientId,
				organisation_ids: config.orgIds,
				rows,
				next_before_id: next,
				...(input.action === "rows"
					? {
							omitted_columns: table.columns.filter((c) => !available.includes(c)),
							values_are_text: true,
							field_character_limit: 512,
						}
					: {}),
			};
		}
		if (new TextEncoder().encode(JSON.stringify(result)).length > 128000)
			throw new DbReadError("Result exceeds response limit. Reduce the page size.");
		return result;
	} catch (e) {
		// Never return driver messages: they can include hosts, SQL, rows or credentials.
		if (e instanceof DbReadError) throw e;
		throw new DbReadError(
			"iDempiere database read failed. Check connectivity, certificate trust, reader grants and timeouts. No database write was requested.",
		);
	} finally {
		if (begun) {
			try {
				await client.query("ROLLBACK");
			} catch {
				/* close discards transaction */
			}
		}
		try {
			await client.end();
		} catch {
			/* never expose driver details */
		}
	}
}
