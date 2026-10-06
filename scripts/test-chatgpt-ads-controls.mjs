import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const bundle = await build({ entryPoints: [new URL("../src/tools/chatgpt-ads.ts", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "node", target: "es2022" });
const { manageChatgptAds, managementInputSchema, registerChatgptAdsTools } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const ACCOUNT = "adacct_6ac4305ad094819e97ddf2ada19c5a78";
function setup() {
	const account = { id: ACCOUNT, timezone: "Australia/Sydney", currency_code: "AUD", status: "active" };
	const state = { "/v1/ad_account": account, "/v1/campaigns/cmpn_test": { id: "cmpn_test", name: "Test", status: "paused", budget: { daily_spend_limit_micros: 20000000 } }, "/v1/campaigns": { data: [], has_more: false }, "/v1/ad_account/spend_limit_windows": { revision: 0, windows: [] } };
	const calls = [];
	const deps = { getBindings: () => ({ OPENAI_ADS_API_KEY: "test-secret-not-a-real-key" }), fetch: async (url, options) => {
		const path = new URL(url).pathname;
		calls.push({ path, options });
		if ((options.method ?? "GET") === "GET") return Response.json(state[path] ?? { data: [], has_more: false });
		const body = options.body instanceof FormData ? {} : options.body ? JSON.parse(options.body) : {};
		if (path === "/v1/campaigns") return Response.json({ id: "cmpn_new", ...body });
		if (path === "/v1/campaigns/cmpn_test/activate") state["/v1/campaigns/cmpn_test"].status = "active";
		if (state[path]) Object.assign(state[path], body);
		return Response.json(state[path] ?? { id: "file_test", accepted: true });
	} };
	const run = input => manageChatgptAds(deps, { action: "controls", ...input });
	return { run, state, calls, deps };
}
const create = { operation: "create_campaign", body: { name: "Blindmotion Test", status: "paused", budget: { daily_spend_limit_micros: 20000000 }, targeting: { locations: { countries: ["AU"] } } }, idempotency_key: "campaign-test-001" };
test("the registered tool has an MCP object root and per-action defaults stay isolated", async () => {
	let registered;
	const { deps } = setup();
	registerChatgptAdsTools({ registerTool(name, options, callback) { registered = { name, options, callback }; } }, deps);
	assert.equal(registered.name, "manage_chatgpt_ads");
	assert.equal(managementInputSchema.toJSONSchema().type, "object");
	const accountInput = managementInputSchema.parse({ action: "account" });
	assert.deepEqual(accountInput, { action: "account" });
	assert.equal((await manageChatgptAds(deps, accountInput)).authenticated, true);
	const controls = managementInputSchema.parse({ action: "controls", mode: "preview", ...create });
	assert.equal((await manageChatgptAds(deps, controls)).applied, false);
	assert.equal(registered.options.annotations.readOnlyHint, false);
});
test("all 73 operation schemas are discoverable without API access", async () => {
	const { run, calls } = setup();
	const catalog = await run({ mode: "describe" });
	assert.equal(catalog.operations.length, 73);
	for (const item of catalog.operations) { const schema = await run({ mode: "describe", operation: item.operation }); assert.equal(schema.operation, item.operation); }
	assert.equal(calls.length, 0);
});
test("preview makes no writes; apply forwards the exact paused create and idempotency key", async () => {
	const { run, calls } = setup();
	const preview = await run({ mode: "preview", ...create });
	assert.equal(preview.applied, false);
	assert.ok(calls.every(call => call.options.method === "GET"));
	const result = await run({ mode: "apply", ...create, preview_token: preview.preview_token });
	assert.equal(result.applied, true);
	const writes = calls.filter(call => call.options.method !== "GET");
	assert.equal(writes.length, 1);
	assert.equal(writes[0].options.headers["Idempotency-Key"], "campaign-test-001");
	assert.deepEqual(JSON.parse(writes[0].options.body), create.body);
});
test("budget updates are previewed and activation is a separate exact operation", async () => {
	const { run, state } = setup();
	const change = { operation: "update_campaign", parameters: { campaign_id: "cmpn_test" }, body: { budget: { daily_spend_limit_micros: 30000000 } } };
	const preview = await run({ mode: "preview", ...change });
	await run({ mode: "apply", ...change, preview_token: preview.preview_token });
	assert.equal(state["/v1/campaigns/cmpn_test"].budget.daily_spend_limit_micros, 30000000);
	const activation = { operation: "activate_campaign", parameters: { campaign_id: "cmpn_test" } };
	const activationPreview = await run({ mode: "preview", ...activation });
	await run({ mode: "apply", ...activation, preview_token: activationPreview.preview_token });
	assert.equal(state["/v1/campaigns/cmpn_test"].status, "active");
});
test("changed inputs, forged signatures and changed state block every write", async () => {
	const { run, state, calls } = setup();
	const change = { operation: "update_campaign", parameters: { campaign_id: "cmpn_test" }, body: { name: "Changed" } };
	const preview = await run({ mode: "preview", ...change });
	await assert.rejects(run({ mode: "apply", ...change, body: { name: "Other" }, preview_token: preview.preview_token }), /inputs or account state changed/);
	const forged = preview.preview_token.slice(0, -1) + (preview.preview_token.endsWith("0") ? "1" : "0");
	await assert.rejects(run({ mode: "apply", ...change, preview_token: forged }), /signature is invalid/);
	state["/v1/campaigns/cmpn_test"].name = "Changed elsewhere";
	await assert.rejects(run({ mode: "apply", ...change, preview_token: preview.preview_token }), /inputs or account state changed/);
	assert.ok(calls.every(call => call.options.method === "GET"));
});
test("wrong account cannot preview or change resources", async () => {
	const { run, state, calls } = setup();
	state["/v1/ad_account"].id = "adacct_other";
	await assert.rejects(run({ mode: "preview", ...create }), /identity mismatch/);
	assert.equal(calls.length, 1);
});
test("unsafe paths, unsupported fields, invalid money and active creation fail before requests", async () => {
	const { run, calls } = setup();
	for (const invalid of [
		{ operation: "activate_campaign", parameters: { campaign_id: "../ad_account" } },
		{ ...create, body: { ...create.body, unexpected: true } },
		{ ...create, body: { ...create.body, budget: { daily_spend_limit_micros: -1 } } },
		{ ...create, body: { ...create.body, status: "active" } },
		{ ...create, idempotency_key: undefined },
	]) await assert.rejects(run({ mode: "preview", ...invalid }));
	assert.equal(calls.length, 0);
});
test("account spending limits include revision in the previewed body", async () => {
	const { run } = setup();
	const change = { operation: "set_ad_account_daily_spend_limit", body: { amount_micros: 50000000, expected_revision: 0, window_id: null, start_date: "2026-10-07" } };
	const preview = await run({ mode: "preview", ...change });
	assert.deepEqual(preview.proposed.body, change.body);
	assert.equal((await run({ mode: "apply", ...change, preview_token: preview.preview_token })).applied, true);
});
test("sensitive response fields are redacted, including nested credentials", async () => {
	const { run, state } = setup();
	state["/v1/feeds/feed_test/sftp_access"] = { username: "feed_user", password: "fresh-password", nested: { access_token: "fresh-token" } };
	const result = await run({ mode: "read", operation: "get_product_feed_sftp_access", parameters: { feed_id: "feed_test" } });
	assert.equal(result.result.password, "[REDACTED]");
	assert.equal(result.result.nested.access_token, "[REDACTED]");
});
test("read mode cannot mutate, and writes require a valid preview token", async () => {
	const { run, calls } = setup();
	await assert.rejects(run({ mode: "read", ...create }), /changes the account/);
	await assert.rejects(run({ mode: "apply", ...create }), /preview_token/);
	assert.ok(calls.every(call => call.options.method === "GET"));
});
test("multipart uploads retain authentication and do not set a JSON content type", async () => {
	const { run, calls } = setup();
	const upload = { operation: "upload_blob", body: { file: Buffer.from("email\nexample@example.com\n").toString("base64"), purpose: "custom_audience" } };
	const preview = await run({ mode: "preview", ...upload });
	await run({ mode: "apply", ...upload, preview_token: preview.preview_token });
	const write = calls.find(call => call.options.method === "POST");
	assert.ok(write.options.body instanceof FormData);
	assert.equal(write.options.headers["Content-Type"], undefined);
	assert.equal(write.options.headers.Authorization, "Bearer test-secret-not-a-real-key");
});
test("array query parameters use the documented bracket notation", async () => {
	const { deps } = setup();
	let requestUrl;
	const original = deps.fetch;
	deps.fetch = async (url, options) => { if (new URL(url).pathname.includes("insights")) requestUrl = new URL(url); return original(url, options); };
	await manageChatgptAds(deps, { action: "controls", mode: "read", operation: "get_campaign_insights", parameters: { campaign_id: "cmpn_test", fields: ["impressions", "spend"] } });
	assert.deepEqual(requestUrl.searchParams.getAll("fields[]"), ["impressions", "spend"]);
});
test("expiry rejects an old preview and safe errors do not cause mutation retries", async () => {
	const { run, calls, deps } = setup();
	const preview = await run({ mode: "preview", ...create });
	const expired = `${Date.now() - 1}.${preview.preview_token.split(".").slice(1).join(".")}`;
	await assert.rejects(run({ mode: "apply", ...create, preview_token: expired }), /expired/);
	const original = deps.fetch;
	let writes = 0;
	deps.fetch = async (url, options) => { if (options.method === "POST") { writes++; throw new DOMException("test-secret-not-a-real-key", "TimeoutError"); } return original(url, options); };
	await assert.rejects(run({ mode: "apply", ...create, preview_token: preview.preview_token }), error => !error.message.includes("test-secret"));
	assert.equal(writes, 1);
	assert.equal(calls.filter(call => call.options.method === "POST").length, 0);
});
test("SFTP password issuance is blocked while SSH setup remains available", async () => {
	const { run, calls } = setup();
	const base = { operation: "post_product_feed_sftp_access", parameters: { feed_id: "feed_test" } };
	await assert.rejects(run({ mode: "preview", ...base, body: { authentication_method: "password" } }), /SSH public key/);
	assert.equal(calls.length, 0);
	assert.equal((await run({ mode: "preview", ...base, body: { authentication_method: "ssh_key", ssh_public_key: "ssh-ed25519 AAAA test" } })).applied, false);
});
