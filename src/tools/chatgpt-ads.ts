import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const ACCOUNT_ID = "adacct_6ac4305ad094819e97ddf2ada19c5a78";
const API_ORIGIN = "https://api.ads.openai.com";
type AdsBindings = { OPENAI_ADS_API_KEY?: string };
type AdsDependencies = {
	getBindings: () => AdsBindings;
	fetch: typeof fetch;
};

const schema = z.object({
	action: z.enum(["account", "campaigns", "ad_groups", "ads", "delivery", "conversions", "locations"]),
	campaign_id: z.string().regex(/^cmpn_[A-Za-z0-9]+$/).optional(),
	ad_group_id: z.string().regex(/^adgrp_[A-Za-z0-9]+$/).optional(),
	query: z.string().trim().min(2).max(100).optional(),
	limit: z.number().int().min(1).max(100).default(50),
	after: z.string().min(1).max(2000).optional(),
	start_unix: z.number().int().min(946684800).max(4102444800).optional(),
	end_unix: z.number().int().min(946684800).max(4102444800).optional(),
	aggregation_level: z.enum(["campaign", "ad_group", "ad"]).default("campaign"),
	time_granularity: z.enum(["none", "daily"]).default("daily"),
	click_window_days: z.union([z.literal(7), z.literal(14), z.literal(30)]).default(30),
	view_window_days: z.union([z.literal(0), z.literal(1)]).default(1),
}).strict();
type AdsInput = z.infer<typeof schema>;

// Only these internal routes are reachable. There is no arbitrary URL, method,
// header or body input, and no campaign/budget/creative mutation path.
async function adsRequest(
	deps: AdsDependencies,
	path: string,
	params: URLSearchParams = new URLSearchParams(),
	conversionBody?: Record<string, unknown>,
) {
	const key = deps.getBindings().OPENAI_ADS_API_KEY?.trim();
	if (!key) throw new Error("ChatGPT Ads is not configured. Add OPENAI_ADS_API_KEY as an encrypted Cloudflare Worker secret.");
	const url = new URL(`/v1/${path}`, API_ORIGIN);
	url.search = params.toString();
	let response: Response;
	try {
		response = await deps.fetch(url.toString(), {
			method: conversionBody ? "POST" : "GET",
			redirect: "manual",
			signal: AbortSignal.timeout(20000),
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(conversionBody ? { "Content-Type": "application/json" } : {}) },
			...(conversionBody ? { body: JSON.stringify(conversionBody) } : {}),
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
	if (body.length > 2000000) throw new Error("ChatGPT Ads response is too large; request a smaller page.");
	try {
		// Defence in depth if an upstream response ever echoes the secret.
		return JSON.parse(body.split(key).join("[REDACTED]")) as Record<string, any>;
	} catch {
		throw new Error("ChatGPT Ads returned an invalid JSON response.");
	}
}

function reportRange(args: AdsInput, timezone: string) {
	const start = args.start_unix;
	const end = args.end_unix;
	if (start === undefined || end === undefined || end <= start || end - start > 366 * 86400) {
		throw new Error("Reports require start_unix and end_unix (exclusive), in order, spanning no more than 365 account-local days.");
	}
	const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
	const localDates = [start, end].map(timestamp => {
		const parts = formatter.formatToParts(new Date(timestamp * 1000));
		const part = (name: string) => parts.find(value => value.type === name)?.value;
		if (part("hour") !== "00" || part("minute") !== "00" || part("second") !== "00") {
			throw new Error("Report boundaries must be midnight in the ad account timezone; end_unix is exclusive.");
		}
		return Date.UTC(Number(part("year")), Number(part("month")) - 1, Number(part("day")));
	});
	if (localDates[1] - localDates[0] > 365 * 86400000) throw new Error("Report range exceeds 365 account-local days.");
	return JSON.stringify({ type: "unix_range", start, end });
}

export async function readChatgptAds(deps: AdsDependencies, input: unknown) {
	const args = schema.parse(input);
	if (args.action === "ad_groups" && !args.campaign_id) throw new Error("ad_groups requires campaign_id.");
	if (args.action === "ads" && !args.ad_group_id) throw new Error("ads requires ad_group_id.");
	if (args.action === "locations" && !args.query) throw new Error("locations requires a geographic search query.");
	const account = await adsRequest(deps, "ad_account");
	if (account.id !== ACCOUNT_ID) throw new Error("ChatGPT Ads account identity mismatch; refusing access to a different account.");
	const context = {
		read_only: true,
		account_id: ACCOUNT_ID,
		currency: account.currency_code ?? null,
		timezone: account.timezone ?? null,
	};
	if (args.action === "account") return { ...context, account, authenticated: true };
	const params = new URLSearchParams({ limit: String(args.limit) });
	if (args.after) params.set("after", args.after);
	let result: Record<string, any>;
	if (args.action === "delivery" || args.action === "conversions") {
		if (typeof account.timezone !== "string" || !account.timezone) throw new Error("Account timezone is missing; refusing an ambiguous reporting window.");
		const range = reportRange(args, account.timezone);
		if (args.action === "conversions") {
			if (args.after) throw new Error("Conversion reports do not support this pagination cursor.");
			result = await adsRequest(deps, "conversions/insights", new URLSearchParams(), {
				aggregation_level: args.aggregation_level,
				time_ranges: [range],
				time_granularity: args.time_granularity,
				group_by_entity: false,
				attribution_window_days: args.click_window_days,
				view_through_attribution_window_days: args.view_window_days,
				include: ["attributed_events"],
			});
		} else {
			params.set("aggregation_level", args.aggregation_level);
			params.set("time_granularity", args.time_granularity);
			params.append("time_ranges[]", range);
			params.append("fields[]", "metadata.readable_time");
			for (const field of ["id", "name", "impressions", "clicks", "spend"]) params.append("fields[]", `${args.aggregation_level}.${field}`);
			result = await adsRequest(deps, "ad_account/insights", params);
		}
	} else if (args.action === "locations") {
		params.set("q", args.query!);
		result = await adsRequest(deps, "geo_lookup/search", params);
	} else {
		if (args.action === "ad_groups") params.set("campaign_id", args.campaign_id!);
		if (args.action === "ads") params.set("ad_group_id", args.ad_group_id!);
		result = await adsRequest(deps, args.action, params);
	}
	return {
		...context,
		action: args.action,
		...(args.action === "delivery" || args.action === "conversions" ? { start_unix: args.start_unix, end_unix_exclusive: args.end_unix } : {}),
		...(args.action === "conversions" ? { attribution: { click_window_days: args.click_window_days, view_window_days: args.view_window_days, time_basis: "ad_event_time" } } : {}),
		result,
		page_complete: result.has_more === false ? true : result.has_more === true ? false : null,
	};
}

export function registerChatgptAdsTools(server: McpServer, deps: AdsDependencies) {
	server.registerTool("get_chatgpt_ads_report", {
		description: "Read Blindmotion ChatGPT Ads account status, campaign/ad inventory, delivery, attributed conversions and supported geographic lookup. Account identity is pinned; credentials stay in Cloudflare. Unix report boundaries must be account-local midnight with an exclusive end. Pagination is explicit. Cannot create ads, change budgets or activate delivery.",
		inputSchema: schema,
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
	}, async args => {
		try { return { content: [{ type: "text" as const, text: JSON.stringify(await readChatgptAds(deps, args), null, 2) }] }; }
		catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "ChatGPT Ads report failed." }] }; }
	});
}

