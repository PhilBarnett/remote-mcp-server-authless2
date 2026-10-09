import OAuthProvider, {
	AuthorizationError,
	CimdFetchError,
	insufficientScope,
	type ConsentDescription,
	type OAuthHelpers,
	type OAuthResourceAuth,
} from "@cloudflare/workers-oauth-provider";

export const MCP_SCOPE = "business:manage";
export const MCP_RESOURCE = "https://remote-mcp-server-authless2.phil-cd4.workers.dev/mcp";

export interface AuthEnv {
	OAUTH_KV: KVNamespace;
	MCP_OWNER_SECRET: string;
	OAUTH_PROVIDER: OAuthHelpers;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
const secureHeaders = {
	"Cache-Control": "no-store",
	"Content-Type": "text/plain; charset=utf-8",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
	"Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function consentPage(details: ConsentDescription, handle: string) {
	return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Connect Blindmotion Business MCP</title><h1>Connect your business tools</h1>
<p><strong>${escapeHtml(details.clientName)}</strong> is requesting business management access, including reads and writes.</p>
<p>${details.clientDomain ? "Client domain: " + escapeHtml(details.clientDomain) : "This client's name is self-reported."}</p>
<p>Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? "<p>This connects an app on your computer. Continue only if you started this connection.</p>" : ""}
<p>Permission: <strong>${MCP_SCOPE}</strong> — Blindmotion and any explicitly configured Equinox tools.</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<p><label>Owner connection password <input name="owner_secret" type="password" autocomplete="current-password" maxlength="512"></label></p>
<p>Use the password saved as MCP_OWNER_SECRET in this Worker's settings. Never paste it into a chat.</p>
<button name="decision" value="approve">Connect</button> <button name="decision" value="deny">Cancel</button>
</form></html>`;
}

async function matchesOwnerSecret(supplied: string, expected: string) {
	const encoder = new TextEncoder();
	const [left, right] = await Promise.all([supplied, expected].map(value =>
		crypto.subtle.digest("SHA-256", encoder.encode(value))));
	return crypto.subtle.timingSafeEqual(left, right);
}

export const authorizationHandler = {
	async fetch(request: Request, env: AuthEnv): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/equinox/mcp") return new Response("Use the authenticated /mcp connection.", { status: 410, headers: secureHeaders });
		if (url.pathname !== "/authorize") return new Response("Not found", { status: 404, headers: secureHeaders });
		if (!env.MCP_OWNER_SECRET || env.MCP_OWNER_SECRET.length < 32 || env.MCP_OWNER_SECRET.length > 512) {
			return new Response("Owner sign-in is not configured.", { status: 503, headers: secureHeaders });
		}
		const oauth = env.OAUTH_PROVIDER;
		try {
			if (request.method === "GET") {
				const parsed = await oauth.parseAuthRequest(request);
				if (parsed.scope.some(scope => scope !== MCP_SCOPE && scope !== "offline_access")) {
					return new Response("Unsupported permission requested.", { status: 400, headers: secureHeaders });
				}
				const details = await oauth.describeConsent(parsed);
				// Chrome applies form-action to the OAuth redirect after the POST too.
				// Only include the origin of the callback already validated by the provider.
				const callbackOrigin = new URL(details.redirectUri).origin;
				if (!/^https?:\/\/[a-zA-Z0-9.\[\]:-]+$/.test(callbackOrigin)) {
					return new Response("Unsupported callback origin", { status: 400, headers: secureHeaders });
				}
				const consent = await oauth.beginConsent(parsed);
				for (const [key, value] of Object.entries(secureHeaders)) consent.headers.set(key, value);
				consent.headers.set("Content-Type", "text/html; charset=utf-8");
				// no-referrer makes browsers send Origin: null on a native form POST.
				// Keep the same-origin POST verifiable without leaking referrers cross-origin.
				consent.headers.set("Referrer-Policy", "same-origin");
				consent.headers.set("Content-Security-Policy", secureHeaders["Content-Security-Policy"].replace("form-action 'self'", "form-action 'self' " + callbackOrigin));
				return new Response(consentPage(details, consent.handle), { headers: consent.headers });
			}
			if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { ...secureHeaders, Allow: "GET, POST" } });
			if (request.headers.get("Origin") !== url.origin) return new Response("Invalid form origin", { status: 403, headers: secureHeaders });
			if (!(request.headers.get("Content-Type") ?? "").startsWith("application/x-www-form-urlencoded")) return new Response("Invalid form", { status: 415, headers: secureHeaders });
			const raw = await request.text();
			if (raw.length > 8192) return new Response("Form too large", { status: 413, headers: secureHeaders });
			const form = new URLSearchParams(raw);
			const handle = form.get("handle") ?? "";
			if (form.get("decision") !== "approve") {
				const denied = await oauth.denyConsent(request, handle);
				return new Response(null, { status: 303, headers: denied.headers });
			}
			const secret = form.get("owner_secret") ?? "";
			if (secret.length > 512 || !await matchesOwnerSecret(secret, env.MCP_OWNER_SECRET)) {
				return new Response("Sign-in failed. Return to the connection page and try again.", { status: 401, headers: secureHeaders });
			}
			// The library checks the browser-bound, one-use consent handle and scopes.
			const approved = await oauth.approveConsent(request, handle, { scope: [MCP_SCOPE] });
			const { redirectTo } = await oauth.completeAuthorization({
				request: approved.request,
				userId: "business-owner",
				metadata: { label: "Business owner" },
				scope: [MCP_SCOPE],
				props: { userId: "business-owner" },
			});
			approved.headers.set("Location", redirectTo);
			approved.headers.set("Cache-Control", "no-store");
			approved.headers.set("Referrer-Policy", "no-referrer");
			return new Response(null, { status: 303, headers: approved.headers });
		} catch (error) {
			// Do not redirect from reconstructed form values or expose credential data.
			if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
				return new Response("Connection request is invalid or expired. Start the connection again.", { status: 400, headers: secureHeaders });
			}
			return new Response("Connection service unavailable. Try again later.", { status: 503, headers: secureHeaders });
		}
	},
};

export function authenticatedMcp<E extends AuthEnv>(handler: (request: Request, env: E, ctx: ExecutionContext) => Response | Promise<Response>) {
	return new OAuthProvider<E>({
		apiRoute: "/mcp",
		apiHandler: {
			fetch(request, env, ctx) {
				const auth = (ctx as ExecutionContext & { auth: OAuthResourceAuth }).auth;
				if (!auth) return new Response("Unauthorized", { status: 401 });
				if (!auth.scope.includes(MCP_SCOPE)) return insufficientScope(auth, [MCP_SCOPE]);
				if ((ctx.props as { userId?: string })?.userId !== "business-owner") return new Response("Forbidden", { status: 403 });
				if (new URL(request.url).pathname !== "/mcp") return new Response("Not found", { status: 404 });
				return handler(request, env, ctx);
			},
		},
		defaultHandler: authorizationHandler,
		authorizeEndpoint: "/authorize",
		tokenEndpoint: "/oauth/token",
		clientRegistrationEndpoint: "/oauth/register",
		resourceMetadata: { resource: MCP_RESOURCE, resource_name: "Blindmotion Business MCP" },
		scopesSupported: [MCP_SCOPE],
		requiredScopes: [MCP_SCOPE],
		accessTokenTTL: 3600,
		refreshTokenTTL: 2592000,
		// Each successful refresh extends the grant by another 30 days.
		refreshTokenIdleTTL: 2592000,
	});
}
