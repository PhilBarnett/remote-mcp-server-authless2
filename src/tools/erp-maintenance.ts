import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const jobId = z.string().uuid();
export const erpMaintenanceSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("status") }).strict(),
	z.object({ action: z.literal("preview"), operation: z.enum(["backup_production", "backup_test", "refresh_test"]) }).strict(),
	z.object({ action: z.literal("start"), plan_sha256: hash, request_id: jobId,
		confirmation: z.literal("CONFIRM ERP MAINTENANCE PLAN") }).strict(),
	z.object({ action: z.literal("job"), job_id: jobId }).strict(),
]);
export type MaintenanceEnv = {
	ERP_MAINTENANCE_ENABLED?: string;
	ERP_MAINTENANCE_URL?: string;
	ERP_MAINTENANCE_TOKEN?: string;
	ERP_MAINTENANCE_ACCESS_CLIENT_ID?: string;
	ERP_MAINTENANCE_ACCESS_CLIENT_SECRET?: string;
};

export async function manageErpMaintenance(raw: unknown, env: MaintenanceEnv, transport: typeof fetch = fetch) {
	const input = erpMaintenanceSchema.parse(raw);
	if (env.ERP_MAINTENANCE_ENABLED !== "true") throw new Error("ERP maintenance is disabled; server installation and configuration are required.");
	let base: URL;
	try { base = new URL(env.ERP_MAINTENANCE_URL || ""); }
	catch { throw new Error("ERP maintenance endpoint is not configured."); }
	if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/")
		throw new Error("ERP maintenance requires an HTTPS origin without credentials or a path.");
	if (!env.ERP_MAINTENANCE_TOKEN || env.ERP_MAINTENANCE_TOKEN.length < 43 ||
		!env.ERP_MAINTENANCE_ACCESS_CLIENT_ID || !env.ERP_MAINTENANCE_ACCESS_CLIENT_SECRET)
		throw new Error("ERP maintenance authentication is not configured.");
	try {
		const response = await transport(new URL("v1/maintenance", base), {
			method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.ERP_MAINTENANCE_TOKEN}`,
				"CF-Access-Client-Id": env.ERP_MAINTENANCE_ACCESS_CLIENT_ID,
				"CF-Access-Client-Secret": env.ERP_MAINTENANCE_ACCESS_CLIENT_SECRET },
			body: JSON.stringify(input),
		});
		if (!response.ok) throw new Error("upstream");
		// Never relay server logs, credentials or dump bytes. Only this bounded public envelope.
		if (!response.body) throw new Error("empty");
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let value = "", bytes = 0;
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				bytes += chunk.value.byteLength;
				if (bytes > 32768) { await reader.cancel(); throw new Error("oversized"); }
				value += decoder.decode(chunk.value, { stream: true });
			}
			value += decoder.decode();
		} finally { reader.releaseLock(); }
		const safe = z.object({
			ok: z.boolean(), status: z.string().max(64).optional(),
			job_id: jobId.optional(), plan_sha256: hash.optional(),
			operation: z.enum(["backup_production", "backup_test", "refresh_test"]).optional(),
			expires_at: z.number().int().optional(),
			steps: z.array(z.string().max(100)).max(20).optional(),
			backups: z.array(z.object({ name: z.string().regex(/^[a-z0-9_.-]{1,120}$/), sha256: hash })).max(4).optional(),
			error_code: z.string().regex(/^[A-Z_]{1,80}$/).optional(),
			needs_operator: z.boolean().optional(),
		}).strict().parse(JSON.parse(value));
		return safe;
	} catch {
		throw new Error("ERP maintenance request failed. Check the server audit log; do not retry a start with a new request ID until its job status is known.");
	}
}
