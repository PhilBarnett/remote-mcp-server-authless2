import type { McpServer } from "@modelcontextprotocol/server";
import { controlSchema, manageChatgptAdsControls } from "./chatgpt-ads-controls";

const API_ORIGIN = "https://api.ads.openai.com";
type AdsBindings = { OPENAI_ADS_API_KEY?: string };
type AdsDependencies = {
	getBindings: () => AdsBindings;
	fetch: typeof fetch;
};

function redactResponse(value: any): any {
	if (Array.isArray(value)) return value.map(redactResponse);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, /(?:api_key|access_token|refresh_token|signing_secret|password|private_key|authorization)/i.test(name) ? "[REDACTED]" : redactResponse(item)]));
	return value;
}

// Only routes in the restricted advanced catalog are reachable.
// There is no arbitrary URL, method or header input.
async function adsRequest(
	deps: AdsDependencies,
	path: string,
	params: URLSearchParams = new URLSearchParams(),
	conversionBody?: Record<string, unknown>,
	options: { method?: string; idempotencyKey?: string; multipart?: FormData } = {},
) {
	const key = deps.getBindings().OPENAI_ADS_API_KEY?.trim();
	if (!key) throw new Error("ChatGPT Ads is not configured. Add OPENAI_ADS_API_KEY as an encrypted Cloudflare Worker secret.");
	const url = new URL(`/v1/${path}`, API_ORIGIN);
	url.search = params.toString();
	let response: Response;
	try {
		response = await deps.fetch(url.toString(), {
			method: options.method ?? (conversionBody ? "POST" : "GET"),
			redirect: "manual",
			signal: AbortSignal.timeout(20000),
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(conversionBody && !options.multipart ? { "Content-Type": "application/json" } : {}), ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}) },
			...(options.multipart ? { body: options.multipart } : conversionBody ? { body: JSON.stringify(conversionBody) } : {}),
		});
	} catch (error) {
		const kind = error instanceof Error && ["TimeoutError", "AbortError", "TypeError"].includes(error.name) ? error.name : "TransportError";
		throw new Error(`ChatGPT Ads request failed (${kind}); credentials and upstream details are withheld.`);
	}
	if (response.status >= 300 && response.status < 400) {
		throw new Error(`ChatGPT Ads API returned redirect HTTP ${response.status}; redirect blocked to protect credentials.`);
	}
	if (!response.ok) {
		// Never echo upstream error bodies, headers or credentials.
		throw new Error(`ChatGPT Ads API returned HTTP ${response.status}. Check account access and request settings in Ads Manager.`);
	}
	const body = await response.text();
	if (!body.trim()) return {};
	if (body.length > 2000000) throw new Error("ChatGPT Ads response is too large; request a smaller page.");
	try {
		// Defence in depth if an upstream response ever echoes the secret.
		return redactResponse(JSON.parse(body.split(key).join("[REDACTED]"))) as Record<string, any>;
	} catch {
		throw new Error("ChatGPT Ads returned an invalid JSON response.");
	}
}

// Routine controls and reports belong to the official Ads Manager plugin.
export const managementInputSchema = controlSchema;
export async function manageChatgptAds(deps: AdsDependencies, input: unknown) {
	return manageChatgptAdsControls(input, (path, params, body, options) => adsRequest(deps, path, params, body, options), () => deps.getBindings().OPENAI_ADS_API_KEY);
}

export function registerChatgptAdsTools(server: McpServer, deps: AdsDependencies) {
	server.registerTool("manage_chatgpt_ads_advanced", {
		description: "Advanced controls for the fixed Blindmotion ChatGPT Ads account. Use the official ChatGPT Ads Manager plugin for campaigns, ads, ad groups, creative uploads, audiences and reporting. action=controls mode=describe lists 22 non-overlapping operations: account activation/pause, account spending limits, conversion-source/event-setting creation, landing-page crawler evidence and product-feed maintenance/SFTP. Reads use mode=read; writes require preview then apply with identical inputs and a signed 15-minute preview_token. Account identity, currency and state are revalidated. AUD micros: 1000000 per dollar. Credentials remain in Cloudflare. Installing capabilities does not authorize spending.",
		inputSchema: managementInputSchema,
		annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
	}, async args => {
		try { return { content: [{ type: "text" as const, text: JSON.stringify(await manageChatgptAds(deps, args), null, 2) }] }; }
		catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "ChatGPT Ads report failed." }] }; }
	});
}
