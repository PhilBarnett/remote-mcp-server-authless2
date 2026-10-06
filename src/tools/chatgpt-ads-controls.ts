import { z } from "zod";
import { definitions, operations } from "./chatgpt-ads-catalog";

const ACCOUNT_ID = "adacct_6ac4305ad094819e97ddf2ada19c5a78";
const names = Object.keys(operations) as [keyof typeof operations, ...(keyof typeof operations)[]];
export const controlSchema = z.object({
	action: z.literal("controls"),
	mode: z.enum(["describe", "read", "preview", "apply"]),
	operation: z.enum(names).optional(),
	parameters: z.record(z.string(), z.unknown()).default({}),
	body: z.record(z.string(), z.unknown()).optional(),
	idempotency_key: z.string().trim().min(1).max(255).regex(/^[\x21-\x7e]+$/).optional(),
	preview_token: z.string().max(400).optional(),
}).strict();
type Input = z.infer<typeof controlSchema>;
type RequestOptions = { method?: string; idempotencyKey?: string; multipart?: FormData };
type Transport = (path: string, query?: URLSearchParams, body?: Record<string, unknown>, options?: RequestOptions) => Promise<Record<string, any>>;

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
function validate(value: unknown, rule: any, label: string, depth = 0): void {
	if (depth > 40) throw new Error("ChatGPT Ads input nesting is too deep.");
	if (rule.$ref) return validate(value, definitions[rule.$ref.split("/").pop()], label, depth + 1);
	if (rule.anyOf || rule.oneOf) {
		const variants = rule.anyOf ?? rule.oneOf;
		let matches = 0;
		for (const item of variants) { try { validate(value, item, label, depth + 1); matches++; } catch { /* Try the next documented variant. */ } }
		if (matches === 0 || (rule.oneOf && matches !== 1)) throw new Error(`${label} does not match a documented API shape.`);
		return;
	}
	if (rule.allOf) { for (const item of rule.allOf) validate(value, item, label, depth + 1); return; }
	if (rule.enum && !rule.enum.includes(value)) throw new Error(`${label} is not a documented enum value.`);
	if (rule.type === "null") { if (value !== null) throw new Error(`${label} must be null.`); return; }
	if (rule.type === "object") {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
		const object = value as Record<string, unknown>;
		for (const key of rule.required ?? []) if (!(key in object)) throw new Error(`${label}.${key} is required.`);
		for (const [key, item] of Object.entries(object)) {
			if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Unsafe input property.");
			if (rule.properties?.[key]) validate(item, rule.properties[key], `${label}.${key}`, depth + 1);
			else if (rule.additionalProperties === true) continue;
			else if (rule.additionalProperties && typeof rule.additionalProperties === "object") validate(item, rule.additionalProperties, `${label}.${key}`, depth + 1);
			else throw new Error(`${label}.${key} is not a documented API field.`);
		}
	}
	if (rule.type === "array") {
		if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
		if (value.length > (rule.maxItems ?? 10000) || value.length < (rule.minItems ?? 0)) throw new Error(`${label} has an invalid item count.`);
		for (const item of value) validate(item, rule.items ?? {}, label, depth + 1);
	}
	if (rule.type === "string") {
		if (typeof value !== "string") throw new Error(`${label} must be a string.`);
		if (value.length < (rule.minLength ?? 0) || value.length > (rule.maxLength ?? 1500000)) throw new Error(`${label} has an invalid length.`);
		if (rule.pattern && !new RegExp(rule.pattern).test(value)) throw new Error(`${label} has an invalid format.`);
	}
	if (rule.type === "integer" || rule.type === "number") {
		if (typeof value !== "number" || !Number.isFinite(value) || (rule.type === "integer" && !Number.isSafeInteger(value))) throw new Error(`${label} must be a safe ${rule.type}.`);
		if ((rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum)) throw new Error(`${label} is out of range.`);
	}
	if (rule.type === "boolean" && typeof value !== "boolean") throw new Error(`${label} must be boolean.`);
}

function safePayload(value: unknown, key = ""): void {
	if (key === "ad_account_id" && value !== ACCOUNT_ID) throw new Error("Only the configured Blindmotion ad account is allowed.");
	if (/(?:api_key|signing_secret|password|access_token|refresh_token)/i.test(key)) throw new Error("Credentials must be managed outside ChatGPT Ads controls.");
	if (typeof value === "string" && /(?:^|_)(?:url|uri)$/.test(key)) {
		let url: URL;
		try { url = new URL(value); } catch { throw new Error(`${key} must be an absolute HTTPS URL.`); }
		if (url.protocol !== "https:" || url.username || url.password || url.hostname === "localhost" || /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/.test(url.hostname)) throw new Error(`${key} must be a public HTTPS URL without credentials.`);
	}
	if (Array.isArray(value)) { for (const item of value) safePayload(item, key); }
	else if (value && typeof value === "object") for (const [name, item] of Object.entries(value)) safePayload(item, name);
}

function prepare(input: Input) {
	if (!input.operation) throw new Error("Choose a documented ChatGPT Ads operation; use describe to list controls.");
	const operation = operations[input.operation] as any;
	if (canonical(input).length > 1500000) throw new Error("ChatGPT Ads input exceeds 1.5 MB; use a smaller upload or batch.");
	const supplied = input.parameters;
	const allowed = new Set(operation.parameters.filter((p: any) => p.in !== "header").map((p: any) => p.name));
	for (const key of Object.keys(supplied)) if (!allowed.has(key)) throw new Error(`Unknown API parameter: ${key}.`);
	let path = operation.path;
	const query = new URLSearchParams();
	for (const parameter of operation.parameters) {
		if (parameter.in === "header") continue;
		const value = supplied[parameter.name];
		if (value === undefined) { if (parameter.required) throw new Error(`${parameter.name} is required.`); continue; }
		validate(value, parameter.schema, parameter.name);
		if (parameter.in === "path") {
			if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value)) throw new Error("Resource IDs cannot contain path or URL syntax.");
			path = path.replace(`{${parameter.name}}`, value);
		} else if (parameter.in === "query") {
			if (Array.isArray(value)) for (const item of value) query.append(parameter.name.endsWith("[]") ? parameter.name : `${parameter.name}[]`, typeof item === "object" ? JSON.stringify(item) : String(item));
			else query.set(parameter.name, typeof value === "object" ? JSON.stringify(value) : String(value));
		}
	}
	if (operation.body) validate(input.body ?? {}, operation.body, "body");
	else if (input.body && Object.keys(input.body).length) throw new Error("This operation does not accept a body.");
	safePayload(input.body);
	if (input.operation === "post_product_feed_sftp_access" && (input.body?.authentication_method !== "ssh_key" || typeof input.body?.ssh_public_key !== "string" || !input.body.ssh_public_key.trim())) throw new Error("SFTP controls require ssh_key authentication and an SSH public key; manage password issuance securely in Ads Manager.");
	if (operation.idempotency && !input.idempotency_key && input.mode !== "describe") throw new Error("This create operation requires an idempotency_key for safe retries.");
	const multipart: FormData | undefined = undefined;
	return { operation, path: path.replace(/^\//, ""), query, multipart };
}

function describe(operation?: Input["operation"]) {
	if (!operation) return {
		account_id: ACCOUNT_ID,
		operations: Object.entries(operations).map(([name, value]) => ({ operation: name, summary: value.summary, read_only: value.readOnly })),
		usage: "Choose an operation and use describe for its exact parameters and body schema. Reads use mode=read. Writes require preview then apply with the same inputs and preview_token. Money is in AUD micros (1 AUD = 1000000 micros). Routine campaigns and reporting use the official Ads Manager plugin.",
		outside_scope: "Routine campaign, ad, audience, upload and reporting operations belong to the official Ads Manager plugin. Account provisioning and API-key issuance are excluded. SFTP setup uses SSH public keys, not password issuance.",
	};
	const value = operations[operation] as any;
	const used: Record<string, unknown> = {};
	function collect(rule: any) {
		if (!rule || typeof rule !== "object") return;
		if (rule.$ref) { const name = rule.$ref.split("/").pop(); if (!(name in used)) { used[name] = definitions[name]; collect(definitions[name]); } }
		for (const child of Object.values(rule)) if (typeof child === "object") collect(child);
	}
	collect(value);
	return { operation, ...value, definitions: used };
}

async function digest(value: unknown) {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
	return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function signingKey(secret: string) {
	return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
function unhex(value: string) { return Uint8Array.from(value.match(/../g) ?? [], pair => parseInt(pair, 16)); }

async function snapshot(request: Transport, input: Input, path: string, account: Record<string, any>) {
	const state: Record<string, unknown> = { account };
	const routes = new Set<string>();
	const first = path.split("/");
	if (first[0] === "ads" && first[1]) routes.add(first.slice(0, 2).join("/"));
	if (first[0] === "feeds") routes.add(first[1] ? `feeds/${first[1]}/settings` : "feeds");
	if (first[0] === "ad_account" && /spend_limit/.test(path)) routes.add("ad_account/spend_limit_windows");
	if (input.operation === "create_conversion_source") routes.add("conversions/pixels");
	if (input.operation === "create_conversion_event_setting") routes.add("conversions/event_settings");
	for (const field of ["campaign_id", "ad_group_id", "product_feed_id"] as const) {
		const value = input.body?.[field];
		if (typeof value === "string") {
			if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value)) throw new Error("Invalid parent resource identity.");
			routes.add(field === "campaign_id" ? `campaigns/${value}` : field === "ad_group_id" ? `ad_groups/${value}` : `feeds/${value}/settings`);
		}
	}
	for (const route of routes) state[route] = await request(route);
	return state;
}

export async function manageChatgptAdsControls(raw: unknown, request: Transport, getSecret: () => string | undefined) {
	const input = controlSchema.parse(raw);
	if (input.mode === "describe") return describe(input.operation);
	const prepared = prepare(input);
	const account = await request("ad_account");
	if (account.id !== ACCOUNT_ID) throw new Error("ChatGPT Ads account identity mismatch; refusing access.");
	const context = { account_id: ACCOUNT_ID, currency: account.currency_code, timezone: account.timezone, operation: input.operation };
	const execute = () => request(prepared.path, prepared.query, prepared.multipart ? undefined : input.body, { method: prepared.operation.method, idempotencyKey: prepared.operation.idempotency ? input.idempotency_key : undefined, multipart: prepared.multipart });
	if (prepared.operation.readOnly) {
		if (input.mode !== "read") throw new Error("This operation is read-only; use mode=read.");
		return { ...context, read_only: true, result: await execute() };
	}
	if (input.mode === "read") throw new Error("This operation changes the account; use preview then apply.");
	if (account.currency_code !== "AUD") throw new Error("Account currency changed; reconfigure money handling before applying controls.");
	const state = await snapshot(request, input, prepared.path, account);
	const requestHash = await digest({ operation: input.operation, parameters: input.parameters, body: input.body ?? null, idempotency_key: input.idempotency_key ?? null });
	const stateHash = await digest(state);
	const secret = getSecret()?.trim();
	if (!secret) throw new Error("ChatGPT Ads credentials are not configured.");
	const key = await signingKey(secret);
	if (input.mode === "preview") {
		const expires = Date.now() + 15 * 60000;
		const message = `${ACCOUNT_ID}|${expires}|${requestHash}|${stateHash}`;
		const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
		const hex = Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
		const proposedBody = input.body?.file ? { ...input.body, file: `[base64 upload: ${String(input.body.file).length} characters]` } : input.body ?? null;
		return { ...context, applied: false, current: state, proposed: { parameters: input.parameters, body: proposedBody }, preview_token: `${expires}.${requestHash}.${stateHash}.${hex}`, expires_at: new Date(expires).toISOString(), may_change_spending: /activate|campaign|ad_group|spend_limit/.test(input.operation!), retry_policy: prepared.operation.idempotency ? "Reuse the same idempotency_key for retries." : "No automatic mutation retry. If the outcome is uncertain, inspect account state before repeating." };
	}
	const token = input.preview_token?.match(/^(\d{13})\.([a-f0-9]{64})\.([a-f0-9]{64})\.([a-f0-9]{64})$/);
	if (!token) throw new Error("A valid preview_token is required before applying controls.");
	const expires = Number(token[1]);
	if (expires < Date.now() || expires > Date.now() + 15 * 60000) throw new Error("Preview expired; preview the change again.");
	if (token[2] !== requestHash || token[3] !== stateHash) throw new Error("Change inputs or account state changed; preview again before applying.");
	const valid = await crypto.subtle.verify("HMAC", key, unhex(token[4]), new TextEncoder().encode(`${ACCOUNT_ID}|${expires}|${requestHash}|${stateHash}`));
	if (!valid) throw new Error("Preview signature is invalid.");
	// Never retry writes automatically. A timeout can mean the API committed the change.
	const result = await execute();
	let verification: unknown = null;
	let verified = false;
	try { verification = await snapshot(request, input, prepared.path, await request("ad_account")); verified = true; }
	catch { /* The mutation already completed. Report verification separately, never replay it. */ }
	return { ...context, applied: true, result, verification_read_completed: verified, verification };
}
