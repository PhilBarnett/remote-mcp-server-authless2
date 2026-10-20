import { z } from "zod";

const CONFIRMATION = "CONFIRM META ACCOUNT SPEND LIMIT CHANGE";
const TTL = 15 * 60 * 1000;
const enc = new TextEncoder();
const money = z
	.number()
	.finite()
	.positive()
	.max(1_000_000)
	.refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 0.000001, "Use whole cents.");
export const metaSpendLimitSchema = z.discriminatedUnion("mode", [
	z.object({ mode: z.literal("read") }).strict(),
	z
		.object({
			mode: z.literal("preview"),
			expected_account_name: z.string().min(1),
			new_limit_aud: money,
		})
		.strict(),
	z
		.object({
			mode: z.literal("apply"),
			expected_account_name: z.string().min(1),
			new_limit_aud: money,
			preview_token: z.string().max(6000),
			confirmation: z.literal(CONFIRMATION),
		})
		.strict(),
]);
type Deps = {
	getConfig: () => { adAccountId: string; accessToken: string };
	get: (path: string, params: Record<string, string>) => Promise<any>;
	post: (path: string, params: Record<string, string>) => Promise<any>;
	now?: () => number;
};
const fields =
	"id,account_id,name,currency,timezone_name,account_status,disable_reason,spend_cap,amount_spent";
function minor(value: unknown): number | null {
	if (typeof value !== "string" && typeof value !== "number") return null;
	if (!/^\d+$/.test(String(value))) return null;
	const n = Number(value);
	return Number.isSafeInteger(n) ? n : null;
}
function accountSnapshot(raw: any, accountId: string) {
	if (String(raw.id) !== accountId || String(raw.account_id) !== accountId.slice(4))
		throw new Error("Meta account identity mismatch.");
	if (raw.currency !== "AUD")
		throw new Error("Only AUD Meta accounts are supported; refusing currency conversion.");
	if (typeof raw.name !== "string" || !raw.name || typeof raw.timezone_name !== "string")
		throw new Error("Meta account name/timezone is missing.");
	// Validate timezone before calculating complete local days.
	new Intl.DateTimeFormat("en", { timeZone: raw.timezone_name }).format();
	const cap = minor(raw.spend_cap),
		spent = minor(raw.amount_spent);
	const status = minor(raw.account_status),
		reason = minor(raw.disable_reason);
	return {
		id: accountId,
		name: raw.name as string,
		currency: "AUD",
		timezone: raw.timezone_name as string,
		status,
		disable_reason: reason,
		cap,
		spent,
	};
}
async function sign(text: string, secret: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode("blindmotion-meta-spend-limit-v1:" + secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
	return {
		key,
		signature: new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text))),
	};
}
function hex(bytes: Uint8Array) {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
async function safeGet(deps: Deps, path: string, params: Record<string, string>) {
	try {
		return await deps.get(path, params);
	} catch {
		throw new Error(
			"Meta read failed. Check the configured system user's account access and API permissions. Upstream details withheld.",
		);
	}
}
export async function manageMetaSpendLimit(deps: Deps, input: unknown) {
	const args = metaSpendLimitSchema.parse(input);
	const config = deps.getConfig();
	if (!/^act_\d+$/.test(config.adAccountId) || !config.accessToken)
		throw new Error("Invalid Meta account configuration.");
	const now = deps.now?.() ?? Date.now();
	const current = accountSnapshot(
		await safeGet(deps, config.adAccountId, { fields }),
		config.adAccountId,
	);
	const remaining =
		current.cap !== null && current.cap > 0 && current.spent !== null
			? Math.max(0, current.cap - current.spent)
			: null;
	if (args.mode === "read") {
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone: current.timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).formatToParts(new Date(now));
		const part = (name: string) => parts.find((p) => p.type === name)!.value;
		const localDay = Date.parse(`${part("year")}-${part("month")}-${part("day")}T00:00:00Z`);
		const since = new Date(localDay - 7 * 86400000).toISOString().slice(0, 10);
		const until = new Date(localDay - 86400000).toISOString().slice(0, 10);
		let average: number | null = null;
		try {
			const data = await safeGet(deps, config.adAccountId + "/insights", {
				fields: "spend",
				time_range: JSON.stringify({ since, until }),
				limit: "1",
			});
			const rows = data.data;
			if (Array.isArray(rows) && rows.length === 0) average = 0;
			else if (
				Array.isArray(rows) &&
				rows.length === 1 &&
				/^(?:\d+)(?:\.\d+)?$/.test(String(rows[0].spend))
			)
				average = Number(rows[0].spend) / 7;
		} catch {
			/* Account visibility remains available if insights are denied. */
		}
		const days =
			remaining !== null && average !== null && average > 0
				? remaining / 100 / average
				: null;
		const threshold = Math.max(500, ((current.cap ?? 0) / 100) * 0.2, (average ?? 0) * 3);
		const warning =
			current.cap === null || current.spent === null
				? "UNKNOWN"
				: current.cap === 0
					? "NO_ACCOUNT_LIMIT"
					: remaining === 0
						? "EXHAUSTED"
						: remaining! / 100 <= threshold
							? "APPROACHING_LIMIT"
							: "OK";
		return {
			read_only: true,
			account_id: current.id,
			account_name: current.name,
			currency: current.currency,
			timezone: current.timezone,
			account_status_code: current.status,
			account_status:
				(
					{
						1: "ACTIVE",
						2: "DISABLED",
						3: "UNSETTLED",
						7: "PENDING_RISK_REVIEW",
						8: "PENDING_SETTLEMENT",
						9: "IN_GRACE_PERIOD",
						100: "PENDING_CLOSURE",
						101: "CLOSED",
						201: "ANY_ACTIVE",
						202: "ANY_CLOSED",
					} as Record<number, string>
				)[current.status ?? -1] ?? "UNKNOWN",
			disable_reason_code: current.disable_reason,
			account_limit_aud:
				current.cap === null ? null : current.cap === 0 ? null : current.cap / 100,
			limit_state:
				current.cap === null ? "UNKNOWN" : current.cap === 0 ? "UNLIMITED" : "FINITE",
			spend_counted_against_limit_aud: current.spent === null ? null : current.spent / 100,
			remaining_allowance_aud: remaining === null ? null : remaining / 100,
			warning,
			warning_threshold_aud: current.cap !== null && current.cap > 0 ? threshold : null,
			last_7_complete_days: {
				since,
				until,
				timezone: current.timezone,
				average_daily_spend_aud: average,
			},
			estimated_days_remaining: days,
			note: "Warning at 20% allowance remaining, A$500 remaining, or 3 days at recent spend, whichever is earlier. Forecast is indicative and may understate spend after an outage. This read does not schedule alerts. Account status and account cap do not establish other Meta-imposed limits or payment issues.",
		};
	}
	if (current.name !== args.expected_account_name)
		throw new Error("Exact account name does not match.");
	if (
		current.cap === null ||
		current.spent === null ||
		current.status === null ||
		current.disable_reason === null
	)
		throw new Error("Account financial/status fields are missing or invalid; refusing change.");
	const proposed = Math.round(args.new_limit_aud * 100);
	if (proposed <= current.spent)
		throw new Error("New finite limit must exceed the current counted spend.");
	const plan = {
		version: 1,
		account: current,
		new_cap_minor: proposed,
		issued_at: now,
		expires_at: now + TTL,
	};
	if (args.mode === "preview") {
		const payload = JSON.stringify(plan);
		const signed = await sign(payload, config.accessToken);
		return {
			write_performed: false,
			account_id: current.id,
			account_name: current.name,
			currency: "AUD",
			timezone: current.timezone,
			previous_limit_aud: current.cap === 0 ? null : current.cap / 100,
			previous_limit_state: current.cap === 0 ? "UNLIMITED" : "FINITE",
			spend_counted_against_limit_aud: current.spent / 100,
			remaining_allowance_aud: remaining === null ? null : remaining / 100,
			proposed_limit_aud: proposed / 100,
			proposed_remaining_allowance_aud: (proposed - current.spent) / 100,
			preview_token:
				btoa(unescape(encodeURIComponent(payload))) + "." + hex(signed.signature),
			expires_at: new Date(plan.expires_at).toISOString(),
			required_confirmation: CONFIRMATION,
			note: "Obtain approval for this exact account and new finite limit before apply. This can immediately resume spending by active campaigns. No reset, removal, campaign-budget or status changes are performed.",
		};
	}
	let approved: typeof plan;
	try {
		const [encoded, signature, extra] = args.preview_token.split(".");
		if (extra !== undefined || !/^[a-f0-9]{64}$/.test(signature ?? "")) throw new Error();
		const payload = decodeURIComponent(escape(atob(encoded)));
		const { key } = await sign(payload, config.accessToken);
		const bytes = Uint8Array.from(signature.match(/../g)!, (x) => parseInt(x, 16));
		if (!(await crypto.subtle.verify("HMAC", key, bytes, enc.encode(payload))))
			throw new Error();
		approved = JSON.parse(payload);
	} catch {
		throw new Error("Invalid or tampered Meta limit preview token.");
	}
	if (
		approved.version !== 1 ||
		approved.expires_at <= now ||
		approved.issued_at > now ||
		approved.expires_at - approved.issued_at !== TTL
	)
		throw new Error("Expired or invalid preview; request a fresh preview.");
	if (
		approved.new_cap_minor !== proposed ||
		approved.account.id !== current.id ||
		approved.account.name !== current.name ||
		approved.account.currency !== current.currency ||
		approved.account.timezone !== current.timezone ||
		approved.account.status !== current.status ||
		approved.account.disable_reason !== current.disable_reason ||
		current.spent < approved.account.spent!
	)
		throw new Error("Preview inputs or account state changed; request a fresh preview.");
	if (current.cap === proposed)
		return {
			updated: false,
			verified: true,
			already_at_requested_limit: true,
			account_id: current.id,
			verified_limit_aud: proposed / 100,
		};
	if (approved.account.cap !== current.cap)
		throw new Error("Account limit changed since preview; request a fresh preview.");
	// No automatic retry or rollback: either could re-authorise spend after a concurrent edit.
	try {
		const result = await deps.post(config.adAccountId, { spend_cap: String(proposed) });
		if (result?.success !== true) throw new Error();
	} catch {
		return {
			updated: null,
			write_attempted: true,
			verified: false,
			outcome: "UNKNOWN",
			instruction:
				"Read the account before any retry. The request may have applied; do not retry automatically.",
		};
	}
	try {
		const after = accountSnapshot(
			await safeGet(deps, config.adAccountId, { fields }),
			config.adAccountId,
		);
		if (
			after.cap !== proposed ||
			after.name !== current.name ||
			after.timezone !== current.timezone
		)
			throw new Error();
		return {
			updated: true,
			verified: true,
			account_id: after.id,
			previous_limit_aud: current.cap === 0 ? null : current.cap / 100,
			verified_limit_aud: after.cap / 100,
			spend_counted_against_limit_aud: after.spent === null ? null : after.spent / 100,
			remaining_allowance_aud:
				after.spent === null ? null : Math.max(0, after.cap - after.spent) / 100,
			account_status_code: after.status,
			disable_reason_code: after.disable_reason,
			note: "Only spend_cap was written. Delivery resumption is not guaranteed; other account restrictions may remain.",
		};
	} catch {
		return {
			updated: null,
			write_attempted: true,
			verified: false,
			outcome: "UNVERIFIED",
			instruction:
				"Meta accepted the request but verification failed. Read the account before any further change. No retry or rollback was attempted.",
		};
	}
}
