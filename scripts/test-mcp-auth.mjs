import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { build } from "esbuild";
import * as runtime from "miniflare";

const origin = "https://remote-mcp-server-authless2.phil-cd4.workers.dev";
const resource = origin + "/mcp";
const secret = randomBytes(32).toString("hex");
const bundle = await build({
	// Miniflare dispatchFetch uses a loopback Host header even with an HTTPS URL.
	stdin: { contents: 'import worker from "./src/index"; export default {fetch(request, env, ctx) { const headers = new Headers(request.headers); headers.set("Host", new URL(request.url).host); return worker.fetch(new Request(request, {headers}), env, ctx); }}', resolveDir: process.cwd(), loader: "ts" },
	bundle: true, write: false, format: "esm",
	platform: "browser", conditions: ["workerd", "worker", "browser"],
	external: ["cloudflare:*", "node:*"],
});
const upstreamCalls = [];
const runtimeOptions = {
	modules: true, script: bundle.outputFiles[0].text,
	compatibilityDate: "2026-07-02", compatibilityFlags: ["nodejs_compat"],
	kvNamespaces: ["OAUTH_KV"], bindings: {
		MCP_OWNER_SECRET: secret, WC_SITE: "https://online.blindmotion.com.au",
		WC_CONSUMER_KEY: "test-bm-key", WC_CONSUMER_SECRET: "test-bm-secret",
		WP_USERNAME: "test-bm-user", WP_APPLICATION_PASSWORD: "test-bm-password",
		EQUINOX_WP_USERNAME: "test-eq-user", EQUINOX_WP_APPLICATION_PASSWORD: "test-eq-password",
		EQUINOX_MCP_TOKEN: "test-preview-secret-".repeat(4),
	},
	outboundService: async request => {
		const url = new URL(request.url);
		upstreamCalls.push({ origin: url.origin, path: url.pathname });
		const equinox = url.origin === "https://equinoxwholesaleblinds.com.au";
		assert.ok(equinox || url.origin === "https://online.blindmotion.com.au");
		const expected = equinox ? "test-eq-user:test-eq-password" : "test-bm-key:test-bm-secret";
		assert.equal(request.headers.get("Authorization"), "Basic " + Buffer.from(expected).toString("base64"));
		assert.equal(request.method, "GET");
		if (url.searchParams.get("search") === "test-redirect") return new Response(null, { status: 302, headers: { Location: "https://untrusted.example/steal" } });
		let body;
		if (url.pathname === "/wp-json/") body = { url: url.origin, namespaces: ["wp/v2", "wc/v3"], routes: { "/wc/v3/products": { endpoints: [{ methods: ["GET", "POST"] }] } } };
		else if (url.pathname === "/wp-json/wp/v2/users/me") body = { id: 17, capabilities: { manage_woocommerce: true } };
		else { assert.equal(url.pathname, "/wp-json/wc/v3/products"); body = [{ id: equinox ? 22 : 11, name: equinox ? "Equinox test product" : "Blindmotion test product" }]; }
		return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
	},
};
const mf = new runtime.Miniflare(runtime.convertV4MiniflareOptions ? runtime.convertV4MiniflareOptions(runtimeOptions) : runtimeOptions);
const call = (path, options) => mf.dispatchFetch(origin + path, options);
const formPost = (path, form, headers = {}) => call(path, {
	method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
	body: new URLSearchParams(form).toString(), redirect: "manual",
});
try {
	for (const path of ["/mcp", "/mcp/tools"]) {
		const denied = await call(path, { method: "POST", body: "{}" });
		assert.equal(denied.status, 401);
		assert.match(denied.headers.get("WWW-Authenticate"), /resource_metadata=/);
	}
	assert.equal((await call("/equinox/mcp", { headers: { Authorization: "Bearer " + secret } })).status, 410);
	assert.equal((await call("/", { method: "POST", body: "{}" })).status, 404);
	const metadata = await (await call("/.well-known/oauth-authorization-server")).json();
	assert.ok(metadata.code_challenge_methods_supported.includes("S256"));
	assert.equal(metadata.authorization_endpoint, origin + "/authorize");
	const registration = await call("/oauth/register", {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_name: '<script>alert("x")</script>', redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
	});
	assert.equal(registration.status, 201);
	const client = await registration.json();
	const verifier = randomBytes(32).toString("base64url");
	const authParams = { client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: "code", scope: "business:manage", resource, state: "test-state", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" };
	const begin = () => call("/authorize?" + new URLSearchParams(authParams));
	const page = await begin();
	assert.equal(page.status, 200);
	assert.equal(page.headers.get("Referrer-Policy"), "same-origin");
	const html = await page.text();
	assert.ok(!html.includes('<script>alert("x")</script>'));
	assert.ok(html.includes("&#60;script&#62;"));
	assert.match(page.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
	const cookie = page.headers.get("Set-Cookie").split(";")[0];
	const handle = html.match(/name="handle" value="([^"]+)"/)[1];
	const login = { handle, owner_secret: secret, decision: "approve" };
	assert.equal((await formPost("/authorize", login, { Origin: "https://evil.example", Cookie: cookie })).status, 403);
	assert.equal((await formPost("/authorize", { ...login, owner_secret: "wrong" }, { Origin: origin, Cookie: cookie })).status, 401);
	assert.equal((await formPost("/authorize", login, { Origin: origin })).status, 400);
	assert.equal((await formPost("/authorize", login, { Origin: "null", Cookie: cookie })).status, 403);
	const approved = await formPost("/authorize", login, { Origin: origin, Cookie: cookie });
	assert.equal(approved.status, 302);
	const redirect = new URL(approved.headers.get("Location"));
	assert.equal(redirect.origin, "https://chatgpt.com");
	assert.equal(redirect.searchParams.get("state"), "test-state");
	assert.equal((await formPost("/authorize", login, { Origin: origin, Cookie: cookie })).status, 400);
	const exchange = { grant_type: "authorization_code", client_id: client.client_id, code: redirect.searchParams.get("code"), redirect_uri: client.redirect_uris[0], code_verifier: verifier, resource };
	assert.equal((await formPost("/oauth/token", { ...exchange, resource: "https://other.example/mcp" })).status, 400);
	assert.equal((await formPost("/oauth/token", { ...exchange, code_verifier: "x".repeat(43) })).status, 400);
	const tokenResponse = await formPost("/oauth/token", exchange);
	assert.equal(tokenResponse.status, 200);
	const token = await tokenResponse.json();
	assert.ok(token.access_token && token.refresh_token);
	assert.equal((await call("/mcp", { headers: { Authorization: "Bearer invalid" } })).status, 401);
	const rpc = (accessToken, method, params = {}) => call("/mcp", {
		method: "POST", headers: { Host: new URL(origin).host, Authorization: "Bearer " + accessToken, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const initialized = await rpc(token.access_token, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } });
	assert.equal(initialized.status, 200, await initialized.text());
	const toolsResponse = await rpc(token.access_token, "tools/list");
	assert.equal(toolsResponse.status, 200);
	const toolsText = await toolsResponse.text();
	assert.ok(toolsText.includes("get_products"));
	assert.ok(toolsText.includes("manage_equinox"));
	const decode = text => JSON.parse(text.startsWith("event:") ? text.split("\n").find(line => line.startsWith("data: ")).slice(6) : text);
	const listedTools = decode(toolsText).result.tools;
	assert.equal(listedTools.length, 104);
	assert.equal(new Set(listedTools.map(tool => tool.name)).size, 104);
	const management = listedTools.find(tool => tool.name === "manage_equinox");
	assert.ok(management.inputSchema.required.includes("site"));
	for (const [site, expected] of [["equinox", "Equinox test product"], ["blindmotion", "Blindmotion test product"]]) {
		const response = await rpc(token.access_token, "tools/call", { name: "get_products", arguments: { site, limit: 1 } });
		const text = await response.text();
		assert.ok(text.includes(expected), text);
	}
	const redirectTest = await rpc(token.access_token, "tools/call", { name: "get_products", arguments: { site: "equinox", limit: 1, search: "test-redirect" } });
	assert.ok((await redirectTest.text()).includes("Redirects are refused"));
	const discovered = await rpc(token.access_token, "tools/call", { name: "manage_equinox", arguments: { site: "equinox", action: "discover" } });
	assert.ok((await discovered.text()).includes("authenticated_user_id"));
	const callCount = upstreamCalls.length;
	const invalidSite = await rpc(token.access_token, "tools/call", { name: "manage_equinox", arguments: { site: "blindmotion", action: "discover" } });
	assert.equal(decode(await invalidSite.text()).result.isError, true);
	assert.equal(upstreamCalls.length, callCount);
	assert.ok(upstreamCalls.some(call => call.origin === "https://equinoxwholesaleblinds.com.au"));
	assert.ok(upstreamCalls.some(call => call.origin === "https://online.blindmotion.com.au"));
	// Simulate a grant nearing expiry; refresh must extend it, not retain the old deadline.
	const kv = await mf.getKVNamespace("OAUTH_KV");
	const grants = await kv.list({ prefix: "grant:business-owner:" });
	assert.equal(grants.keys.length, 1);
	const grantKey = grants.keys[0].name;
	const grant = await kv.get(grantKey, "json");
	grant.expiresAt = Math.floor(Date.now() / 1000) + 300;
	await kv.put(grantKey, JSON.stringify(grant), { expirationTtl: 300, metadata: grants.keys[0].metadata });
	const refreshResponse = await formPost("/oauth/token", { grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: client.client_id, resource });
	assert.equal(refreshResponse.status, 200);
	const renewedGrant = await kv.get(grantKey, "json");
	assert.ok(renewedGrant.expiresAt > Math.floor(Date.now() / 1000) + 29 * 86400);
	const refreshed = await refreshResponse.json();
	assert.ok(refreshed.access_token && refreshed.refresh_token !== token.refresh_token);
	const refreshedTools = await rpc(refreshed.access_token, "tools/list");
	assert.equal(refreshedTools.status, 200);
	await refreshedTools.text();
	assert.equal((await formPost("/oauth/token", exchange)).status, 400);
	console.log("PASS: OAuth discovery, PKCE, owner login, consent CSRF/replay, code replay, resource isolation, MCP initialize/list, refresh, legacy-route closure, explicit site schemas, and isolated site credentials.");
} finally {
	await mf.dispose();
}
