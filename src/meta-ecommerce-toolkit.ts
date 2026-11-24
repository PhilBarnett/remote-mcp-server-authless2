import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const META_RESUMABLE_VIDEO_UPLOAD_CONFIRMATION = "CONFIRM UPLOAD META VIDEO BATCH";
const META_MAX_HOST_VIDEO_FILE_BYTES = 80_000_000;
const META_ECOMMERCE_AD_CREATE_CONFIRMATION = "CONFIRM CREATE PAUSED META ECOMMERCE AD";
const META_AD_STATUS_CONFIRMATION = "CONFIRM META AD STATUS CHANGE";
const META_ECOMMERCE_LAUNCH_CONFIRMATION = "CONFIRM LAUNCH META ECOMMERCE CAMPAIGN";
const META_MAX_LIST_ITEMS = 500;
const META_DUPLICATE_MAX_PAGES = 20;
const META_AD_SCHEDULE_FIELD = "ad_schedule_end_time";

type MetaConfig = {
	accessToken: string;
	adAccountId: string;
	accountId: string;
	apiVersion: string;
};

type UtmInput = {
	source?: string;
	medium?: string;
	campaign?: string;
	content?: string;
	term?: string;
};

function textResult(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
	};
}

function errorResult(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	console.error("Blindmotion MCP tool error", {
		message,
		stack: error instanceof Error ? error.stack : undefined,
	});
	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		isError: true,
	};
}

function getToolkitMetaConfig(): MetaConfig {
	const workerEnv = env as unknown as Record<string, string | undefined>;
	const accessToken = workerEnv.META_ACCESS_TOKEN?.trim();
	const configuredAccountId = workerEnv.META_AD_ACCOUNT_ID?.trim();
	const apiVersion = workerEnv.META_API_VERSION?.trim();
	if (!accessToken || !configuredAccountId || !apiVersion) {
		throw new Error(
			"Meta ecommerce toolkit is not configured. META_ACCESS_TOKEN, META_AD_ACCOUNT_ID and META_API_VERSION are required.",
		);
	}
	if (!/^v\d+\.\d+$/.test(apiVersion)) {
		throw new Error("META_API_VERSION must use the Graph API vN.N format.");
	}
	const accountId = configuredAccountId.replace(/^act_/, "");
	if (!/^\d+$/.test(accountId)) {
		throw new Error("META_AD_ACCOUNT_ID is not a numeric Meta ad-account ID.");
	}
	return {
		accessToken,
		adAccountId: `act_${accountId}`,
		accountId,
		apiVersion,
	};
}

async function toolkitMetaRequest(
	path: string,
	method: "GET" | "POST",
	params: Record<string, string | number | undefined> = {},
) {
	const { accessToken, apiVersion } = getToolkitMetaConfig();
	const cleanPath = path.replace(/^\/+/, "");
	const url = new URL(`https://graph.facebook.com/${apiVersion}/${cleanPath}`);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		Accept: "application/json",
	};
	let body: URLSearchParams | undefined;
	if (method === "GET") {
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
	} else {
		body = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) body.set(key, String(value));
		}
		headers["Content-Type"] = "application/x-www-form-urlencoded";
	}
	const response = await fetch(url.toString(), { method, headers, body });
	const text = await response.text();
	let parsed: any = null;
	try {
		parsed = text ? JSON.parse(text) : {};
	} catch {
		parsed = { raw: text };
	}
	if (!response.ok || parsed?.error) {
		const metaError = parsed?.error;
		const detail = metaError?.message ?? text ?? `HTTP ${response.status}`;
		const diagnostics = [
			metaError?.error_user_title ? `title=${metaError.error_user_title}` : null,
			metaError?.error_user_msg ? `user_message=${metaError.error_user_msg}` : null,
			metaError?.code !== undefined ? `code=${metaError.code}` : null,
			metaError?.error_subcode !== undefined ? `subcode=${metaError.error_subcode}` : null,
			metaError?.fbtrace_id ? `fbtrace_id=${metaError.fbtrace_id}` : null,
		].filter(Boolean).join("; ");
		throw new Error(`Meta request failed (${response.status}): ${detail}${diagnostics ? ` [${diagnostics}]` : ""}`);
	}
	return parsed;
}

async function toolkitMetaGet(path: string, fields: string) {
	return toolkitMetaRequest(path, "GET", { fields });
}

async function toolkitMetaPost(
	path: string,
	params: Record<string, string | number | undefined>,
	diagnosticContext?: Record<string, unknown>,
) {
	try {
		return await toolkitMetaRequest(path, "POST", params);
	} catch (error) {
		if (!diagnosticContext) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`${message} [creative_diagnostic=${JSON.stringify(diagnosticContext)}]`,
		);
	}
}

async function toolkitSha256Hex(bytes: Uint8Array) {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeVideoFilename(filename: string, mimeType: "video/mp4" | "video/quicktime") {
	const clean = filename.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,198}[A-Za-z0-9]$/.test(clean)) {
		throw new Error("Video filename contains unsupported characters or length.");
	}
	const extension = clean.toLowerCase().split(".").pop();
	if (mimeType === "video/mp4" && extension !== "mp4") {
		throw new Error("MP4 uploads must use an .mp4 filename.");
	}
	if (mimeType === "video/quicktime" && extension !== "mov") {
		throw new Error("QuickTime uploads must use a .mov filename.");
	}
	return clean;
}


function toolkitSiteOrigin() {
	const workerEnv = env as unknown as Record<string, string | undefined>;
	if (!workerEnv.WC_SITE) throw new Error("WC_SITE is required for ecommerce destination validation.");
	return new URL(workerEnv.WC_SITE).origin;
}

function buildMetaDestination(destinationUrl: string, utm: UtmInput) {
	const destination = new URL(destinationUrl);
	const site = new URL(toolkitSiteOrigin());
	if (destination.protocol !== "https:" || destination.origin !== site.origin) {
		throw new Error(`Destination URL must be HTTPS on the configured ecommerce origin ${site.origin}.`);
	}
	if (destination.username || destination.password || destination.hash) {
		throw new Error("Destination URL cannot contain credentials or a fragment.");
	}
	const entries: Array<[string, string | undefined]> = [
		["utm_source", utm.source],
		["utm_medium", utm.medium],
		["utm_campaign", utm.campaign],
		["utm_content", utm.content],
		["utm_term", utm.term],
	];
	const urlTags = new URLSearchParams();
	for (const [key, value] of entries) {
		const resolved = value?.trim() || destination.searchParams.get(key)?.trim();
		destination.searchParams.delete(key);
		if (!resolved) continue;
		if (resolved.length > 200 || /[\r\n]/.test(resolved)) {
			throw new Error(`${key} is invalid.`);
		}
		urlTags.set(key, resolved);
	}
	const cleanDestination = destination.toString();
	const trackedDestination = new URL(cleanDestination);
	for (const [key, value] of urlTags) trackedDestination.searchParams.set(key, value);
	return {
		destinationUrl: cleanDestination,
		urlTags: urlTags.toString(),
		trackedUrl: trackedDestination.toString(),
	};
}

async function listAccountVideos() {
	const { adAccountId } = getToolkitMetaConfig();
	const response = await toolkitMetaRequest(`${adAccountId}/advideos`, "GET", {
		fields: "id,title,created_time,length,status,format,picture",
		limit: META_MAX_LIST_ITEMS,
	});
	return Array.isArray(response?.data) ? response.data : [];
}

function derivedVideoDimensions(video: any) {
	const formats = Array.isArray(video?.format) ? video.format : [];
	const candidates = formats
		.map((item: any) => ({ width: Number(item?.width ?? 0), height: Number(item?.height ?? 0) }))
		.filter((item: any) => item.width > 0 && item.height > 0)
		.sort((a: any, b: any) => b.width * b.height - a.width * a.height);
	return candidates[0] ?? { width: null, height: null };
}

async function assertCreativeAttachedVideoReady(videoId: string) {
	const video = await toolkitMetaGet(videoId, "id,title,length,status,format,picture");
	if (String(video?.id ?? "") !== videoId) {
		throw new Error(`Creative video ${videoId} could not be verified by Meta.`);
	}
	const status = video?.status ?? {};
	if (
		String(status?.video_status ?? "") !== "ready" ||
		String(status?.uploading_phase?.status ?? "") !== "complete" ||
		String(status?.processing_phase?.status ?? "") !== "complete"
	) {
		throw new Error(`Creative video ${videoId} is not fully processed and ready.`);
	}
	return { ...video, derived_dimensions: derivedVideoDimensions(video), ownership_source: "OWNED_AD_CREATIVE_DERIVATIVE" };
}

async function assertOwnedVideo(
	videoId: string,
	expected?: {
		title?: string;
		createdTime?: string;
		lengthSeconds?: number;
		width?: number;
		height?: number;
	},
) {
	const videos = await listAccountVideos();
	const video = videos.find((item: any) => String(item?.id) === videoId);
	if (!video) throw new Error(`Video ${videoId} is not owned by the configured Meta ad account.`);
	if (expected?.title !== undefined && String(video.title ?? "") !== expected.title) {
		throw new Error(`Video ${videoId} title does not match the expected title.`);
	}
	if (expected?.createdTime !== undefined && String(video.created_time ?? "") !== expected.createdTime) {
		throw new Error(`Video ${videoId} upload time does not match the expected time.`);
	}
	if (
		expected?.lengthSeconds !== undefined &&
		Math.abs(Number(video.length ?? 0) - expected.lengthSeconds) > 0.25
	) {
		throw new Error(`Video ${videoId} duration does not match the expected duration.`);
	}
	const dimensions = derivedVideoDimensions(video);
	if (expected?.width !== undefined && Number(dimensions.width) !== expected.width) {
		throw new Error(`Video ${videoId} width does not match the expected width.`);
	}
	if (expected?.height !== undefined && Number(dimensions.height) !== expected.height) {
		throw new Error(`Video ${videoId} height does not match the expected height.`);
	}
	return { ...video, derived_dimensions: dimensions };
}

async function assertOwnedPage(pageId: string) {
	const { adAccountId } = getToolkitMetaConfig();
	const response = await toolkitMetaRequest(`${adAccountId}/promote_pages`, "GET", {
		fields: "id,name",
		limit: 100,
	});
	const page = (response?.data ?? []).find((item: any) => String(item.id) === pageId);
	if (!page) throw new Error(`Page ${pageId} is not available to the configured Meta ad account.`);
	return page;
}

async function resolveInstagramUserId(pageId: string) {
	const page = await toolkitMetaGet(
		pageId,
		"id,instagram_business_account{id,username},connected_instagram_account{id,username}",
	);
	const connectedId = String(
		page?.instagram_business_account?.id ?? page?.connected_instagram_account?.id ?? "",
	);
	if (/^\d+$/.test(connectedId)) return connectedId;

	const pageBacked = await toolkitMetaRequest(
		`${pageId}/page_backed_instagram_accounts`,
		"GET",
		{ fields: "id,username", limit: 25 },
	);
	const pageBackedId = String(pageBacked?.data?.[0]?.id ?? "");
	if (/^\d+$/.test(pageBackedId)) return pageBackedId;

	throw new Error(
		`Page ${pageId} has no connected or page-backed Instagram identity available for Instagram placements.`,
	);
}

async function assertAccountObject(
	id: string,
	type: "campaign" | "adset" | "ad" | "creative",
	fields: string,
) {
	const { accountId } = getToolkitMetaConfig();
	const object = await toolkitMetaGet(id, `id,name,account_id,${fields}`);
	if (String(object?.id) !== id || String(object?.account_id ?? "") !== accountId) {
		throw new Error(`${type} ${id} does not belong to the configured Meta ad account.`);
	}
	return object;
}

const LEGACY_ROLLER_WEBSITE_URL = "https://online.blindmotion.com.au/everyday-roller-blinds/";

// Meta reports UNDEFINED for this existing website setup. Never infer website
// delivery from that enum alone: require the exact reviewed parent and pixel,
// plus a current, owned sibling ad whose creative still proves the website.
async function assertReviewedLegacyRollerWebsiteDestination(adsetId: string, adset: any, campaign: any, destinationUrl: string) {
	const countries = adset.targeting?.geo_locations?.countries;
	const promoted = adset.promoted_object;
	if (
		adset.destination_type !== "UNDEFINED" ||
		buildMetaDestination(destinationUrl, {}).destinationUrl !== LEGACY_ROLLER_WEBSITE_URL ||
		adsetId !== "52667715090600" ||
		String(adset.campaign_id) !== "52667333206000" ||
		String(campaign.id) !== "52667333206000" ||
		adset.status !== "ACTIVE" ||
		campaign.status !== "ACTIVE" ||
		String(promoted?.pixel_id) !== "645264952345909" ||
		promoted?.application_id || promoted?.object_store_url || promoted?.lead_gen_form_id ||
		!Array.isArray(countries) || countries.length !== 1 || countries[0] !== "AU"
	) {
		throw new Error("Parent ad set is not a WEBSITE / OFFSITE_CONVERSIONS sales ad set.");
	}
	const sibling = await assertAccountObject(
		"52667715090400",
		"ad",
		"adset_id,campaign_id,status,creative{id,object_story_spec,asset_feed_spec}",
	);
	const siblingDestinations = collectDestinationUrls(sibling.creative);
	const rollerPage = LEGACY_ROLLER_WEBSITE_URL;
	if (
		String(sibling.adset_id) !== adsetId ||
		String(sibling.campaign_id) !== String(campaign.id) ||
		sibling.status !== "ACTIVE" ||
		String(sibling.creative?.id) !== "1034570949218456" ||
		siblingDestinations.length === 0 ||
		!siblingDestinations.every((candidate) => buildMetaDestination(candidate, {}).destinationUrl === rollerPage)
	) {
		throw new Error("Legacy roller website destination evidence changed. Re-review the existing active ad before creating a paused video.");
	}
}

async function assertSalesAdsetForCreation(adsetId: string, destinationUrl: string) {
	const adset = await assertAccountObject(
		adsetId,
		"adset",
		"campaign_id,status,effective_status,destination_type,optimization_goal,promoted_object,targeting,daily_budget,lifetime_budget",
	);
	if (!["ACTIVE", "PAUSED"].includes(String(adset.status))) {
		throw new Error("Website-sales ad creation requires an ACTIVE or PAUSED parent ad set.");
	}
	if (adset.optimization_goal !== "OFFSITE_CONVERSIONS" ||
		!["WEBSITE", "UNDEFINED"].includes(adset.destination_type)) {
		throw new Error("Parent ad set is not a WEBSITE / OFFSITE_CONVERSIONS sales ad set.");
	}
	const campaign = await assertAccountObject(
		String(adset.campaign_id),
		"campaign",
		"status,effective_status,objective,daily_budget,lifetime_budget",
	);
	if (
		!["ACTIVE", "PAUSED"].includes(String(campaign.status)) ||
		campaign.objective !== "OUTCOME_SALES"
	) {
		throw new Error("Parent campaign must be an ACTIVE or PAUSED OUTCOME_SALES campaign.");
	}
	if (adset.destination_type === "UNDEFINED") {
		await assertReviewedLegacyRollerWebsiteDestination(adsetId, adset, campaign, destinationUrl);
	}
	return { adset, campaign };
}

// Never follow a provider-supplied pagination URL (it can contain credentials).
// Carry only the cursor into the same fixed, owned account edge. An incomplete
// inventory is not permission to create an ad that might already exist.
async function refuseDuplicateAdName(name: string, scope?: { adsetId: string; videoIds: string[]; destination: string }) {
	const { adAccountId } = getToolkitMetaConfig();
	const cursors = new Set<string>();
	let after: string | undefined;
	for (let page = 0; page < META_DUPLICATE_MAX_PAGES; page++) {
		const response = await toolkitMetaRequest(`${adAccountId}/ads`, "GET", {
			fields: scope ? "id,name,status,adset_id,creative{id,object_story_spec,asset_feed_spec}" : "id,name,status",
			limit: META_MAX_LIST_ITEMS,
			after,
		});
		if (!Array.isArray(response?.data)) throw new Error("Meta ad duplicate inventory is incomplete.");
		for (const item of response.data) {
			if (String(item?.name ?? "") === name) throw new Error(`An ad named ${name} already exists in the configured ad account.`);
			if (scope && !/^\d+$/.test(String(item?.adset_id ?? ""))) throw new Error("Meta ad inventory entry did not identify its ad set; nothing created.");
			if (!scope || String(item.adset_id) !== scope.adsetId) continue;
			if (!item.creative?.id || (!item.creative.object_story_spec && !item.creative.asset_feed_spec)) {
				throw new Error(`Cannot rule out a duplicate: creative for ad ${String(item.id)} is unavailable.`);
			}
			const existingVideos = collectVideoIds(item.creative);
			if (!scope.videoIds.some((id) => existingVideos.has(id))) continue;
			const destinations = collectDestinationUrls(item.creative);
			// Reworded offer copy is not reliable evidence of distinct intent. For
			// time-limited sales, block reused source video to the same landing
			// page inside the target set, even if the operation name changed.
			if (!destinations.length || destinations.some((url) => sameSalesLandingPage(url, scope.destination))) {
				throw new Error(`Potential duplicate source video on ad ${String(item.id)} in the target ad set. Inspect it by ID; nothing created.`);
			}
		}
		if (!response.paging?.next) return;
		const cursor = response.paging?.cursors?.after;
		if (typeof cursor !== "string" || !cursor || cursors.has(cursor)) {
			throw new Error("Meta ad duplicate inventory pagination is incomplete.");
		}
		cursors.add(cursor);
		after = cursor;
	}
	throw new Error("Meta ad duplicate inventory exceeded its safe page limit.");
}

function sameSalesLandingPage(left: string, right: string) {
	try {
		const a = new URL(left), b = new URL(right);
		return a.origin === b.origin && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "");
	} catch {
		return false;
	}
}

// The caller supplies an explicit offset, never an account- or server-local
// wall-clock date. Compare instants, not provider-specific display offsets.
function normalizeMetaAdCutoff(value: string, now = Date.now()) {
	const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(Z|[+-]\d{2}:\d{2})$/.exec(value);
	if (!match) throw new Error("Ad cutoff must be RFC 3339 with explicit time zone and whole seconds.");
	const wall = Date.parse(`${match[1]}T${match[2]}Z`);
	const stamp = Date.parse(value);
	if (!Number.isFinite(wall) || !Number.isFinite(stamp) || new Date(wall).toISOString().slice(0, 19) !== `${match[1]}T${match[2]}` || stamp <= now) {
		throw new Error("Ad cutoff is not a valid future instant.");
	}
	return new Date(stamp).toISOString().replace(".000Z", "Z");
}

function metaAdCutoffMatches(observed: unknown, expected: string) {
	// Graph usually returns ISO with a numeric offset without a colon.
	if (typeof observed !== "string") return false;
	const strict = observed.replace(/\.000(?=Z|[+-])/, "").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
	try { return normalizeMetaAdCutoff(strict, 0) === expected; } catch { return false; }
}

async function readOwnedAdSchedule(id: string, expectedWhenSupported: boolean) {
	try {
		const ad = await assertAccountObject(id, "ad", META_AD_SCHEDULE_FIELD);
		const schedule = ad[META_AD_SCHEDULE_FIELD];
		if (schedule !== undefined && schedule !== null && (typeof schedule !== "string" || !schedule)) {
			throw new Error("Meta returned an invalid ad schedule field.");
		}
		return { supported: true, cutoff: (schedule ?? null) as string | null };
	} catch (error) {
		// A version which explicitly rejects this single field can still
		// serve old, non-timed workflows. Never swallow auth/ownership/errors
		// or downgrade a request for a known deadline.
		const message = error instanceof Error ? error.message : String(error);
		if (!expectedWhenSupported && /code=100\b/.test(message) &&
			/(?:nonexisting|unknown) field/i.test(message) && message.includes(META_AD_SCHEDULE_FIELD)) {
			return { supported: false, cutoff: null };
		}
		throw error;
	}
}

async function inspectExactOwnedSalesAd(adId: string, adsetId: string, campaignId: string, expectedCampaignName: string) {
	// A dashboard-only draft may have a UI ID but does not resolve as a
	// Graph ad. This path never publishes, converts or replaces it.
	const [ad, adset, campaign] = await Promise.all([
		assertAccountObject(adId, "ad", "status,effective_status,adset_id,campaign_id,creative{id,name,object_story_spec,asset_feed_spec,url_tags}"),
		assertAccountObject(adsetId, "adset", "status,effective_status,campaign_id"),
		assertAccountObject(campaignId, "campaign", "status,effective_status,objective"),
	]);
	if (String(ad.adset_id) !== adsetId || String(ad.campaign_id) !== campaignId ||
		String(adset.campaign_id) !== campaignId || campaign.name !== expectedCampaignName || campaign.objective !== "OUTCOME_SALES") {
		throw new Error("Meta ad, ad-set or sales campaign did not match the requested parents.");
	}
	const schedule = await readOwnedAdSchedule(adId, false);
	return {
		graph_visible: true,
		read_only: true,
		ad: {
			id: ad.id, name: ad.name, status: ad.status, effective_status: ad.effective_status,
			creative_id: ad.creative?.id ?? null,
			video_ids: [...collectVideoIds(ad.creative)],
			destination_urls: collectDestinationUrls(ad.creative),
			ad_schedule_end_time: schedule.cutoff, schedule_field_supported: schedule.supported,
		},
		adset: { id: adset.id, name: adset.name, status: adset.status, effective_status: adset.effective_status },
		campaign: { id: campaign.id, name: campaign.name, status: campaign.status, effective_status: campaign.effective_status },
	};
}

function collectStringsByKey(value: unknown, keys: Set<string>, results: string[] = []) {
	if (Array.isArray(value)) {
		for (const item of value) collectStringsByKey(item, keys, results);
		return results;
	}
	if (!value || typeof value !== "object") return results;
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (keys.has(key) && typeof item === "string") results.push(item);
		collectStringsByKey(item, keys, results);
	}
	return results;
}

function collectVideoIds(creative: any) {
	return new Set(collectStringsByKey(creative, new Set(["video_id"])));
}

function collectDestinationUrls(creative: any) {
	const candidates = collectStringsByKey(
		creative,
		new Set(["link", "website_url", "url", "link_url"]),
	);
	return [...new Set(candidates.filter((candidate) => {
		try {
			return new URL(candidate).protocol.startsWith("http");
		} catch {
			return false;
		}
	}))];
}

function checkUtm(urlValue: string, urlTags = "") {
	const url = new URL(urlValue);
	for (const [key, value] of new URLSearchParams(urlTags)) {
		if (!url.searchParams.has(key)) url.searchParams.set(key, value);
	}
	const required = ["utm_source", "utm_medium", "utm_campaign", "utm_content"];
	return {
		url: url.toString(),
		missing_utm_parameters: required.filter((key) => !url.searchParams.get(key)),
	};
}

function buildMetaCreativeDiagnostic(
	stage: "create_single_video_creative" | "create_placement_video_creative",
	destinationUrl: string,
	urlTags: string,
	videoIds: string[],
) {
	const destination = new URL(destinationUrl);
	return {
		stage,
		destination_origin: destination.origin,
		destination_pathname: destination.pathname,
		destination_query_keys: [...new Set(destination.searchParams.keys())].sort(),
		url_tag_keys: [...new Set(new URLSearchParams(urlTags).keys())].sort(),
		video_ids: [...videoIds],
	};
}

async function createWebsiteSalesVideoCreative(input: {
	name: string;
	pageId: string;
	videoId: string;
	primaryText: string;
	headline: string;
	description?: string;
	ctaType: "SHOP_NOW" | "LEARN_MORE" | "SIGN_UP";
	destinationUrl: string;
	urlTags: string;
}) {
	const { adAccountId } = getToolkitMetaConfig();
	const instagramUserId = await resolveInstagramUserId(input.pageId);
	const videoData: Record<string, unknown> = {
		video_id: input.videoId,
		message: input.primaryText,
		title: input.headline,
		call_to_action: {
			type: input.ctaType,
			value: { link: input.destinationUrl },
		},
	};
	if (input.description) videoData.link_description = input.description;
	return toolkitMetaPost(
		`${adAccountId}/adcreatives`,
		{
			name: `${input.name} | Creative`,
			object_story_spec: JSON.stringify({
				page_id: input.pageId,
				instagram_user_id: instagramUserId,
				video_data: videoData,
			}),
			url_tags: input.urlTags || undefined,
		},
		buildMetaCreativeDiagnostic(
			"create_single_video_creative",
			input.destinationUrl,
			input.urlTags,
			[input.videoId],
		),
	);
}

async function createWebsiteSalesPlacementCreative(input: {
	name: string;
	pageId: string;
	video4x5Id: string;
	video9x16Id: string;
	primaryText: string;
	headline: string;
	description?: string;
	ctaType: "SHOP_NOW" | "LEARN_MORE" | "SIGN_UP";
	destinationUrl: string;
	urlTags: string;
}) {
	const { adAccountId } = getToolkitMetaConfig();
	const instagramUserId = await resolveInstagramUserId(input.pageId);
	const assetFeedSpec = {
		optimization_type: "PLACEMENT",
		ad_formats: ["SINGLE_VIDEO"],
		bodies: [{ text: input.primaryText }],
		titles: [{ text: input.headline }],
		descriptions: input.description ? [{ text: input.description }] : [],
		videos: [
			{ video_id: input.video4x5Id, adlabels: [{ name: "video_feed_4x5" }] },
			{ video_id: input.video9x16Id, adlabels: [{ name: "video_vertical_9x16" }] },
		],
		link_urls: [{ website_url: input.destinationUrl }],
		call_to_action_types: [input.ctaType],
		asset_customization_rules: [
			{
				customization_spec: {
					publisher_platforms: ["facebook", "instagram"],
					facebook_positions: ["feed", "search"],
					instagram_positions: ["stream", "explore", "profile_feed"],
				},
				video_label: { name: "video_feed_4x5" },
				priority: 1,
			},
			{
				customization_spec: {
					publisher_platforms: ["facebook", "instagram"],
					facebook_positions: ["story", "facebook_reels"],
					instagram_positions: ["story", "reels"],
				},
				video_label: { name: "video_vertical_9x16" },
				priority: 2,
			},
		],
	};
	return toolkitMetaPost(
		`${adAccountId}/adcreatives`,
		{
			name: `${input.name} | Creative`,
			object_story_spec: JSON.stringify({
				page_id: input.pageId,
				instagram_user_id: instagramUserId,
			}),
			asset_feed_spec: JSON.stringify(assetFeedSpec),
			url_tags: input.urlTags || undefined,
		},
		buildMetaCreativeDiagnostic(
			"create_placement_video_creative",
			input.destinationUrl,
			input.urlTags,
			[input.video4x5Id, input.video9x16Id],
		),
	);
}

async function createPausedAd(adsetId: string, name: string, creativeId: string, cutoff?: string, campaignId?: string) {
	const { adAccountId } = getToolkitMetaConfig();
	const created = await toolkitMetaPost(`${adAccountId}/ads`, {
		name,
		adset_id: adsetId,
		status: "PAUSED",
		creative: JSON.stringify({ creative_id: creativeId }),
		[META_AD_SCHEDULE_FIELD]: cutoff,
	});
	const createdId = String(created?.id ?? "");
	if (!/^\d+$/.test(createdId)) throw new Error("Meta did not return an ad ID. Inspect the target set before retrying; creation may have occurred.");
	let verified: Awaited<ReturnType<typeof assertAccountObject>>;
	try {
		verified = await assertAccountObject(
			createdId,
			"ad",
			`adset_id,campaign_id,status,effective_status,creative{id,name,object_story_spec,asset_feed_spec,url_tags}${cutoff ? `,${META_AD_SCHEDULE_FIELD}` : ""}`,
		);
	} catch {
		throw new Error(`Meta returned created ad ID ${createdId}, but readback failed. Inspect that exact ID; do not retry creation or activate it.`);
	}
	if (verified.status !== "PAUSED" || String(verified.adset_id) !== adsetId) {
		throw new Error(`Ad ${createdId} failed PAUSED/ad-set verification. Inspect that exact ID; do not retry or activate it.`);
	}
	if (cutoff && (verified.name !== name || String(verified.campaign_id) !== campaignId || String(verified.creative?.id) !== creativeId)) {
		throw new Error(`Ad ${createdId} was created, but exact identity did not verify; inspect that ID and do not retry or activate.`);
	}
	if (cutoff && !metaAdCutoffMatches(verified[META_AD_SCHEDULE_FIELD], cutoff)) {
		throw new Error(`Ad ${String(verified.id)} was created PAUSED, but its provider cutoff did not verify; inspect that ID, do not recreate or activate.`);
	}
	return verified;
}

async function fetchCampaignStructure(campaignId: string) {
	const campaign = await assertAccountObject(
		campaignId,
		"campaign",
		"status,effective_status,objective,daily_budget,lifetime_budget,bid_strategy,special_ad_categories",
	);
	const { adAccountId } = getToolkitMetaConfig();
	const adsetResponse = await toolkitMetaRequest(`${adAccountId}/adsets`, "GET", {
		fields:
			"id,name,account_id,campaign_id,status,effective_status,destination_type,optimization_goal,promoted_object,targeting,daily_budget,lifetime_budget,bid_strategy",
		limit: META_MAX_LIST_ITEMS,
	});
	const adsets = (adsetResponse?.data ?? []).filter(
		(item: any) => String(item.campaign_id) === campaignId,
	);
	const adResponse = await toolkitMetaRequest(`${adAccountId}/ads`, "GET", {
		fields:
			"id,name,account_id,adset_id,campaign_id,status,effective_status,creative{id,name,object_story_spec,asset_feed_spec,url_tags,status}",
		limit: META_MAX_LIST_ITEMS,
	});
	const ads = (adResponse?.data ?? []).filter((item: any) => String(item.campaign_id) === campaignId);
	return { campaign, adsets, ads };
}

async function buildPreflight(campaignId: string, expectedCampaignName: string) {
	const { campaign, adsets, ads } = await fetchCampaignStructure(campaignId);
	const blockers: string[] = [];
	const warnings: string[] = [];
	if (campaign.name !== expectedCampaignName) blockers.push("Campaign name does not match expected_campaign_name.");
	if (campaign.objective !== "OUTCOME_SALES") blockers.push("Campaign objective is not OUTCOME_SALES.");
	if (campaign.status !== "PAUSED") blockers.push("Campaign must be PAUSED for reviewed launch.");
	if (!campaign.daily_budget && !campaign.lifetime_budget) {
		const missingAdsetBudget = adsets.some((item: any) => !item.daily_budget && !item.lifetime_budget);
		if (missingAdsetBudget) blockers.push("Neither campaign nor every ad set has a budget.");
	}
	if (!adsets.length) blockers.push("Campaign has no ad sets.");
	if (!ads.length) blockers.push("Campaign has no ads.");

	const videoIds = new Set<string>();
	const destinationChecks: any[] = [];
	for (const adset of adsets) {
		if (adset.status !== "PAUSED") blockers.push(`Ad set ${adset.id} is not PAUSED.`);
		if (adset.destination_type !== "WEBSITE" || adset.optimization_goal !== "OFFSITE_CONVERSIONS") {
			blockers.push(`Ad set ${adset.id} is not WEBSITE / OFFSITE_CONVERSIONS.`);
		}
		const countries = adset.targeting?.geo_locations?.countries ?? [];
		if (!Array.isArray(countries) || countries.length !== 1 || countries[0] !== "AU") {
			blockers.push(`Ad set ${adset.id} targeting is not restricted to Australia.`);
		}
		if (!adset.promoted_object?.pixel_id) blockers.push(`Ad set ${adset.id} has no promoted pixel.`);
	}
	for (const ad of ads) {
		if (ad.status !== "PAUSED") blockers.push(`Ad ${ad.id} is not PAUSED.`);
		if (!ad.creative?.id) blockers.push(`Ad ${ad.id} has no creative.`);
		for (const id of collectVideoIds(ad.creative)) videoIds.add(id);
		const urls = collectDestinationUrls(ad.creative);
		if (!urls.length) blockers.push(`Ad ${ad.id} creative has no website destination URL.`);
		for (const url of urls) {
			try {
				const validated = buildMetaDestination(url, {});
				const creativeUrlTags = String(ad.creative?.url_tags ?? "");
				const combinedUrlTags = [validated.urlTags, creativeUrlTags]
					.filter(Boolean)
					.join("&");
				const utm = checkUtm(validated.destinationUrl, combinedUrlTags);
				destinationChecks.push({ ad_id: ad.id, ...utm });
				if (utm.missing_utm_parameters.length) {
					warnings.push(
						`Ad ${ad.id} is missing UTM parameters: ${utm.missing_utm_parameters.join(", ")}.`,
					);
				}
			} catch (error) {
				blockers.push(`Ad ${ad.id} has an invalid destination: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	if (!videoIds.size) blockers.push("No owned video assets were found in the campaign creatives.");
	const ownedVideos: any[] = [];
	for (const videoId of [...videoIds].sort()) {
		try {
			ownedVideos.push(await assertOwnedVideo(videoId));
		} catch (ownedError) {
			try {
				ownedVideos.push(await assertCreativeAttachedVideoReady(videoId));
				warnings.push(
					`Video ${videoId} is a Meta placement derivative attached to an owned ad creative; source ownership was validated at guarded ad creation.`,
				);
			} catch {
				blockers.push(ownedError instanceof Error ? ownedError.message : String(ownedError));
			}
		}
	}
	const normalized = {
		campaign: {
			id: String(campaign.id),
			name: String(campaign.name),
			status: String(campaign.status),
			objective: String(campaign.objective),
			daily_budget: campaign.daily_budget ?? null,
			lifetime_budget: campaign.lifetime_budget ?? null,
		},
		adsets: adsets
			.map((item: any) => ({
				id: String(item.id),
				name: String(item.name),
				status: String(item.status),
				destination_type: item.destination_type ?? null,
				optimization_goal: item.optimization_goal ?? null,
				pixel_id: item.promoted_object?.pixel_id ? String(item.promoted_object.pixel_id) : null,
				countries: item.targeting?.geo_locations?.countries ?? [],
				daily_budget: item.daily_budget ?? null,
				lifetime_budget: item.lifetime_budget ?? null,
			}))
			.sort((a: any, b: any) => a.id.localeCompare(b.id)),
		ads: ads
			.map((item: any) => ({
				id: String(item.id),
				name: String(item.name),
				adset_id: String(item.adset_id),
				status: String(item.status),
				creative_id: item.creative?.id ? String(item.creative.id) : null,
				video_ids: [...collectVideoIds(item.creative)].sort(),
				destination_urls: collectDestinationUrls(item.creative).sort(),
			}))
			.sort((a: any, b: any) => a.id.localeCompare(b.id)),
	};
	const planSha256 = await toolkitSha256Hex(new TextEncoder().encode(JSON.stringify(normalized)));
	return {
		ready: blockers.length === 0,
		blockers,
		warnings: [...new Set(warnings)],
		plan_sha256: planSha256,
		normalized,
		destination_checks: destinationChecks,
		owned_videos: ownedVideos,
	};
}

async function setMetaStatus(id: string, status: "ACTIVE" | "PAUSED") {
	await toolkitMetaPost(id, { status });
	return toolkitMetaGet(id, "id,name,account_id,status,effective_status");
}

const utmSchema = z.object({
	source: z.string().trim().min(1).max(200).optional(),
	medium: z.string().trim().min(1).max(200).optional(),
	campaign: z.string().trim().min(1).max(200).optional(),
	content: z.string().trim().min(1).max(200).optional(),
	term: z.string().trim().min(1).max(200).optional(),
});

const websiteAdCopySchema = {
	page_id: z.string().regex(/^\d+$/),
	name: z.string().trim().min(3).max(200),
	primary_text: z.string().trim().min(1).max(5000),
	headline: z.string().trim().min(1).max(255),
	description: z.string().trim().max(255).optional(),
	cta_type: z.enum(["SHOP_NOW", "LEARN_MORE", "SIGN_UP"]).default("SHOP_NOW"),
	destination_url: z.string().url(),
	utm: utmSchema,
};

export function registerMetaEcommerceToolkit(server: McpServer) {
	server.registerTool(
		"upload_meta_ad_video_from_url_guarded",
		{
			description:
				"Guarded Blindmotion Meta video intake. PERMIT issues a short-lived single-use Worker upload permit for one MP4/MOV. URL retains the temporary oaiusercontent.com fetch path as a fallback. This tool cannot create or activate ads or campaigns.",
			inputSchema: z.discriminatedUnion("action", [
				z.object({
					action: z.literal("permit"),
					title: z.string().trim().min(1).max(255),
					filename: z.string().trim().min(5).max(200),
					mime_type: z.enum(["video/mp4", "video/quicktime"]),
					file_size: z.number().int().positive().max(META_MAX_HOST_VIDEO_FILE_BYTES),
					confirmation: z.literal(META_RESUMABLE_VIDEO_UPLOAD_CONFIRMATION),
				}),
				z.object({
					action: z.literal("url"),
					title: z.string().trim().min(1).max(255),
					filename: z.string().trim().min(5).max(200),
					mime_type: z.enum(["video/mp4", "video/quicktime"]),
					file_size: z.number().int().positive().max(META_MAX_HOST_VIDEO_FILE_BYTES),
					source_url: z.string().url(),
					confirmation: z.literal(META_RESUMABLE_VIDEO_UPLOAD_CONFIRMATION),
				}),
			]),
		},
		async (args) => {
			try {
				const safeFilename = safeVideoFilename(args.filename, args.mime_type);
				const existing = (await listAccountVideos()).filter(
					(item: any) => String(item?.title ?? "") === args.title,
				);
				if (args.action === "permit" && existing.length === 1) {
					return textResult({
						action: "existing",
						uploaded: true,
						video_id: String(existing[0]?.id ?? ""),
						processing_complete: existing[0]?.status?.processing_phase?.status === "complete",
						filename: safeFilename,
						mime_type: args.mime_type,
						file_size: args.file_size,
						ad_or_campaign_created: false,
						activation_performed: false,
					});
				}
				if (existing.length) {
					throw new Error(`Refusing upload: ${existing.length} owned video(s) already use this exact title.`);
				}
				if (args.action === "permit") {
					const workerEnv = env as unknown as {
						OAUTH_KV?: KVNamespace;
					};
					if (!workerEnv.OAUTH_KV) throw new Error("Media Intake permit store is unavailable.");
					const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
					const token = Array.from(tokenBytes, byte => byte.toString(16).padStart(2, "0")).join("");
					const permit = {
						title: args.title,
						filename: safeFilename,
						mime_type: args.mime_type,
						file_size: args.file_size,
						created_at: Date.now(),
					};
					await workerEnv.OAUTH_KV.put(`media-intake-upload:${token}`, JSON.stringify(permit), {
						expirationTtl: 600,
					});
					return textResult({
						action: "permit",
						upload_url: "https://remote-mcp-server-authless2.phil-cd4.workers.dev/media-intake/video",
						upload_token: token,
						expires_in_seconds: 600,
						filename: safeFilename,
						mime_type: args.mime_type,
						file_size: args.file_size,
						ad_or_campaign_created: false,
						activation_performed: false,
					});
				}
				const source = new URL(args.source_url);
				if (
					source.protocol !== "https:" ||
					(source.hostname !== "oaiusercontent.com" && !source.hostname.endsWith(".oaiusercontent.com")) ||
					source.username ||
					source.password ||
					source.hash
				) {
					throw new Error("source_url must be a credential-free HTTPS URL on oaiusercontent.com.");
				}
				const { adAccountId } = getToolkitMetaConfig();
				const uploaded = await toolkitMetaPost(`${adAccountId}/advideos`, {
					file_url: source.toString(),
					title: args.title,
				});
				const videoId = String(uploaded?.id ?? uploaded?.video_id ?? "");
				if (!/^\d+$/.test(videoId)) throw new Error("Meta did not return a video ID for URL upload.");
				const visibleVideo = (await listAccountVideos()).find(
					(item: any) => String(item?.id) === videoId,
				);
				return textResult({
					action: "url",
					uploaded: true,
					video_id: videoId,
					filename: safeFilename,
					mime_type: args.mime_type,
					file_size: args.file_size,
					visible_as_owned_ad_account_video: Boolean(visibleVideo),
					processing_complete: visibleVideo?.status?.processing_phase?.status === "complete",
					video: visibleVideo ? { ...visibleVideo, derived_dimensions: derivedVideoDimensions(visibleVideo) } : null,
					ad_or_campaign_created: false,
					activation_performed: false,
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	server.registerTool(
		"get_meta_ad_video_resumable_upload_status",
		{
			description:
				"Read-only status check for an exact video ID and title in the configured ad account after resumable upload.",
			inputSchema: z.object({
				video_id: z.string().regex(/^\d+$/),
				expected_title: z.string().trim().min(1).max(255),
			}),
		},
		async ({ video_id, expected_title }) => {
			try {
				const video = (await listAccountVideos()).find(
					(item: any) => String(item?.id) === video_id,
				);
				if (!video) {
					return textResult({
						video_id,
						visible_as_owned_ad_account_video: false,
						ready: false,
						read_only: true,
					});
				}
				if (String(video.title ?? "") !== expected_title) {
					throw new Error("Visible video title does not match expected_title.");
				}
				const ready =
					video?.status?.video_status === "ready" &&
					video?.status?.processing_phase?.status === "complete";
				return textResult({
					video_id,
					visible_as_owned_ad_account_video: true,
					ready,
					video: { ...video, derived_dimensions: derivedVideoDimensions(video) },
					read_only: true,
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	server.registerTool(
		"create_meta_website_sales_video_ad_paused",
		{
			description:
				"Create one PAUSED website-sales video ad from an explicitly validated owned Meta video. Parent campaign/ad set may be ACTIVE or PAUSED but must have a verified OUTCOME_SALES website destination. Supports same-site UTM tracking and cannot activate delivery.",
			inputSchema: z.object({
				adset_id: z.string().regex(/^\d+$/),
				video_id: z.string().regex(/^\d+$/),
				expected_video_title: z.string().max(255),
				...websiteAdCopySchema,
				ad_schedule_end_time: z.string().max(35).optional(),
				known_existing_ad_id: z.string().regex(/^\d+$/).optional(),
				confirmation: z.literal(META_ECOMMERCE_AD_CREATE_CONFIRMATION),
			}),
		},
		async ({ adset_id, video_id, expected_video_title, page_id, name, primary_text, headline, description, cta_type, destination_url, utm, ad_schedule_end_time, known_existing_ad_id }) => {
			try {
				if (known_existing_ad_id) throw new Error(`Ad ${known_existing_ad_id} was supplied as existing. Inspect it by ID, not via create.`);
				const cutoff = ad_schedule_end_time === undefined ? undefined : normalizeMetaAdCutoff(ad_schedule_end_time);
				const { campaign } = await assertSalesAdsetForCreation(adset_id, destination_url);
				await assertOwnedPage(page_id);
				await assertOwnedVideo(video_id, { title: expected_video_title });
				const tracking = buildMetaDestination(destination_url, utm);
				await refuseDuplicateAdName(name, cutoff ? { adsetId: adset_id, videoIds: [video_id], destination: tracking.destinationUrl } : undefined);
				const creative = await createWebsiteSalesVideoCreative({
					name,
					pageId: page_id,
					videoId: video_id,
					primaryText: primary_text,
					headline,
					description,
					ctaType: cta_type,
					destinationUrl: tracking.destinationUrl,
					urlTags: tracking.urlTags,
				});
				if (!creative?.id) throw new Error("Meta did not return a creative ID.");
				const ad = await createPausedAd(adset_id, name, String(creative.id), cutoff, String(campaign.id));
				if (!collectVideoIds(ad.creative).has(video_id)) {
					throw new Error(`Ad ${String(ad.id)} did not verify against the intended video. Inspect that exact ID; do not retry or activate it.`);
				}
				return textResult({
					created: true,
					activation_performed: false,
					tracked_url: tracking.trackedUrl,
					tracking_transport: "url_tags",
					ad,
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	server.registerTool(
		"create_meta_website_sales_placement_video_ad_paused",
		{
			description:
				"Create one PAUSED website-sales ad with an exact owned 4:5 video for feeds and exact owned 9:16 video for Stories/Reels. Validates titles, upload times, durations and dimensions, supports same-site UTM tracking, and cannot activate delivery.",
			inputSchema: z.object({
				adset_id: z.string().regex(/^\d+$/),
				video_4x5_id: z.string().regex(/^\d+$/),
				video_4x5_expected_name: z.string().min(1).max(300),
				video_4x5_expected_created_time: z.string().min(20).max(40),
				video_4x5_expected_length_seconds: z.number().positive().max(600),
				video_4x5_expected_width: z.number().int().positive().max(10000),
				video_4x5_expected_height: z.number().int().positive().max(10000),
				video_9x16_id: z.string().regex(/^\d+$/),
				video_9x16_expected_name: z.string().min(1).max(300),
				video_9x16_expected_created_time: z.string().min(20).max(40),
				video_9x16_expected_length_seconds: z.number().positive().max(600),
				video_9x16_expected_width: z.number().int().positive().max(10000),
				video_9x16_expected_height: z.number().int().positive().max(10000),
				...websiteAdCopySchema,
				ad_schedule_end_time: z.string().max(35).optional(),
				known_existing_ad_id: z.string().regex(/^\d+$/).optional(),
				confirmation: z.literal(META_ECOMMERCE_AD_CREATE_CONFIRMATION),
			}),
		},
		async (args) => {
			try {
				if (args.known_existing_ad_id) throw new Error(`Ad ${args.known_existing_ad_id} was supplied as existing. Inspect it by ID, not via create.`);
				const cutoff = args.ad_schedule_end_time === undefined ? undefined : normalizeMetaAdCutoff(args.ad_schedule_end_time);
				const { campaign } = await assertSalesAdsetForCreation(args.adset_id, args.destination_url);
				await assertOwnedPage(args.page_id);
				await assertOwnedVideo(args.video_4x5_id, {
					title: args.video_4x5_expected_name,
					createdTime: args.video_4x5_expected_created_time,
					lengthSeconds: args.video_4x5_expected_length_seconds,
					width: args.video_4x5_expected_width,
					height: args.video_4x5_expected_height,
				});
				await assertOwnedVideo(args.video_9x16_id, {
					title: args.video_9x16_expected_name,
					createdTime: args.video_9x16_expected_created_time,
					lengthSeconds: args.video_9x16_expected_length_seconds,
					width: args.video_9x16_expected_width,
					height: args.video_9x16_expected_height,
				});
				const tracking = buildMetaDestination(args.destination_url, args.utm);
				await refuseDuplicateAdName(args.name, cutoff ? { adsetId: args.adset_id, videoIds: [args.video_4x5_id, args.video_9x16_id], destination: tracking.destinationUrl } : undefined);
				const creative = await createWebsiteSalesPlacementCreative({
					name: args.name,
					pageId: args.page_id,
					video4x5Id: args.video_4x5_id,
					video9x16Id: args.video_9x16_id,
					primaryText: args.primary_text,
					headline: args.headline,
					description: args.description,
					ctaType: args.cta_type,
					destinationUrl: tracking.destinationUrl,
					urlTags: tracking.urlTags,
				});
				if (!creative?.id) throw new Error("Meta did not return a creative ID.");
				const ad = await createPausedAd(args.adset_id, args.name, String(creative.id), cutoff, String(campaign.id));
				const creativeVideos = Array.isArray(ad.creative?.asset_feed_spec?.videos)
					? ad.creative.asset_feed_spec.videos
					: [];
				// Two labels alone do not verify that Meta kept the right video
				// in each placement after the create request.
				const matches = (label: string, videoId: string) => creativeVideos.filter((video: any) =>
					String(video?.video_id ?? "") === videoId &&
					Array.isArray(video?.adlabels) && video.adlabels.some((item: any) => item?.name === label)
				).length === 1;
				if (creativeVideos.length !== 2 ||
					!matches("video_feed_4x5", args.video_4x5_id) ||
					!matches("video_vertical_9x16", args.video_9x16_id) ||
					String(creativeVideos[0]?.video_id) === String(creativeVideos[1]?.video_id)) {
					throw new Error(`Ad ${String(ad.id)} did not verify both exact labeled placement videos. Inspect that exact ID; do not retry or activate it.`);
				}
				return textResult({
					created: true,
					activation_performed: false,
					tracked_url: tracking.trackedUrl,
					tracking_transport: "url_tags",
					source_video_ids: {
						feed_4x5: args.video_4x5_id,
						vertical_9x16: args.video_9x16_id,
					},
					ad,
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	server.registerTool(
		"set_meta_ad_status_guarded",
		{
			description:
				"Switch exactly one owned Meta ad between PAUSED and ACTIVE after exact ad/ad-set/campaign identity checks. Activation requires both parents already ACTIVE and exact verification of a future cutoff for scheduled ads. Cannot archive or delete.",
			inputSchema: z.object({
				ad_id: z.string().regex(/^\d+$/),
				expected_ad_name: z.string().trim().min(3).max(200),
				expected_adset_id: z.string().regex(/^\d+$/),
				expected_adset_name: z.string().trim().min(3).max(200),
				expected_campaign_id: z.string().regex(/^\d+$/),
				expected_campaign_name: z.string().trim().min(3).max(200),
				expected_current_status: z.enum(["PAUSED", "ACTIVE"]),
				new_status: z.enum(["PAUSED", "ACTIVE"]),
				expected_ad_schedule_end_time: z.string().max(35).optional(),
				confirmation: z.literal(META_AD_STATUS_CONFIRMATION),
			}),
		},
		async (args) => {
			try {
				if (args.expected_current_status === args.new_status) {
					throw new Error("new_status must differ from expected_current_status.");
				}
				const ad = await assertAccountObject(args.ad_id, "ad", "status,effective_status,adset_id,campaign_id");
				const adset = await assertAccountObject(args.expected_adset_id, "adset", "status,effective_status,campaign_id");
				const campaign = await assertAccountObject(args.expected_campaign_id, "campaign", "status,effective_status,objective");
				if (ad.name !== args.expected_ad_name || String(ad.adset_id) !== args.expected_adset_id || String(ad.campaign_id) !== args.expected_campaign_id) {
					throw new Error("Ad identity or parent IDs do not match the expected values.");
				}
				if (adset.name !== args.expected_adset_name || String(adset.campaign_id) !== args.expected_campaign_id) {
					throw new Error("Ad-set identity does not match expected values.");
				}
				if (campaign.name !== args.expected_campaign_name || campaign.objective !== "OUTCOME_SALES") {
					throw new Error("Campaign identity/objective does not match expected values.");
				}
				if (ad.status !== args.expected_current_status) throw new Error("Ad current status changed since review.");
				if (args.new_status === "ACTIVE" && (adset.status !== "ACTIVE" || campaign.status !== "ACTIVE")) {
					throw new Error("Ad activation requires ACTIVE campaign and ad set parents.");
				}
				let expectedCutoff: string | undefined;
				if (args.new_status === "ACTIVE") {
					expectedCutoff = args.expected_ad_schedule_end_time === undefined ? undefined : normalizeMetaAdCutoff(args.expected_ad_schedule_end_time);
					const schedule = await readOwnedAdSchedule(args.ad_id, expectedCutoff !== undefined);
					if (schedule.cutoff !== null && expectedCutoff === undefined) {
						throw new Error("Scheduled ads require the exact expected ad cutoff before activation.");
					}
					if (expectedCutoff && !metaAdCutoffMatches(schedule.cutoff, expectedCutoff)) {
						throw new Error("Ad cutoff changed or is unverified; activation refused.");
					}
				} else if (args.expected_ad_schedule_end_time !== undefined) {
					throw new Error("Do not include a future cutoff when pausing an ad.");
				}
				const verified = await setMetaStatus(args.ad_id, args.new_status);
				if (expectedCutoff) {
					try {
						const readback = await readOwnedAdSchedule(args.ad_id, true);
						if (!metaAdCutoffMatches(readback.cutoff, expectedCutoff)) throw new Error("Ad cutoff changed during activation.");
					} catch {
						// Only the exact previously owned ad is rolled back. No parent
						// or sibling status is touched if provider readback goes stale.
						const rollback = await setMetaStatus(args.ad_id, "PAUSED").catch(() => null);
						throw new Error(`Activation cutoff readback failed for ad ${args.ad_id}; rollback ${rollback?.status === "PAUSED" ? "verified PAUSED" : "not verified; inspect ad immediately"}.`);
					}
				}
				if (verified.status !== args.new_status) throw new Error("Meta did not apply the requested ad status.");
				return textResult({ changed: true, deleted: false, archived: false, ad: verified });
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	server.registerTool(
		"inspect_meta_ecommerce_campaign_prelaunch",
		{
			description:
				"Read-only pre-launch inspection of one owned Meta ecommerce sales campaign. Verifies paused state, AU website-sales ad sets, pixels, owned videos, same-site destinations and reports UTM gaps. Returns a hash-locked plan for guarded launch; supplying both ad_id and expected_adset_id instead reads one exact Graph ad, its creative, parents and individual cutoff without publishing UI drafts.",
			inputSchema: z.object({
				campaign_id: z.string().regex(/^\d+$/),
				expected_campaign_name: z.string().trim().min(3).max(200),
				ad_id: z.string().regex(/^\d+$/).optional(),
				expected_adset_id: z.string().regex(/^\d+$/).optional(),
			}),
		},
		async ({ campaign_id, expected_campaign_name, ad_id, expected_adset_id }) => {
			try {
				if (ad_id !== undefined || expected_adset_id !== undefined) {
					if (!ad_id || !expected_adset_id) throw new Error("Exact ad inspection requires both ad_id and expected_adset_id.");
					return textResult(await inspectExactOwnedSalesAd(ad_id, expected_adset_id, campaign_id, expected_campaign_name));
				}
				return textResult(await buildPreflight(campaign_id, expected_campaign_name));
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	server.registerTool(
		"launch_meta_ecommerce_campaign_guarded",
		{
			description:
				"Activate one fully reviewed PAUSED OUTCOME_SALES ecommerce campaign, its exact website-sales ad sets and exact ads only when a fresh preflight matches the caller-supplied SHA-256. Rolls touched objects back to PAUSED on failure.",
			inputSchema: z.object({
				campaign_id: z.string().regex(/^\d+$/),
				expected_campaign_name: z.string().trim().min(3).max(200),
				expected_preflight_sha256: z.string().regex(/^[a-f0-9]{64}$/),
				confirmation: z.literal(META_ECOMMERCE_LAUNCH_CONFIRMATION),
			}),
		},
		async ({ campaign_id, expected_campaign_name, expected_preflight_sha256 }) => {
			const touched: Array<{ id: string; type: "campaign" | "adset" | "ad" }> = [];
			try {
				const preflight = await buildPreflight(campaign_id, expected_campaign_name);
				if (!preflight.ready) throw new Error(`Preflight has blockers: ${preflight.blockers.join(" | ")}`);
				if (preflight.plan_sha256 !== expected_preflight_sha256) {
					throw new Error("Preflight SHA-256 changed since review; inspect again before launch.");
				}
				await setMetaStatus(campaign_id, "ACTIVE");
				touched.push({ id: campaign_id, type: "campaign" });
				for (const adset of preflight.normalized.adsets) {
					await setMetaStatus(adset.id, "ACTIVE");
					touched.push({ id: adset.id, type: "adset" });
				}
				for (const ad of preflight.normalized.ads) {
					await setMetaStatus(ad.id, "ACTIVE");
					touched.push({ id: ad.id, type: "ad" });
				}
				const after = await fetchCampaignStructure(campaign_id);
				if (
					after.campaign.status !== "ACTIVE" ||
					after.adsets.some((item: any) => item.status !== "ACTIVE") ||
					after.ads.some((item: any) => item.status !== "ACTIVE")
				) {
					throw new Error("Post-launch verification found a non-ACTIVE object.");
				}
				return textResult({
					launched: true,
					campaign_id,
					preflight_sha256: expected_preflight_sha256,
					activated_adsets: preflight.normalized.adsets.map((item: any) => item.id),
					activated_ads: preflight.normalized.ads.map((item: any) => item.id),
					warnings: preflight.warnings,
				});
			} catch (error) {
				const rollbackErrors: string[] = [];
				for (const item of [...touched].reverse()) {
					try {
						await setMetaStatus(item.id, "PAUSED");
					} catch (rollbackError) {
						rollbackErrors.push(
							`${item.type} ${item.id}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
						);
					}
				}
				const base = error instanceof Error ? error.message : String(error);
				return errorResult(
					new Error(
						rollbackErrors.length
							? `${base} Rollback also reported: ${rollbackErrors.join(" | ")}`
							: `${base} Any touched objects were rolled back to PAUSED.`,
					),
				);
			}
		},
	);
}
