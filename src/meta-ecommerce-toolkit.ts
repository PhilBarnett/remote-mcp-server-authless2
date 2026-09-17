import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const META_RESUMABLE_VIDEO_UPLOAD_CONFIRMATION = "CONFIRM UPLOAD META VIDEO BATCH";
const META_MAX_RESUMABLE_CHUNK_BYTES = 16_000_000;
const META_ECOMMERCE_AD_CREATE_CONFIRMATION = "CONFIRM CREATE PAUSED META ECOMMERCE AD";
const META_AD_STATUS_CONFIRMATION = "CONFIRM META AD STATUS CHANGE";
const META_ECOMMERCE_LAUNCH_CONFIRMATION = "CONFIRM LAUNCH META ECOMMERCE CAMPAIGN";
const META_MAX_LIST_ITEMS = 500;

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

async function toolkitMetaPost(path: string, params: Record<string, string | number | undefined>) {
	return toolkitMetaRequest(path, "POST", params);
}

async function toolkitSha256Hex(bytes: Uint8Array) {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeResumableChunk(value: string) {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
		throw new Error("chunk_base64 is not canonical base64 data.");
	}
	const binary = atob(value);
	if (binary.length < 1 || binary.length > META_MAX_RESUMABLE_CHUNK_BYTES) {
		throw new Error(
			`Video chunk must contain between 1 and ${META_MAX_RESUMABLE_CHUNK_BYTES} bytes.`,
		);
	}
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
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

function buildTrackedDestination(destinationUrl: string, utm: UtmInput) {
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
	for (const [key, value] of entries) {
		if (value === undefined || value.trim() === "") continue;
		if (value.length > 200 || /[\r\n]/.test(value)) throw new Error(`${key} is invalid.`);
		destination.searchParams.set(key, value.trim());
	}
	return destination.toString();
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

async function assertSalesAdsetForCreation(adsetId: string) {
	const adset = await assertAccountObject(
		adsetId,
		"adset",
		"campaign_id,status,effective_status,destination_type,optimization_goal,promoted_object,targeting,daily_budget,lifetime_budget",
	);
	if (adset.status !== "PAUSED") throw new Error("Website-sales ad creation requires a PAUSED parent ad set.");
	if (adset.destination_type !== "WEBSITE" || adset.optimization_goal !== "OFFSITE_CONVERSIONS") {
		throw new Error("Parent ad set is not a WEBSITE / OFFSITE_CONVERSIONS sales ad set.");
	}
	const campaign = await assertAccountObject(
		String(adset.campaign_id),
		"campaign",
		"status,effective_status,objective,daily_budget,lifetime_budget",
	);
	if (campaign.status !== "PAUSED" || campaign.objective !== "OUTCOME_SALES") {
		throw new Error("Parent campaign must be a PAUSED OUTCOME_SALES campaign.");
	}
	return { adset, campaign };
}

async function refuseDuplicateAdName(name: string) {
	const { adAccountId } = getToolkitMetaConfig();
	const response = await toolkitMetaRequest(`${adAccountId}/ads`, "GET", {
		fields: "id,name,status",
		limit: META_MAX_LIST_ITEMS,
	});
	if ((response?.data ?? []).some((item: any) => String(item.name ?? "") === name)) {
		throw new Error(`An ad named ${name} already exists in the configured ad account.`);
	}
}

function assertTrustedVideoSourceUrl(value: string) {
	const source = new URL(value);
	if (
		source.protocol !== "https:" ||
		(source.hostname !== "oaiusercontent.com" && !source.hostname.endsWith(".oaiusercontent.com")) ||
		source.username ||
		source.password ||
		source.hash
	) {
		throw new Error("source_url must be a credential-free HTTPS URL on oaiusercontent.com.");
	}
	return source.toString();
}

async function fetchVerifiedVideoSource(
	sourceUrl: string,
	expectedSize: number,
	expectedSha256: string,
) {
	const response = await fetch(assertTrustedVideoSourceUrl(sourceUrl), {
		headers: { Accept: "video/mp4,video/quicktime,application/octet-stream" },
	});
	if (!response.ok) {
		throw new Error(`Trusted video source download failed (${response.status}).`);
	}
	const declaredLength = response.headers.get("content-length");
	if (declaredLength && Number(declaredLength) !== expectedSize) {
		throw new Error("Trusted video source Content-Length does not match file_size.");
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length !== expectedSize) {
		throw new Error("Downloaded video byte length does not match file_size.");
	}
	const actualSha256 = await toolkitSha256Hex(bytes);
	if (actualSha256 !== expectedSha256) {
		throw new Error("Downloaded video SHA-256 does not match expected_sha256.");
	}
	return bytes;
}

async function uploadVerifiedVideoBytesResumable(
	bytes: Uint8Array,
	title: string,
) {
	const { accessToken, apiVersion, adAccountId } = getToolkitMetaConfig();
	const started = await toolkitMetaPost(`${adAccountId}/advideos`, {
		upload_phase: "start",
		file_size: bytes.length,
	});
	const videoId = String(started?.video_id ?? "");
	const uploadSessionId = String(started?.upload_session_id ?? "");
	let startOffset = String(started?.start_offset ?? "");
	let endOffset = String(started?.end_offset ?? "");
	if (
		!/^\d+$/.test(videoId) ||
		!/^\d+$/.test(uploadSessionId) ||
		!/^\d+$/.test(startOffset) ||
		!/^\d+$/.test(endOffset)
	) {
		throw new Error("Meta returned an invalid resumable upload session.");
	}

	while (startOffset !== endOffset) {
		const start = Number(startOffset);
		const end = Number(endOffset);
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(end) ||
			end <= start ||
			end > bytes.length ||
			end - start > META_MAX_RESUMABLE_CHUNK_BYTES
		) {
			throw new Error("Meta requested an invalid resumable upload byte range.");
		}
		const form = new FormData();
		form.set("upload_phase", "transfer");
		form.set("upload_session_id", uploadSessionId);
		form.set("start_offset", startOffset);
		form.set(
			"video_file_chunk",
			new Blob([bytes.slice(start, end)], { type: "application/octet-stream" }),
			"chunk.bin",
		);
		const response = await fetch(
			`https://graph.facebook.com/${apiVersion}/${adAccountId}/advideos`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
				body: form,
			},
		);
		const payload: any = await response.json().catch(() => ({}));
		if (!response.ok || payload?.error) {
			throw new Error(
				`Meta resumable chunk transfer failed (${response.status}): ${payload?.error?.message ?? "unknown error"}`,
			);
		}
		const nextStartOffset = String(payload?.start_offset ?? "");
		const nextEndOffset = String(payload?.end_offset ?? "");
		if (
			!/^\d+$/.test(nextStartOffset) ||
			!/^\d+$/.test(nextEndOffset) ||
			nextStartOffset !== endOffset ||
			Number(nextEndOffset) < Number(nextStartOffset)
		) {
			throw new Error("Meta returned unexpected resumable offsets.");
		}
		startOffset = nextStartOffset;
		endOffset = nextEndOffset;
	}
	if (Number(startOffset) !== bytes.length) {
		throw new Error("Meta upload offsets do not prove that the complete file was transferred.");
	}

	const finished = await toolkitMetaPost(`${adAccountId}/advideos`, {
		upload_phase: "finish",
		upload_session_id: uploadSessionId,
		title,
	});
	if (finished?.success !== true) {
		throw new Error("Meta did not confirm resumable upload completion.");
	}
	const visibleVideo = (await listAccountVideos()).find(
		(item: any) => String(item?.id) === videoId,
	);
	return {
		video_id: videoId,
		upload_session_id: uploadSessionId,
		final_offset: startOffset,
		visible_as_owned_ad_account_video: Boolean(visibleVideo),
		processing_complete: visibleVideo?.status?.processing_phase?.status === "complete",
		video: visibleVideo ? { ...visibleVideo, derived_dimensions: derivedVideoDimensions(visibleVideo) } : null,
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

function checkUtm(urlValue: string) {
	const url = new URL(urlValue);
	const required = ["utm_source", "utm_medium", "utm_campaign", "utm_content"];
	return {
		url: url.toString(),
		missing_utm_parameters: required.filter((key) => !url.searchParams.get(key)),
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
	return toolkitMetaPost(`${adAccountId}/adcreatives`, {
		name: `${input.name} | Creative`,
		object_story_spec: JSON.stringify({ page_id: input.pageId, instagram_user_id: instagramUserId, video_data: videoData }),
	});
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
	return toolkitMetaPost(`${adAccountId}/adcreatives`, {
		name: `${input.name} | Creative`,
		object_story_spec: JSON.stringify({ page_id: input.pageId, instagram_user_id: instagramUserId }),
		asset_feed_spec: JSON.stringify(assetFeedSpec),
	});
}

async function createPausedAd(adsetId: string, name: string, creativeId: string) {
	const { adAccountId } = getToolkitMetaConfig();
	const created = await toolkitMetaPost(`${adAccountId}/ads`, {
		name,
		adset_id: adsetId,
		status: "PAUSED",
		creative: JSON.stringify({ creative_id: creativeId }),
	});
	const verified = await assertAccountObject(
		String(created.id),
		"ad",
		"adset_id,campaign_id,status,effective_status,creative{id,name,object_story_spec,asset_feed_spec,url_tags}",
	);
	if (verified.status !== "PAUSED" || String(verified.adset_id) !== adsetId) {
		throw new Error("Created ad failed PAUSED/ad-set verification.");
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
				const validated = buildTrackedDestination(url, {});
				const utm = checkUtm(validated);
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
		} catch (error) {
			blockers.push(error instanceof Error ? error.message : String(error));
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
		"upload_meta_ad_video_from_trusted_url_guarded",
		{
			description:
				"Fetch one video from an expiring trusted OpenAI file URL, verify exact bytes and SHA-256, and complete Meta's resumable ad-account upload internally. Cannot create or activate ads.",
			inputSchema: z.object({
				source_url: z.string().url().max(4096),
				title: z.string().trim().min(1).max(255),
				filename: z.string().trim().min(5).max(200),
				mime_type: z.enum(["video/mp4", "video/quicktime"]),
				file_size: z.number().int().positive().max(100_000_000),
				expected_sha256: z.string().regex(/^[a-f0-9]{64}$/),
				confirmation: z.literal(META_RESUMABLE_VIDEO_UPLOAD_CONFIRMATION),
			}),
		},
		async ({ source_url, title, filename, mime_type, file_size, expected_sha256 }) => {
			try {
				safeVideoFilename(filename, mime_type);
				const bytes = await fetchVerifiedVideoSource(source_url, file_size, expected_sha256);
				const uploaded = await uploadVerifiedVideoBytesResumable(bytes, title);
				return textResult({
					uploaded: true,
					source_verified: true,
					source_manifest: { title, filename, mime_type, file_size, expected_sha256 },
					...uploaded,
					ad_or_campaign_created: false,
					activation_performed: false,
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	server.registerTool(
		"start_meta_ad_video_resumable_upload_guarded",
		{
			description:
				"Start one resumable video upload directly into the configured Meta ad account. Returns Meta-controlled byte offsets; cannot create or activate ads.",
			inputSchema: z.object({
				title: z.string().trim().min(1).max(255),
				filename: z.string().trim().min(5).max(200),
				mime_type: z.enum(["video/mp4", "video/quicktime"]),
				file_size: z.number().int().positive().max(2_000_000_000),
				expected_sha256: z.string().regex(/^[a-f0-9]{64}$/),
				confirmation: z.literal(META_RESUMABLE_VIDEO_UPLOAD_CONFIRMATION),
			}),
		},
		async ({ title, filename, mime_type, file_size, expected_sha256 }) => {
			try {
				const safeFilename = safeVideoFilename(filename, mime_type);
				const existing = (await listAccountVideos()).filter(
					(item: any) => String(item?.title ?? "") === title,
				);
				if (existing.length) {
					throw new Error(
						`Refusing resumable upload: ${existing.length} ad-account video(s) already use this exact title.`,
					);
				}
				const { adAccountId } = getToolkitMetaConfig();
				const started = await toolkitMetaPost(`${adAccountId}/advideos`, {
					upload_phase: "start",
					file_size,
				});
				const videoId = String(started?.video_id ?? "");
				const uploadSessionId = String(started?.upload_session_id ?? "");
				const startOffset = String(started?.start_offset ?? "");
				const endOffset = String(started?.end_offset ?? "");
				if (
					!/^\d+$/.test(videoId) ||
					!/^\d+$/.test(uploadSessionId) ||
					!/^\d+$/.test(startOffset) ||
					!/^\d+$/.test(endOffset) ||
					Number(endOffset) <= Number(startOffset)
				) {
					throw new Error("Meta did not return a valid resumable upload session.");
				}
				const requestedChunkBytes = Number(endOffset) - Number(startOffset);
				if (requestedChunkBytes > META_MAX_RESUMABLE_CHUNK_BYTES) {
					throw new Error(
						`Meta requested a ${requestedChunkBytes}-byte chunk, above the guarded ${META_MAX_RESUMABLE_CHUNK_BYTES}-byte limit.`,
					);
				}
				return textResult({
					started: true,
					ad_or_campaign_created: false,
					activation_performed: false,
					video_id: videoId,
					upload_session_id: uploadSessionId,
					start_offset: startOffset,
					end_offset: endOffset,
					source_manifest: {
						title,
						filename: safeFilename,
						mime_type,
						file_size,
						expected_sha256,
					},
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	server.registerTool(
		"transfer_meta_ad_video_resumable_chunk_guarded",
		{
			description:
				"Transfer exactly one hash-verified, Meta-requested byte range from canonical base64 or a trusted expiring OpenAI file URL to an existing resumable ad-account video upload. Retry-safe when the caller follows returned offsets.",
			inputSchema: z.object({
				video_id: z.string().regex(/^\d+$/),
				upload_session_id: z.string().regex(/^\d+$/),
				start_offset: z.string().regex(/^\d+$/),
				end_offset: z.string().regex(/^\d+$/),
				chunk_base64: z.string().min(4).max(22_000_000),
				expected_chunk_sha256: z.string().regex(/^[a-f0-9]{64}$/),
				confirmation: z.literal(META_RESUMABLE_VIDEO_UPLOAD_CONFIRMATION),
			}),
		},
		async ({
			video_id,
			upload_session_id,
			start_offset,
			end_offset,
			chunk_base64,
			expected_chunk_sha256,
		}) => {
			try {
				const start = Number(start_offset);
				const end = Number(end_offset);
				if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
					throw new Error("Invalid resumable upload byte offsets.");
				}
				let bytes: Uint8Array;
				if (chunk_base64.startsWith("https://")) {
					const sourceResponse = await fetch(assertTrustedVideoSourceUrl(chunk_base64), {
						headers: {
							Accept: "video/mp4,video/quicktime,application/octet-stream",
							Range: `bytes=${start}-${end - 1}`,
						},
					});
					if (!sourceResponse.ok) {
						throw new Error(`Trusted video source range download failed (${sourceResponse.status}).`);
					}
					const sourceBytes = new Uint8Array(await sourceResponse.arrayBuffer());
					if (sourceResponse.status === 206) {
						bytes = sourceBytes;
					} else {
						if (end > sourceBytes.length) {
							throw new Error("Requested chunk range exceeds the trusted video source length.");
						}
						bytes = sourceBytes.slice(start, end);
					}
				} else {
					bytes = decodeResumableChunk(chunk_base64);
				}
				if (bytes.length !== end - start) {
					throw new Error(
						`Chunk byte length ${bytes.length} does not match Meta-requested range ${start_offset}-${end_offset}.`,
					);
				}
				const actualChunkHash = await toolkitSha256Hex(bytes);
				if (actualChunkHash !== expected_chunk_sha256) {
					throw new Error("Video chunk SHA-256 does not match expected_chunk_sha256; nothing was transferred.");
				}
				const { accessToken, apiVersion, adAccountId } = getToolkitMetaConfig();
				const form = new FormData();
				form.set("upload_phase", "transfer");
				form.set("upload_session_id", upload_session_id);
				form.set("start_offset", start_offset);
				form.set("video_file_chunk", new Blob([bytes], { type: "application/octet-stream" }), "chunk.bin");
				const response = await fetch(
					`https://graph.facebook.com/${apiVersion}/${adAccountId}/advideos`,
					{
						method: "POST",
						headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
						body: form,
					},
				);
				const payload: any = await response.json().catch(() => ({}));
				if (!response.ok || payload?.error) {
					throw new Error(
						`Meta resumable chunk transfer failed (${response.status}): ${payload?.error?.message ?? "unknown error"}`,
					);
				}
				const nextStartOffset = String(payload?.start_offset ?? "");
				const nextEndOffset = String(payload?.end_offset ?? "");
				if (
					!/^\d+$/.test(nextStartOffset) ||
					!/^\d+$/.test(nextEndOffset) ||
					nextStartOffset !== end_offset ||
					Number(nextEndOffset) < Number(nextStartOffset)
				) {
					throw new Error("Meta returned unexpected resumable upload offsets after transfer.");
				}
				const nextChunkBytes = Number(nextEndOffset) - Number(nextStartOffset);
				if (nextChunkBytes > META_MAX_RESUMABLE_CHUNK_BYTES) {
					throw new Error(
						`Meta requested a ${nextChunkBytes}-byte next chunk, above the guarded limit.`,
					);
				}
				return textResult({
					transferred: true,
					video_id,
					upload_session_id,
					transferred_start_offset: start_offset,
					transferred_end_offset: end_offset,
					chunk_sha256: actualChunkHash,
					next_start_offset: nextStartOffset,
					next_end_offset: nextEndOffset,
					upload_complete: nextStartOffset === nextEndOffset,
					ad_or_campaign_created: false,
					activation_performed: false,
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	server.registerTool(
		"finish_meta_ad_video_resumable_upload_guarded",
		{
			description:
				"Finish one fully transferred resumable upload, set its title and report whether Meta already exposes it as an owned ad-account video. Cannot create or activate ads.",
			inputSchema: z.object({
				video_id: z.string().regex(/^\d+$/),
				upload_session_id: z.string().regex(/^\d+$/),
				title: z.string().trim().min(1).max(255),
				filename: z.string().trim().min(5).max(200),
				mime_type: z.enum(["video/mp4", "video/quicktime"]),
				file_size: z.number().int().positive().max(2_000_000_000),
				expected_sha256: z.string().regex(/^[a-f0-9]{64}$/),
				final_start_offset: z.string().regex(/^\d+$/),
				final_end_offset: z.string().regex(/^\d+$/),
				confirmation: z.literal(META_RESUMABLE_VIDEO_UPLOAD_CONFIRMATION),
			}),
		},
		async ({
			video_id,
			upload_session_id,
			title,
			filename,
			mime_type,
			file_size,
			expected_sha256,
			final_start_offset,
			final_end_offset,
		}) => {
			try {
				safeVideoFilename(filename, mime_type);
				if (final_start_offset !== final_end_offset || Number(final_end_offset) !== file_size) {
					throw new Error("Refusing finish: final offsets do not prove that the complete file was transferred.");
				}
				const { adAccountId } = getToolkitMetaConfig();
				const finished = await toolkitMetaPost(`${adAccountId}/advideos`, {
					upload_phase: "finish",
					upload_session_id,
					title,
				});
				if (finished?.success !== true) {
					throw new Error("Meta did not confirm resumable upload completion.");
				}
				const visibleVideo = (await listAccountVideos()).find(
					(item: any) => String(item?.id) === video_id,
				);
				return textResult({
					finished: true,
					video_id,
					visible_as_owned_ad_account_video: Boolean(visibleVideo),
					processing_complete: visibleVideo?.status?.processing_phase?.status === "complete",
					video: visibleVideo ? { ...visibleVideo, derived_dimensions: derivedVideoDimensions(visibleVideo) } : null,
					source_manifest: { title, filename, mime_type, file_size, expected_sha256 },
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
				"Create one PAUSED website-sales video ad from an explicitly validated owned Meta video. Parent campaign/ad set must be PAUSED OUTCOME_SALES / WEBSITE. Supports same-site UTM tracking and cannot activate delivery.",
			inputSchema: z.object({
				adset_id: z.string().regex(/^\d+$/),
				video_id: z.string().regex(/^\d+$/),
				expected_video_title: z.string().max(255),
				...websiteAdCopySchema,
				confirmation: z.literal(META_ECOMMERCE_AD_CREATE_CONFIRMATION),
			}),
		},
		async ({ adset_id, video_id, expected_video_title, page_id, name, primary_text, headline, description, cta_type, destination_url, utm }) => {
			try {
				await assertSalesAdsetForCreation(adset_id);
				await assertOwnedPage(page_id);
				await assertOwnedVideo(video_id, { title: expected_video_title });
				await refuseDuplicateAdName(name);
				const trackedUrl = buildTrackedDestination(destination_url, utm);
				const creative = await createWebsiteSalesVideoCreative({
					name,
					pageId: page_id,
					videoId: video_id,
					primaryText: primary_text,
					headline,
					description,
					ctaType: cta_type,
					destinationUrl: trackedUrl,
				});
				if (!creative?.id) throw new Error("Meta did not return a creative ID.");
				const ad = await createPausedAd(adset_id, name, String(creative.id));
				if (!collectVideoIds(ad.creative).has(video_id)) {
					throw new Error("Created ad did not verify against the intended video.");
				}
				return textResult({ created: true, activation_performed: false, tracked_url: trackedUrl, ad });
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
				confirmation: z.literal(META_ECOMMERCE_AD_CREATE_CONFIRMATION),
			}),
		},
		async (args) => {
			try {
				await assertSalesAdsetForCreation(args.adset_id);
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
				await refuseDuplicateAdName(args.name);
				const trackedUrl = buildTrackedDestination(args.destination_url, args.utm);
				const creative = await createWebsiteSalesPlacementCreative({
					name: args.name,
					pageId: args.page_id,
					video4x5Id: args.video_4x5_id,
					video9x16Id: args.video_9x16_id,
					primaryText: args.primary_text,
					headline: args.headline,
					description: args.description,
					ctaType: args.cta_type,
					destinationUrl: trackedUrl,
				});
				if (!creative?.id) throw new Error("Meta did not return a creative ID.");
				const ad = await createPausedAd(args.adset_id, args.name, String(creative.id));
				const creativeVideos = Array.isArray(ad.creative?.asset_feed_spec?.videos)
					? ad.creative.asset_feed_spec.videos
					: [];
				const verifiedLabels = new Set(
					creativeVideos.flatMap((video: any) =>
						Array.isArray(video?.adlabels)
							? video.adlabels.map((label: any) => String(label?.name ?? ""))
							: [],
					),
				);
				const allCreativeVideosHaveIds =
					creativeVideos.length === 2 &&
					creativeVideos.every((video: any) => /^\d+$/.test(String(video?.video_id ?? "")));
				if (
					!allCreativeVideosHaveIds ||
					!verifiedLabels.has("video_feed_4x5") ||
					!verifiedLabels.has("video_vertical_9x16")
				) {
					throw new Error("Created placement ad did not verify both labeled placement videos.");
				}
				return textResult({
					created: true,
					activation_performed: false,
					tracked_url: trackedUrl,
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
				"Switch exactly one owned Meta ad between PAUSED and ACTIVE after exact ad/ad-set/campaign identity checks. Activation requires both parents already ACTIVE. Cannot archive or delete.",
			inputSchema: z.object({
				ad_id: z.string().regex(/^\d+$/),
				expected_ad_name: z.string().trim().min(3).max(200),
				expected_adset_id: z.string().regex(/^\d+$/),
				expected_adset_name: z.string().trim().min(3).max(200),
				expected_campaign_id: z.string().regex(/^\d+$/),
				expected_campaign_name: z.string().trim().min(3).max(200),
				expected_current_status: z.enum(["PAUSED", "ACTIVE"]),
				new_status: z.enum(["PAUSED", "ACTIVE"]),
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
				const verified = await setMetaStatus(args.ad_id, args.new_status);
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
				"Read-only pre-launch inspection of one owned Meta ecommerce sales campaign. Verifies paused state, AU website-sales ad sets, pixels, owned videos, same-site destinations and reports UTM gaps. Returns a hash-locked plan for guarded launch.",
			inputSchema: z.object({
				campaign_id: z.string().regex(/^\d+$/),
				expected_campaign_name: z.string().trim().min(3).max(200),
			}),
		},
		async ({ campaign_id, expected_campaign_name }) => {
			try {
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
