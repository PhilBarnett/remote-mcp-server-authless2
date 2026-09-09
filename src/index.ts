import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const COMMERCIAL_START_DATE = "2024-07-01";
const GENUINE_ORDER_MIN_TOTAL = 20;

const GOOGLE_ADS_ZIPGRIP_CONFIRMATION = "CONFIRM CREATE PAUSED ZIPGRIP PMAX";
const GOOGLE_ADS_ZIPGRIP_CUSTOMER_ID = "6610097637";
const GOOGLE_ADS_ZIPGRIP_MERCHANT_ID = "5320593492";
const GOOGLE_ADS_ZIPGRIP_ITEM_ID = "gla_1301";
const GOOGLE_ADS_ZIPGRIP_FEED_LABEL = "AU";
const GOOGLE_ADS_ZIPGRIP_CAMPAIGN_NAME = "BM Online PMax — ZipGrip";
const GOOGLE_ADS_ZIPGRIP_FINAL_URL = "https://online.blindmotion.com.au/zipsided-outdoor-blinds/";
const GOOGLE_ADS_ZIPGRIP_CAMPAIGN_ID = "24223451940";
const GOOGLE_ADS_ZIPGRIP_ASSET_GROUP_ID = "6745778074";
const GOOGLE_ADS_ZIPGRIP_TEXT_CONFIRMATION = "CONFIRM ADD PAUSED ZIPGRIP TEXT ASSETS";
const GOOGLE_ADS_ZIPGRIP_IMAGE_CONFIRMATION = "CONFIRM ADD PAUSED ZIPGRIP IMAGE ASSETS";
const GOOGLE_ADS_ZIPGRIP_BOOTSTRAP_CONFIRMATION = "CONFIRM BOOTSTRAP PAUSED ZIPGRIP ASSET GROUP";
const GOOGLE_ADS_ZIPGRIP_VIDEO_CONFIRMATION = "CONFIRM LINK PAUSED ZIPGRIP YOUTUBE ASSETS";
const GOOGLE_ADS_ZIPGRIP_LAUNCH_CONFIRMATION = "CONFIRM EXCLUSIVE ZIPGRIP LAUNCH";
const GOOGLE_ADS_ZIPGRIP_SOURCE_PMAX_ID = "22733226130";
const GOOGLE_ADS_ZIPGRIP_SOURCE_SHOPPING_IDS = ["22732181006", "21527804393"] as const;
const GOOGLE_ADS_AUSTRALIA_GEO_TARGET_ID = "2036";
const GOOGLE_ADS_ENGLISH_LANGUAGE_ID = "1000";

const GENUINE_STATUSES = new Set(["processing", "completed", "on-hold"]);

function getAuthHeader() {
	const workerEnv = env as unknown as Record<string, string>;
	const auth = btoa(`${workerEnv.WC_CONSUMER_KEY}:${workerEnv.WC_CONSUMER_SECRET}`);

	return `Basic ${auth}`;
}

async function wcFetch(path: string, params: Record<string, string | number | undefined> = {}) {
	const workerEnv = env as unknown as Record<string, string>;
	const url = new URL(`${workerEnv.WC_SITE}/wp-json/wc/v3/${path}`);

	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) {
			url.searchParams.set(key, String(value));
		}
	}

	const response = await fetch(url.toString(), {
		headers: {
			Authorization: getAuthHeader(),
			Accept: "application/json",
		},
	});

	if (!response.ok) {
		const body = await response.text();

		throw new Error(`WooCommerce request failed: ${response.status} ${body}`);
	}

	return response;
}

async function wcWrite(path: string, body: unknown) {
	const workerEnv = env as unknown as Record<string, string>;
	const response = await fetch(`${workerEnv.WC_SITE}/wp-json/wc/v3/${path}`, {
		method: "PUT",
		headers: {
			Authorization: getAuthHeader(),
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw new Error(`WooCommerce write failed: ${response.status} ${await response.text()}`);
	}
	return response;
}

async function wcCreate(path: string, body: unknown) {
	const workerEnv = env as unknown as Record<string, string>;
	const response = await fetch(`${workerEnv.WC_SITE}/wp-json/wc/v3/${path}`, {
		method: "POST",
		headers: {
			Authorization: getAuthHeader(),
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw new Error(`WooCommerce create failed: ${response.status} ${await response.text()}`);
	}
	return response;
}

async function wpFetch(path: string) {
	const workerEnv = env as unknown as Record<string, string>;
	const url = new URL(`${workerEnv.WC_SITE}/wp-json/wp/v2/${path}`);
	const response = await fetch(url.toString(), {
		headers: { Accept: "application/json" },
	});

	if (!response.ok) {
		throw new Error(`WordPress request failed: ${response.status} ${await response.text()}`);
	}

	return response;
}

function getWpWriteAuthHeader() {
	const workerEnv = env as unknown as Record<string, string | undefined>;
	if (!workerEnv.WP_USERNAME || !workerEnv.WP_APPLICATION_PASSWORD) {
		throw new Error(
			"WordPress media writes are not configured. Set WP_USERNAME and WP_APPLICATION_PASSWORD in Cloudflare.",
		);
	}
	return `Basic ${btoa(`${workerEnv.WP_USERNAME}:${workerEnv.WP_APPLICATION_PASSWORD}`)}`;
}

async function wpMcpWrite(path: string, body: unknown) {
	const workerEnv = env as unknown as Record<string, string>;
	const response = await fetch(`${workerEnv.WC_SITE}/wp-json/blindmotion-mcp/v1/${path}`, {
		method: "POST",
		headers: {
			Authorization: getWpWriteAuthHeader(),
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw new Error(
			`Blindmotion WordPress bridge failed: ${response.status} ${await response.text()}`,
		);
	}
	return response;
}

const CLONE_PRODUCT_CONFIRMATION = "CONFIRM CLONE PRODUCT AS DRAFT";
const VISUALIZER_PLUGIN_CONFIRMATION = "CONFIRM INSTALL BLINDMOTION VISUALIZER";
const VISUALIZER_PLUGIN_SLUG = "blindmotion-visualizer";
const VISUALIZER_PLUGIN_MAIN_FILE = "blindmotion-visualizer/blindmotion-visualizer.php";

async function sha256Hex(bytes: Uint8Array) {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

async function wpUploadMedia(filename: string, mimeType: string, bytes: Uint8Array) {
	const workerEnv = env as unknown as Record<string, string>;
	const response = await fetch(`${workerEnv.WC_SITE}/wp-json/wp/v2/media`, {
		method: "POST",
		headers: {
			Authorization: getWpWriteAuthHeader(),
			Accept: "application/json",
			"Content-Type": mimeType,
			"Content-Disposition": `attachment; filename="${filename.replace(/["\\\r\n]/g, "-")}"`,
		},
		body: bytes,
	});
	if (!response.ok) {
		throw new Error(
			`WordPress media upload failed: ${response.status} ${await response.text()}`,
		);
	}
	return response.json<any>();
}

function decodeBase64(value: string) {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function hasExpectedImageSignature(bytes: Uint8Array, mimeType: string) {
	if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8;
	if (mimeType === "image/png") {
		return bytes
			.slice(0, 8)
			.every(
				(byte, index) => byte === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index],
			);
	}
	if (mimeType === "image/webp") {
		return (
			String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
			String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
		);
	}
	return false;
}

type ProductImageReference = {
	role: "custom_field";
	meta_data_id?: number;
	custom_field_key: string;
	custom_field_path: string;
	attachment_id?: number;
	source_url?: string;
};

const IMAGE_KEY_PATTERN =
	/(?:^|[_\-.])(image|images|img|photo|picture|thumbnail|thumb|icon|swatch|media|upload)(?:$|[_\-.])/i;
const NON_IMAGE_VALUE_KEY_PATTERN =
	/(?:^|[_\-.])(title|desc|description|label|text|name|caption|alt|width|height|size|price|percent|percentage)(?:$|[_\-.])/i;
const IMAGE_DISPLAY_FLAG_KEY_PATTERN =
	/(?:^|[_\-.])(large|show|enable|enabled|display|use)_images?(?:$|[_\-.])/i;
const IMAGE_URL_PATTERN =
	/https?:\\?\/\\?\/[^\s"'<>]+?\.(?:avif|gif|jpe?g|png|webp|svg)(?:\?[^\s"'<>]*)?/gi;
const SERIALIZED_IMAGE_ID_PATTERN =
	/s:\d+:"([^";]*(?:image|images|img|photo|picture|thumbnail|thumb|icon|swatch|media|upload)[^";]*)";(?:i:(\d+);|s:\d+:"(\d+)";)/gi;

function normaliseImageUrl(value: string) {
	return value.replace(/\\\//g, "/").replace(/&amp;/g, "&");
}

function isImageValuePath(path: string) {
	return (
		IMAGE_KEY_PATTERN.test(path) &&
		!NON_IMAGE_VALUE_KEY_PATTERN.test(path) &&
		!IMAGE_DISPLAY_FLAG_KEY_PATTERN.test(path)
	);
}

function collectProductImageReferences(metaData: any[] | undefined) {
	const references: ProductImageReference[] = [];
	const seen = new Set<string>();
	const referenceByPath = new Map<string, ProductImageReference>();

	function addReference(reference: ProductImageReference) {
		const pathIdentity = `${reference.meta_data_id ?? ""}|${reference.custom_field_path}`;
		const existing = referenceByPath.get(pathIdentity);
		if (existing) {
			// Product-option plugins commonly repeat a choice as both an attachment ID
			// and a thumbnail URL. Keep one reference and prefer the resolvable ID.
			existing.attachment_id ??= reference.attachment_id;
			existing.source_url ??= reference.source_url;
			return;
		}

		const identity = `${pathIdentity}|${reference.attachment_id ?? ""}|${reference.source_url ?? ""}`;
		if (!seen.has(identity)) {
			seen.add(identity);
			referenceByPath.set(pathIdentity, reference);
			references.push(reference);
		}
	}

	function visit(value: unknown, customFieldKey: string, path: string, metaDataId?: number) {
		const imageContext = isImageValuePath(path);

		if (typeof value === "number" && Number.isInteger(value) && value > 0 && imageContext) {
			addReference({
				role: "custom_field",
				meta_data_id: metaDataId,
				custom_field_key: customFieldKey,
				custom_field_path: path,
				attachment_id: value,
			});
			return;
		}

		if (typeof value === "string") {
			for (const match of value.matchAll(IMAGE_URL_PATTERN)) {
				addReference({
					role: "custom_field",
					meta_data_id: metaDataId,
					custom_field_key: customFieldKey,
					custom_field_path: path,
					source_url: normaliseImageUrl(match[0]),
				});
			}

			const trimmedValue = value.trim();
			if (imageContext && /^\d+$/.test(trimmedValue)) {
				addReference({
					role: "custom_field",
					meta_data_id: metaDataId,
					custom_field_key: customFieldKey,
					custom_field_path: path,
					attachment_id: Number(trimmedValue),
				});
			}

			// Follow structured JSON rather than scraping arbitrary numbers from text.
			if (/^[{[]/.test(trimmedValue)) {
				try {
					visit(JSON.parse(trimmedValue), customFieldKey, path, metaDataId);
				} catch {
					// Not valid JSON; explicit URLs and serialized image keys are handled below.
				}
			}

			// In PHP-serialized option data, accept only numeric values whose own key
			// is explicitly image-related. Numbers in prose must never become media IDs.
			for (const match of value.matchAll(SERIALIZED_IMAGE_ID_PATTERN)) {
				const serializedKey = match[1];
				const serializedId = match[2] ?? match[3];
				if (serializedId && isImageValuePath(serializedKey)) {
					addReference({
						role: "custom_field",
						meta_data_id: metaDataId,
						custom_field_key: customFieldKey,
						custom_field_path: `${path}.${serializedKey}`,
						attachment_id: Number(serializedId),
					});
				}
			}
			return;
		}

		if (Array.isArray(value)) {
			value.forEach((item, index) =>
				visit(item, customFieldKey, `${path}[${index}]`, metaDataId),
			);
			return;
		}

		if (value && typeof value === "object") {
			for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
				visit(child, customFieldKey, `${path}.${key}`, metaDataId);
			}
		}
	}

	for (const meta of metaData ?? []) {
		const key = String(meta?.key ?? "unknown");
		visit(meta?.value, key, key, Number(meta?.id) || undefined);
	}

	return references;
}

function productMetaPathTokens(customFieldKey: string, path: string) {
	if (path === customFieldKey) return [];
	if (!path.startsWith(`${customFieldKey}.`) && !path.startsWith(`${customFieldKey}[`)) {
		throw new Error("Custom-field path does not belong to the selected meta key.");
	}
	const relativePath = path.slice(customFieldKey.length).replace(/^\./, "");
	return [...relativePath.matchAll(/(?:^|\.)([^.[\]]+)|\[(\d+)\]/g)].map(
		(match) => match[1] ?? Number(match[2]),
	);
}

function getNestedValue(root: any, tokens: Array<string | number>) {
	let current = root;
	for (const token of tokens) {
		if (current === null || current === undefined || !(token in Object(current))) {
			throw new Error("Custom-field path no longer exists on the product.");
		}
		current = current[token];
	}
	return current;
}

function setNestedValue(root: any, tokens: Array<string | number>, value: unknown) {
	if (!tokens.length) throw new Error("Refusing to replace an entire custom-field value.");
	let current = root;
	for (const token of tokens.slice(0, -1)) {
		if (current === null || current === undefined || !(token in Object(current))) {
			throw new Error("Custom-field path no longer exists on the product.");
		}
		current = current[token];
	}
	current[tokens[tokens.length - 1]] = value;
}

function mediaMetadata(media: any, fallback: Record<string, unknown> = {}) {
	const width = Number(media.media_details?.width ?? 0) || null;
	const height = Number(media.media_details?.height ?? 0) || null;
	return {
		...fallback,
		attachment_id: media.id ?? fallback.attachment_id ?? null,
		name: media.slug ?? media.title?.rendered ?? null,
		alt: media.alt_text ?? null,
		filename: media.media_details?.file?.split("/").pop() ?? null,
		source_url: media.source_url ?? fallback.source_url ?? null,
		mime_type: media.mime_type ?? null,
		width,
		height,
		aspect_ratio: width && height ? Number((width / height).toFixed(4)) : null,
		is_square: width && height ? width === height : null,
		file_size_bytes: media.media_details?.filesize ?? null,
	};
}

function mediaFilenameKey(url: string) {
	try {
		return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "")
			.replace(/-\d+x\d+(?=\.[^.]+$)/, "")
			.toLowerCase();
	} catch {
		return "";
	}
}

function getMetaConfig() {
	const workerEnv = env as unknown as Record<string, string | undefined>;
	const accessToken = workerEnv.META_ACCESS_TOKEN;
	const configuredAccountId = workerEnv.META_AD_ACCOUNT_ID;
	const apiVersion = workerEnv.META_API_VERSION;

	if (!accessToken || !configuredAccountId || !apiVersion) {
		throw new Error(
			"Meta Ads is not configured. Set META_ACCESS_TOKEN, META_AD_ACCOUNT_ID and META_API_VERSION in Cloudflare.",
		);
	}

	const adAccountId = configuredAccountId.startsWith("act_")
		? configuredAccountId
		: `act_${configuredAccountId}`;

	return { accessToken, adAccountId, apiVersion };
}

async function metaFetch(
	path: string,
	params: Record<string, string | number | undefined> = {},
	accessTokenOverride?: string,
) {
	const { accessToken, apiVersion } = getMetaConfig();
	const url = new URL(`https://graph.facebook.com/${apiVersion}/${path}`);

	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) {
			url.searchParams.set(key, String(value));
		}
	}

	const response = await fetch(url.toString(), {
		headers: {
			Authorization: `Bearer ${accessTokenOverride ?? accessToken}`,
			Accept: "application/json",
		},
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Meta Marketing API request failed: ${response.status} ${body}`);
	}

	return response.json<any>();
}

async function metaPost(
	path: string,
	params: Record<string, string | number>,
	accessTokenOverride?: string,
) {
	const { accessToken, apiVersion } = getMetaConfig();
	const url = new URL(`https://graph.facebook.com/${apiVersion}/${path}`);
	const body = new URLSearchParams();

	for (const [key, value] of Object.entries(params)) body.set(key, String(value));

	const response = await fetch(url.toString(), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessTokenOverride ?? accessToken}`,
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body,
	});

	if (!response.ok) {
		throw new Error(
			`Meta Marketing API request failed: ${response.status} ${await response.text()}`,
		);
	}

	return response.json<any>();
}

function metaDateRange(startDate: string, endDate: string) {
	return JSON.stringify({ since: startDate, until: endDate });
}

const META_INSIGHT_FIELDS = [
	"account_currency",
	"impressions",
	"reach",
	"frequency",
	"clicks",
	"inline_link_clicks",
	"spend",
	"cpm",
	"cpc",
	"ctr",
	"actions",
	"action_values",
	"purchase_roas",
	"website_purchase_roas",
	"cost_per_action_type",
].join(",");

const META_PURCHASE_ACTION_TYPES = [
	"offsite_conversion.fb_pixel_purchase",
	"onsite_web_purchase",
	"omni_purchase",
	"purchase",
];

function getMetaMetricValue(metrics: any, actionTypes: string[]) {
	if (!Array.isArray(metrics)) return null;

	for (const actionType of actionTypes) {
		const metric = metrics.find((item: any) => item?.action_type === actionType);
		if (metric === undefined) continue;

		const value = Number(metric.value);
		if (Number.isFinite(value)) return value;
	}

	return null;
}

function enrichMetaInsight(row: any) {
	const purchases = getMetaMetricValue(row.actions, META_PURCHASE_ACTION_TYPES) ?? 0;
	const purchaseConversionValue = getMetaMetricValue(
		row.action_values,
		META_PURCHASE_ACTION_TYPES,
	);
	const reportedPurchaseRoas =
		getMetaMetricValue(row.website_purchase_roas, META_PURCHASE_ACTION_TYPES) ??
		getMetaMetricValue(row.purchase_roas, META_PURCHASE_ACTION_TYPES);
	const spend = Number(row.spend ?? 0);
	const calculatedPurchaseRoas =
		purchaseConversionValue !== null && spend > 0 ? purchaseConversionValue / spend : null;

	return {
		...row,
		purchase_roas_breakdown: row.purchase_roas ?? [],
		website_purchase_roas_breakdown: row.website_purchase_roas ?? [],
		purchases,
		purchase_conversion_value: purchaseConversionValue,
		purchase_roas: reportedPurchaseRoas ?? calculatedPurchaseRoas,
		cost_per_purchase: purchases > 0 && spend > 0 ? spend / purchases : null,
		purchase_value_reported: purchaseConversionValue !== null,
	};
}

function enrichMetaInsights(rows: any[]) {
	return rows.map(enrichMetaInsight);
}

function metaBudgetAmount(value: unknown) {
	if (value === undefined || value === null || value === "") return null;
	return Number((Number(value) / 100).toFixed(2));
}

function safeMetaBudgetObject(object: any, objectType: "campaign" | "adset") {
	return {
		object_type: objectType,
		id: object.id,
		name: object.name,
		campaign_id: objectType === "adset" ? object.campaign_id : object.id,
		status: object.status,
		effective_status: object.effective_status,
		daily_budget: metaBudgetAmount(object.daily_budget),
		lifetime_budget: metaBudgetAmount(object.lifetime_budget),
		budget_remaining: metaBudgetAmount(object.budget_remaining),
	};
}

const META_CREATE_CONFIRMATION = "CONFIRM CREATE PAUSED META ASSET";
const META_CREATE_SPRING_FORM_CONFIRMATION = "CONFIRM CREATE SPRING META FORM";
const META_ARCHIVE_DRAFT_ADS_CONFIRMATION = "CONFIRM ARCHIVE PAUSED META DRAFT ADS";
const META_REPAIR_SPRING_ADS_CONFIRMATION = "CONFIRM REPAIR ACTIVE SPRING META ADS";
const META_MAX_CREATION_DAILY_BUDGET_AUD = 500;

async function assertMetaObjectOwnership(
	objectId: string,
	objectType: "campaign" | "adset" | "creative" | "ad",
) {
	const { adAccountId } = getMetaConfig();
	const configuredAccountId = adAccountId.replace(/^act_/, "");
	const fields =
		objectType === "ad"
			? "id,name,account_id,campaign_id,adset_id,status,effective_status,created_time,updated_time,creative"
			: objectType === "adset"
				? "id,name,account_id,campaign_id,status,effective_status"
				: objectType === "campaign"
					? "id,name,account_id,status,effective_status,objective,daily_budget,lifetime_budget"
					: "id,name,account_id,status";

	const object = await metaFetch(objectId, { fields });
	if (String(object.account_id) !== configuredAccountId) {
		throw new Error(
			"Refusing operation: " +
				objectType +
				" does not belong to the configured Meta ad account.",
		);
	}
	return object;
}

// Business Creative Asset Management is intentionally not used: this app validates
// placement assets through the configured ad account's owned /advideos edge.
async function getAllMetaEdgeRows(
	path: string,
	params: Record<string, string | number | undefined>,
	limit: number,
	accessTokenOverride?: string,
) {
	const rows: any[] = [];
	let after: string | undefined;
	while (rows.length < limit) {
		const result = await metaFetch(
			path,
			{
				...params,
				limit: Math.min(100, limit - rows.length),
				after,
			},
			accessTokenOverride,
		);
		rows.push(...(result.data ?? []));
		const nextAfter = result.paging?.cursors?.after;
		if (!result.paging?.next || !nextAfter || nextAfter === after) break;
		after = String(nextAfter);
	}
	return rows.slice(0, limit);
}

function enrichMetaVideo(video: any, ownershipSource: "AD_ACCOUNT" | "PAGE") {
	const { format, ...videoMetadata } = video;
	const dimensions = (Array.isArray(format) ? format : [])
		.map((item: any) => ({
			width: Number(item.width),
			height: Number(item.height),
		}))
		.filter(
			(item: { width: number; height: number }) =>
				Number.isFinite(item.width) &&
				Number.isFinite(item.height) &&
				item.width > 0 &&
				item.height > 0,
		)
		.sort(
			(a: { width: number; height: number }, b: { width: number; height: number }) =>
				b.width * b.height - a.width * a.height,
		)[0];
	const width = dimensions?.width ?? null;
	const height = dimensions?.height ?? null;
	return {
		...videoMetadata,
		ownership_source: ownershipSource,
		width,
		height,
		aspect_ratio: width && height ? Number((width / height).toFixed(6)) : null,
	};
}

async function refuseDuplicateMetaName(
	edge: "campaigns" | "adsets" | "ads" | "adcreatives",
	name: string,
) {
	const { adAccountId } = getMetaConfig();
	const result = await metaFetch(adAccountId + "/" + edge, {
		fields: edge === "adcreatives" ? "id,name,status" : "id,name,status,effective_status",
		limit: 100,
	});
	const duplicate = (result.data ?? []).find(
		(item: any) => String(item.name).trim().toLowerCase() === name.trim().toLowerCase(),
	);
	if (duplicate) {
		throw new Error(
			"Refusing creation: an existing asset already uses this exact name (ID " +
				duplicate.id +
				").",
		);
	}
}

async function getOwnedMetaPages() {
	const { adAccountId } = getMetaConfig();
	const result = await metaFetch(adAccountId + "/promote_pages", {
		fields: "id,name,category",
		limit: 100,
	});
	return result.data ?? [];
}

async function assertOwnedMetaPage(pageId: string) {
	const page = (await getOwnedMetaPages()).find((item: any) => String(item.id) === pageId);
	if (!page) {
		throw new Error(
			"Refusing creation: Facebook Page is not assigned to the configured Meta ad account.",
		);
	}
	return page;
}

async function getOwnedMetaPageAccessToken(pageId: string) {
	await assertOwnedMetaPage(pageId);
	const page = await metaFetch(pageId, { fields: "id,name,access_token" });
	if (!page.access_token) {
		throw new Error(
			"Meta did not return a Page Access Token for the selected owned Page. Confirm the configured system user is assigned to the Page with lead access.",
		);
	}
	return String(page.access_token);
}

async function getMetaInstagramIdentityForPage(pageId: string, adsetId: string) {
	const existingAds = await metaFetch(adsetId + "/ads", {
		fields: "id,creative{object_story_spec}",
		limit: 100,
	});
	const existingIdentities = new Set(
		(existingAds.data ?? [])
			.filter(
				(ad: any) =>
					String(ad.creative?.object_story_spec?.page_id ?? "") === pageId &&
					/^\d+$/.test(String(ad.creative?.object_story_spec?.instagram_user_id ?? "")),
			)
			.map((ad: any) => String(ad.creative.object_story_spec.instagram_user_id)),
	);
	if (existingIdentities.size === 1) {
		const instagramUserId = [...existingIdentities][0];
		if (!instagramUserId) {
			throw new Error("Refusing creation: the validated Instagram identity was empty.");
		}
		return instagramUserId;
	}
	if (existingIdentities.size > 1) {
		throw new Error(
			"Refusing creation: existing ads use multiple Instagram identities for the selected Page.",
		);
	}

	const pageAccessToken = await getOwnedMetaPageAccessToken(pageId);
	const page = await metaFetch(
		pageId,
		{ fields: "id,name,instagram_business_account{id,username}" },
		pageAccessToken,
	);
	const instagramUserId = String(page.instagram_business_account?.id ?? "");
	if (!/^\d+$/.test(instagramUserId)) {
		throw new Error(
			"Refusing creation: no single connected Instagram business account could be validated for the selected Page.",
		);
	}
	return instagramUserId;
}

async function getOwnedMetaLeadForms(pageId: string, limit = 100) {
	const pageAccessToken = await getOwnedMetaPageAccessToken(pageId);
	const result = await metaFetch(
		pageId + "/leadgen_forms",
		{
			fields: "id,name,status,locale,created_time",
			limit,
		},
		pageAccessToken,
	);
	return result.data ?? [];
}

async function assertOwnedActiveMetaLeadForm(pageId: string, formId: string) {
	const form = (await getOwnedMetaLeadForms(pageId, 100)).find(
		(item: any) => String(item.id) === formId,
	);
	if (!form) {
		throw new Error("Refusing creation: Instant Form does not belong to the selected Page.");
	}
	if (form.status !== "ACTIVE") {
		throw new Error("Refusing creation: selected Instant Form is not ACTIVE.");
	}
	return form;
}

async function getOwnedMetaVideos(limit = 100, pageId?: string) {
	const { adAccountId } = getMetaConfig();
	const fields = "id,title,description,created_time,updated_time,length,picture,status,format";
	const accountVideos = await getAllMetaEdgeRows(adAccountId + "/advideos", { fields }, limit);
	const videos = accountVideos.map((item: any) => enrichMetaVideo(item, "AD_ACCOUNT"));

	if (pageId) {
		const pageAccessToken = await getOwnedMetaPageAccessToken(pageId);
		const pageVideos = await getAllMetaEdgeRows(
			pageId + "/videos",
			{ fields },
			limit,
			pageAccessToken,
		);
		const byId = new Map(videos.map((item: any) => [String(item.id), item]));
		for (const item of pageVideos) {
			const id = String(item.id);
			if (!byId.has(id)) byId.set(id, enrichMetaVideo(item, "PAGE"));
		}
		return [...byId.values()];
	}

	return videos;
}

async function assertOwnedMetaVideo(videoId: string, pageId?: string) {
	const video = (await getOwnedMetaVideos(500, pageId)).find(
		(item: any) => String(item.id) === videoId,
	);
	if (!video) {
		throw new Error(
			"Refusing creation: video is not available in the configured Meta ad account.",
		);
	}
	return video;
}

async function assertOwnedMetaAdAccountVideo(videoId: string) {
	const video = (await getOwnedMetaVideos(500)).find(
		(item: any) => String(item.id) === videoId && item.ownership_source === "AD_ACCOUNT",
	);
	if (!video) {
		throw new Error("Refusing creation: video is not owned by the configured Meta ad account.");
	}
	return video;
}

function collectMetaLeadFormIds(value: unknown, formIds = new Set<string>()) {
	if (Array.isArray(value)) {
		for (const item of value) collectMetaLeadFormIds(item, formIds);
	} else if (value && typeof value === "object") {
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			if (key === "lead_gen_form_id" && /^\d+$/.test(String(child))) {
				formIds.add(String(child));
			} else {
				collectMetaLeadFormIds(child, formIds);
			}
		}
	}
	return formIds;
}

function metaDailyBudgetMinorUnits(amountAud: number) {
	const rounded = Number(amountAud.toFixed(2));
	if (rounded <= 0 || rounded > META_MAX_CREATION_DAILY_BUDGET_AUD) {
		throw new Error(
			"Daily budget must be greater than A$0 and no more than A$" +
				META_MAX_CREATION_DAILY_BUDGET_AUD +
				".",
		);
	}
	return Math.round(rounded * 100);
}

type Ga4ServiceAccount = {
	client_email: string;
	private_key: string;
	token_uri?: string;
};

type Ga4ReportRequest = {
	dateRanges: Array<{ startDate: string; endDate: string }>;
	dimensions?: Array<{ name: string }>;
	metrics: Array<{ name: string }>;
	limit?: string;
	orderBys?: Array<Record<string, unknown>>;
};

let ga4AccessTokenCache: { token: string; expiresAt: number } | undefined;

function base64UrlEncode(value: string | ArrayBuffer) {
	const bytes =
		typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemToArrayBuffer(pem: string) {
	const base64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes.buffer;
}

function getGa4Config() {
	const workerEnv = env as unknown as Record<string, string | undefined>;
	const propertyId = workerEnv.GA4_PROPERTY_ID;
	const serviceAccountJson = workerEnv.GA4_SERVICE_ACCOUNT_JSON;

	if (!propertyId || !serviceAccountJson) {
		throw new Error(
			"GA4 is not configured. Set GA4_PROPERTY_ID and GA4_SERVICE_ACCOUNT_JSON in Cloudflare.",
		);
	}

	let serviceAccount: Ga4ServiceAccount;
	try {
		serviceAccount = JSON.parse(serviceAccountJson) as Ga4ServiceAccount;
	} catch {
		throw new Error("GA4_SERVICE_ACCOUNT_JSON is not valid JSON.");
	}

	if (!serviceAccount.client_email || !serviceAccount.private_key) {
		throw new Error("GA4_SERVICE_ACCOUNT_JSON is missing client_email or private_key.");
	}

	return { propertyId, serviceAccount };
}

async function getGa4AccessToken() {
	if (ga4AccessTokenCache && ga4AccessTokenCache.expiresAt > Date.now() + 60_000) {
		return ga4AccessTokenCache.token;
	}

	const { serviceAccount } = getGa4Config();
	const now = Math.floor(Date.now() / 1000);
	const tokenUri = serviceAccount.token_uri ?? "https://oauth2.googleapis.com/token";
	const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const claims = base64UrlEncode(
		JSON.stringify({
			iss: serviceAccount.client_email,
			scope: "https://www.googleapis.com/auth/analytics.readonly",
			aud: tokenUri,
			iat: now,
			exp: now + 3600,
		}),
	);
	const unsignedToken = `${header}.${claims}`;
	const key = await crypto.subtle.importKey(
		"pkcs8",
		pemToArrayBuffer(serviceAccount.private_key),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(unsignedToken),
	);
	const assertion = `${unsignedToken}.${base64UrlEncode(signature)}`;
	const response = await fetch(tokenUri, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion,
		}),
	});

	if (!response.ok) {
		throw new Error(`Google OAuth request failed: ${response.status} ${await response.text()}`);
	}

	const tokenResponse = await response.json<{ access_token: string; expires_in?: number }>();
	ga4AccessTokenCache = {
		token: tokenResponse.access_token,
		expiresAt: Date.now() + (tokenResponse.expires_in ?? 3600) * 1000,
	};
	return tokenResponse.access_token;
}

async function ga4RunReport(request: Ga4ReportRequest) {
	const { propertyId } = getGa4Config();
	const accessToken = await getGa4AccessToken();
	const response = await fetch(
		`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({ ...request, returnPropertyQuota: true }),
		},
	);

	if (!response.ok) {
		throw new Error(
			`Google Analytics Data API request failed: ${response.status} ${await response.text()}`,
		);
	}

	return response.json<any>();
}

type GoogleAdsConfig = {
	developerToken: string;
	loginCustomerId: string;
	customerId: string;
	serviceAccount: Ga4ServiceAccount;
};

let googleAdsAccessTokenCache: { token: string; expiresAt: number } | undefined;

function getGoogleAdsConfig(): GoogleAdsConfig {
	const workerEnv = env as unknown as Record<string, string | undefined>;
	const developerToken = workerEnv.GOOGLE_ADS_DEVELOPER_TOKEN;
	const loginCustomerId = workerEnv.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/-/g, "");
	const customerId = workerEnv.GOOGLE_ADS_CUSTOMER_ID?.replace(/-/g, "");
	const serviceAccountJson = workerEnv.GOOGLE_ADS_SERVICE_ACCOUNT_JSON;

	if (!developerToken || !loginCustomerId || !customerId || !serviceAccountJson) {
		throw new Error(
			"Google Ads is not configured. Set GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_LOGIN_CUSTOMER_ID, GOOGLE_ADS_CUSTOMER_ID and GOOGLE_ADS_SERVICE_ACCOUNT_JSON in Cloudflare.",
		);
	}
	if (!/^\d{10}$/.test(loginCustomerId) || !/^\d{10}$/.test(customerId)) {
		throw new Error("Google Ads customer IDs must contain exactly 10 digits.");
	}

	let serviceAccount: Ga4ServiceAccount;
	try {
		serviceAccount = JSON.parse(serviceAccountJson) as Ga4ServiceAccount;
	} catch {
		throw new Error("GOOGLE_ADS_SERVICE_ACCOUNT_JSON is not valid JSON.");
	}
	if (!serviceAccount.client_email || !serviceAccount.private_key) {
		throw new Error("GOOGLE_ADS_SERVICE_ACCOUNT_JSON is missing client_email or private_key.");
	}

	return { developerToken, loginCustomerId, customerId, serviceAccount };
}

async function getGoogleAdsAccessToken() {
	if (googleAdsAccessTokenCache && googleAdsAccessTokenCache.expiresAt > Date.now() + 60_000) {
		return googleAdsAccessTokenCache.token;
	}

	const { serviceAccount } = getGoogleAdsConfig();
	const now = Math.floor(Date.now() / 1000);
	const tokenUri = serviceAccount.token_uri ?? "https://oauth2.googleapis.com/token";
	const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const claims = base64UrlEncode(
		JSON.stringify({
			iss: serviceAccount.client_email,
			scope: "https://www.googleapis.com/auth/adwords",
			aud: tokenUri,
			iat: now,
			exp: now + 3600,
		}),
	);
	const unsignedToken = `${header}.${claims}`;
	const key = await crypto.subtle.importKey(
		"pkcs8",
		pemToArrayBuffer(serviceAccount.private_key),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(unsignedToken),
	);
	const assertion = `${unsignedToken}.${base64UrlEncode(signature)}`;
	const response = await fetch(tokenUri, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion,
		}),
	});

	if (!response.ok) {
		throw new Error(
			`Google Ads OAuth request failed: ${response.status} ${await response.text()}`,
		);
	}

	const tokenResponse = await response.json<{ access_token: string; expires_in?: number }>();
	googleAdsAccessTokenCache = {
		token: tokenResponse.access_token,
		expiresAt: Date.now() + (tokenResponse.expires_in ?? 3600) * 1000,
	};
	return tokenResponse.access_token;
}

function assertGoogleAdsDate(value: string, name: string) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		throw new Error(`${name} must use YYYY-MM-DD format.`);
	}
}

async function googleAdsSearchCustomer(customerId: string, query: string) {
	if (!/^\d{10}$/.test(customerId)) {
		throw new Error("Google Ads target customer ID must contain exactly 10 digits.");
	}

	const { developerToken, loginCustomerId } = getGoogleAdsConfig();
	const accessToken = await getGoogleAdsAccessToken();
	const results: any[] = [];
	let pageToken: string | undefined;

	do {
		const response = await fetch(
			`https://googleads.googleapis.com/v25/customers/${customerId}/googleAds:search`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"developer-token": developerToken,
					"login-customer-id": loginCustomerId,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify({ query, pageToken }),
			},
		);

		if (!response.ok) {
			throw new Error(
				`Google Ads API request for customer ${customerId} failed: ${response.status} ${await response.text()}`,
			);
		}

		const page = await response.json<{ results?: any[]; nextPageToken?: string }>();
		results.push(...(page.results ?? []));
		pageToken = page.nextPageToken;
	} while (pageToken && results.length < 10_000);

	return results;
}

async function googleAdsSearch(query: string) {
	const { customerId } = getGoogleAdsConfig();
	return googleAdsSearchCustomer(customerId, query);
}

async function googleAdsMutate(mutateOperations: any[], validateOnly: boolean) {
	const { developerToken, loginCustomerId, customerId } = getGoogleAdsConfig();
	const accessToken = await getGoogleAdsAccessToken();
	const response = await fetch(
		`https://googleads.googleapis.com/v25/customers/${customerId}/googleAds:mutate`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"developer-token": developerToken,
				"login-customer-id": loginCustomerId,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				mutateOperations,
				partialFailure: false,
				validateOnly,
				responseContentType: "MUTABLE_RESOURCE",
			}),
		},
	);

	if (!response.ok) {
		throw new Error(
			`Google Ads ${validateOnly ? "validation" : "mutation"} failed: ${response.status} ${await response.text()}`,
		);
	}

	return response.json<any>();
}

function assertZipGripGoogleAdsAccount() {
	const { customerId } = getGoogleAdsConfig();
	if (customerId !== GOOGLE_ADS_ZIPGRIP_CUSTOMER_ID) {
		throw new Error(
			`Refusing ZipGrip creation: configured customer ${customerId} is not the locked Blindmotion customer ${GOOGLE_ADS_ZIPGRIP_CUSTOMER_ID}.`,
		);
	}
}

async function findExistingZipGripCampaign() {
	return googleAdsSearch(`
		SELECT campaign.id, campaign.resource_name, campaign.name, campaign.status,
			campaign.advertising_channel_type
		FROM campaign
		WHERE campaign.name = '${GOOGLE_ADS_ZIPGRIP_CAMPAIGN_NAME}'
			AND campaign.status != 'REMOVED'
		LIMIT 1
	`);
}

function zipGripPmaxPlan(dailyBudgetAud: number) {
	const { customerId } = getGoogleAdsConfig();
	const budgetResource = `customers/${customerId}/campaignBudgets/-1`;
	const campaignResource = `customers/${customerId}/campaigns/-2`;
	const assetGroupResource = `customers/${customerId}/assetGroups/-3`;
	const rootFilterResource = `customers/${customerId}/assetGroupListingGroupFilters/-3~-4`;

	const mutateOperations = [
		{
			campaignBudgetOperation: {
				create: {
					resourceName: budgetResource,
					name: `${GOOGLE_ADS_ZIPGRIP_CAMPAIGN_NAME} budget`,
					amountMicros: String(Math.round(dailyBudgetAud * 1_000_000)),
					deliveryMethod: "STANDARD",
					explicitlyShared: false,
				},
			},
		},
		{
			campaignOperation: {
				create: {
					resourceName: campaignResource,
					name: GOOGLE_ADS_ZIPGRIP_CAMPAIGN_NAME,
					status: "PAUSED",
					advertisingChannelType: "PERFORMANCE_MAX",
					campaignBudget: budgetResource,
					maximizeConversionValue: {},
					shoppingSetting: {
						merchantId: GOOGLE_ADS_ZIPGRIP_MERCHANT_ID,
						feedLabel: GOOGLE_ADS_ZIPGRIP_FEED_LABEL,
					},
					assetAutomationSettings: [
						{
							assetAutomationType: "FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION",
							assetAutomationStatus: "OPTED_OUT",
						},
					],
					containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
				},
			},
		},
		{
			campaignCriterionOperation: {
				create: {
					campaign: campaignResource,
					location: {
						geoTargetConstant: `geoTargetConstants/${GOOGLE_ADS_AUSTRALIA_GEO_TARGET_ID}`,
					},
				},
			},
		},
		{
			campaignCriterionOperation: {
				create: {
					campaign: campaignResource,
					language: {
						languageConstant: `languageConstants/${GOOGLE_ADS_ENGLISH_LANGUAGE_ID}`,
					},
				},
			},
		},
		{
			assetGroupOperation: {
				create: {
					resourceName: assetGroupResource,
					campaign: campaignResource,
					name: "ZipGrip blinds",
					finalUrls: [GOOGLE_ADS_ZIPGRIP_FINAL_URL],
					finalMobileUrls: [GOOGLE_ADS_ZIPGRIP_FINAL_URL],
					status: "PAUSED",
				},
			},
		},
		{
			assetGroupListingGroupFilterOperation: {
				create: {
					resourceName: rootFilterResource,
					assetGroup: assetGroupResource,
					type: "SUBDIVISION",
					listingSource: "SHOPPING",
				},
			},
		},
		{
			assetGroupListingGroupFilterOperation: {
				create: {
					resourceName: `customers/${customerId}/assetGroupListingGroupFilters/-3~-5`,
					assetGroup: assetGroupResource,
					parentListingGroupFilter: rootFilterResource,
					type: "UNIT_INCLUDED",
					listingSource: "SHOPPING",
					caseValue: { productItemId: { value: GOOGLE_ADS_ZIPGRIP_ITEM_ID } },
				},
			},
		},
		{
			assetGroupListingGroupFilterOperation: {
				create: {
					resourceName: `customers/${customerId}/assetGroupListingGroupFilters/-3~-6`,
					assetGroup: assetGroupResource,
					parentListingGroupFilter: rootFilterResource,
					type: "UNIT_EXCLUDED",
					listingSource: "SHOPPING",
					caseValue: { productItemId: {} },
				},
			},
		},
	];

	return {
		customer_id: customerId,
		campaign_name: GOOGLE_ADS_ZIPGRIP_CAMPAIGN_NAME,
		campaign_status: "PAUSED",
		asset_group_status: "PAUSED",
		daily_budget_aud: dailyBudgetAud,
		bidding: "MAXIMIZE_CONVERSION_VALUE_WITHOUT_TARGET_ROAS",
		merchant_id: GOOGLE_ADS_ZIPGRIP_MERCHANT_ID,
		feed_label: GOOGLE_ADS_ZIPGRIP_FEED_LABEL,
		included_item_id: GOOGLE_ADS_ZIPGRIP_ITEM_ID,
		all_other_items: "EXCLUDED",
		final_url_expansion: "OPTED_OUT",
		location: "Australia",
		language: "English",
		final_url: GOOGLE_ADS_ZIPGRIP_FINAL_URL,
		creative_assets_created: false,
		activation_tool_available: false,
		mutateOperations,
	};
}

const ZIPGRIP_ASSET_REQUIREMENTS = {
	HEADLINE: { min: 3, max: 15, character_limit: 30 },
	LONG_HEADLINE: { min: 1, max: 5, character_limit: 90 },
	DESCRIPTION: { min: 2, max: 5, character_limit: 90 },
	MARKETING_IMAGE: {
		min: 1,
		max: 20,
		aspect_ratio: 1.91,
		minimum_dimensions: "600x314",
		max_bytes: 5_120_000,
	},
	SQUARE_MARKETING_IMAGE: {
		min: 1,
		max: 20,
		aspect_ratio: 1,
		minimum_dimensions: "300x300",
		max_bytes: 5_120_000,
	},
	PORTRAIT_MARKETING_IMAGE: {
		min: 0,
		max: 20,
		aspect_ratio: 0.8,
		minimum_dimensions: "480x600",
		max_bytes: 5_120_000,
	},
	BUSINESS_NAME: { min: 1, max: 1, character_limit: 25 },
	LOGO: { min: 1, max: 5, aspect_ratio: 1, minimum_dimensions: "128x128", max_bytes: 5_120_000 },
	LANDSCAPE_LOGO: {
		min: 0,
		max: 20,
		aspect_ratio: 4,
		minimum_dimensions: "512x128",
		max_bytes: 5_120_000,
	},
	YOUTUBE_VIDEO: { min: 0, max: 15, minimum_duration_seconds: 10 },
} as const;

function zipGripCampaignResource() {
	return `customers/${GOOGLE_ADS_ZIPGRIP_CUSTOMER_ID}/campaigns/${GOOGLE_ADS_ZIPGRIP_CAMPAIGN_ID}`;
}

function zipGripAssetGroupResource() {
	return `customers/${GOOGLE_ADS_ZIPGRIP_CUSTOMER_ID}/assetGroups/${GOOGLE_ADS_ZIPGRIP_ASSET_GROUP_ID}`;
}

async function getZipGripAssetState() {
	assertZipGripGoogleAdsAccount();
	const groups = await googleAdsSearch(`
		SELECT campaign.id, campaign.resource_name, campaign.name, campaign.status,
			campaign.advertising_channel_type, campaign.brand_guidelines_enabled,
			asset_group.id, asset_group.resource_name, asset_group.name, asset_group.status,
			asset_group.final_urls, asset_group.ad_strength, asset_group.primary_status,
			asset_group.primary_status_reasons
		FROM asset_group
		WHERE campaign.id = ${GOOGLE_ADS_ZIPGRIP_CAMPAIGN_ID}
			AND asset_group.id = ${GOOGLE_ADS_ZIPGRIP_ASSET_GROUP_ID}
		LIMIT 1
	`);
	if (groups.length !== 1) {
		throw new Error(
			"The locked ZipGrip campaign and asset group could not be uniquely verified.",
		);
	}
	const campaign = groups[0]?.campaign;
	const assetGroup = groups[0]?.assetGroup;
	if (
		String(campaign?.id) !== GOOGLE_ADS_ZIPGRIP_CAMPAIGN_ID ||
		campaign?.name !== GOOGLE_ADS_ZIPGRIP_CAMPAIGN_NAME ||
		campaign?.status !== "PAUSED" ||
		campaign?.advertisingChannelType !== "PERFORMANCE_MAX" ||
		String(assetGroup?.id) !== GOOGLE_ADS_ZIPGRIP_ASSET_GROUP_ID ||
		assetGroup?.status !== "PAUSED"
	) {
		throw new Error(
			"Refusing asset access: the locked campaign and asset group are not the expected PAUSED ZipGrip resources.",
		);
	}

	const assetGroupAssets = await googleAdsSearch(`
		SELECT asset_group_asset.resource_name, asset_group_asset.asset_group,
			asset_group_asset.asset, asset_group_asset.field_type,
			asset_group_asset.status, asset_group_asset.source,
			asset_group_asset.primary_status, asset_group_asset.primary_status_reasons,
			asset_group_asset.primary_status_details,
			asset_group_asset.policy_summary.approval_status,
			asset_group_asset.policy_summary.review_status,
			asset.id, asset.resource_name, asset.name, asset.type,
			asset.text_asset.text, asset.image_asset.full_size.url,
			asset.image_asset.full_size.width_pixels,
			asset.image_asset.full_size.height_pixels,
			asset.image_asset.file_size,
			asset.youtube_video_asset.youtube_video_id,
			asset.youtube_video_asset.youtube_video_title
		FROM asset_group_asset
		WHERE asset_group.id = ${GOOGLE_ADS_ZIPGRIP_ASSET_GROUP_ID}
			AND asset_group_asset.status != 'REMOVED'
		ORDER BY asset_group_asset.field_type, asset.id
	`);

	const campaignAssets = await googleAdsSearch(`
		SELECT campaign.id, campaign_asset.resource_name, campaign_asset.campaign,
			campaign_asset.asset, campaign_asset.field_type, campaign_asset.status,
			campaign_asset.source, campaign_asset.primary_status,
			campaign_asset.primary_status_reasons,
			asset.id, asset.resource_name, asset.name, asset.type,
			asset.text_asset.text, asset.image_asset.full_size.url,
			asset.image_asset.full_size.width_pixels,
			asset.image_asset.full_size.height_pixels,
			asset.image_asset.file_size
		FROM campaign_asset
		WHERE campaign.id = ${GOOGLE_ADS_ZIPGRIP_CAMPAIGN_ID}
			AND campaign_asset.status != 'REMOVED'
		ORDER BY campaign_asset.field_type, asset.id
	`);

	const counts: Record<string, number> = {};
	for (const row of assetGroupAssets) {
		const fieldType = row.assetGroupAsset?.fieldType;
		if (fieldType) counts[fieldType] = (counts[fieldType] ?? 0) + 1;
	}
	for (const row of campaignAssets) {
		const fieldType = row.campaignAsset?.fieldType;
		if (fieldType) counts[fieldType] = (counts[fieldType] ?? 0) + 1;
	}

	const brandGuidelinesEnabled = Boolean(campaign?.brandGuidelinesEnabled);
	const requiredTypes = [
		"HEADLINE",
		"LONG_HEADLINE",
		"DESCRIPTION",
		"MARKETING_IMAGE",
		"SQUARE_MARKETING_IMAGE",
		"BUSINESS_NAME",
		"LOGO",
	] as const;
	const completeness = Object.fromEntries(
		requiredTypes.map((fieldType) => {
			const requirement = ZIPGRIP_ASSET_REQUIREMENTS[fieldType];
			const count = counts[fieldType] ?? 0;
			return [
				fieldType,
				{
					count,
					minimum: requirement.min,
					maximum: requirement.max,
					meets_minimum: count >= requirement.min,
					missing: Math.max(0, requirement.min - count),
					link_level:
						brandGuidelinesEnabled &&
						(fieldType === "BUSINESS_NAME" || fieldType === "LOGO")
							? "CAMPAIGN"
							: "ASSET_GROUP",
				},
			];
		}),
	);

	return {
		campaign,
		asset_group: assetGroup,
		brand_guidelines_enabled: brandGuidelinesEnabled,
		brand_asset_link_level: brandGuidelinesEnabled ? "CAMPAIGN" : "ASSET_GROUP",
		asset_group_assets: assetGroupAssets,
		campaign_brand_assets: campaignAssets.filter((row) =>
			["BUSINESS_NAME", "LOGO", "LANDSCAPE_LOGO"].includes(row.campaignAsset?.fieldType),
		),
		counts,
		completeness,
		minimum_complete: Object.values(completeness).every((value) => value.meets_minimum),
		requirements: ZIPGRIP_ASSET_REQUIREMENTS,
		activation_tool_available: false,
	};
}

async function getZipGripExclusiveLaunchPlan() {
	const state = await getZipGripAssetState();
	if (!state.minimum_complete) {
		throw new Error(
			"Refusing launch: the locked ZipGrip asset group does not meet Google's minimum asset requirements.",
		);
	}
	const policyProblems = state.asset_group_assets.filter((row) => {
		const approval = row.assetGroupAsset?.policySummary?.approvalStatus;
		const review = row.assetGroupAsset?.policySummary?.reviewStatus;
		return (
			(approval && approval !== "APPROVED") ||
			(review && !["REVIEWED", "EXEMPT"].includes(review))
		);
	});
	if (policyProblems.length > 0) {
		throw new Error(
			"Refusing launch: one or more ZipGrip asset-group assets are not fully reviewed and approved.",
		);
	}
	if (
		state.asset_group?.finalUrls?.length !== 1 ||
		state.asset_group.finalUrls[0] !== GOOGLE_ADS_ZIPGRIP_FINAL_URL
	) {
		throw new Error(
			"Refusing launch: the dedicated ZipGrip asset group is not locked to the approved landing page.",
		);
	}
	const dedicatedSettings = await googleAdsSearch(`
		SELECT campaign.id, campaign.campaign_budget,
			campaign.maximize_conversion_value.target_roas,
			campaign_budget.amount_micros
		FROM campaign
		WHERE campaign.id = ${GOOGLE_ADS_ZIPGRIP_CAMPAIGN_ID}
		LIMIT 1
	`);
	if (
		dedicatedSettings.length !== 1 ||
		String(dedicatedSettings[0]?.campaignBudget?.amountMicros) !== "20000000" ||
		dedicatedSettings[0]?.campaign?.maximizeConversionValue?.targetRoas != null
	) {
		throw new Error(
			"Refusing launch: the dedicated ZipGrip campaign must remain at A$20/day with no target ROAS.",
		);
	}

	const sourcePmaxFilters = await googleAdsSearch(`
		SELECT campaign.id, campaign.name, campaign.status,
			asset_group.id, asset_group.name, asset_group.status,
			asset_group_listing_group_filter.id,
			asset_group_listing_group_filter.resource_name,
			asset_group_listing_group_filter.parent_listing_group_filter,
			asset_group_listing_group_filter.type,
			asset_group_listing_group_filter.listing_source,
			asset_group_listing_group_filter.case_value.product_item_id.value
		FROM asset_group_listing_group_filter
		WHERE campaign.id = ${GOOGLE_ADS_ZIPGRIP_SOURCE_PMAX_ID}
			AND asset_group.status != 'REMOVED'
	`);
	const sourceShoppingCriteria = await googleAdsSearch(`
		SELECT campaign.id, campaign.name, campaign.status,
			ad_group.id, ad_group.name, ad_group.status,
			ad_group_criterion.resource_name, ad_group_criterion.criterion_id,
			ad_group_criterion.negative, ad_group_criterion.status,
			ad_group_criterion.cpc_bid_micros,
			ad_group_criterion.listing_group.type,
			ad_group_criterion.listing_group.parent_ad_group_criterion,
			ad_group_criterion.listing_group.case_value.product_item_id.value
		FROM ad_group_criterion
		WHERE campaign.id IN (${GOOGLE_ADS_ZIPGRIP_SOURCE_SHOPPING_IDS.join(", ")})
			AND ad_group.status != 'REMOVED'
			AND ad_group_criterion.type = 'LISTING_GROUP'
			AND ad_group_criterion.status != 'REMOVED'
	`);

	const pmaxByGroup = new Map<string, any[]>();
	for (const row of sourcePmaxFilters) {
		const id = String(row.assetGroup?.id ?? "");
		if (!id) continue;
		pmaxByGroup.set(id, [...(pmaxByGroup.get(id) ?? []), row]);
	}
	const shoppingByGroup = new Map<string, any[]>();
	for (const row of sourceShoppingCriteria) {
		const id = String(row.adGroup?.id ?? "");
		if (!id) continue;
		shoppingByGroup.set(id, [...(shoppingByGroup.get(id) ?? []), row]);
	}
	if (pmaxByGroup.size === 0 || shoppingByGroup.size === 0) {
		throw new Error(
			"Refusing launch: one or more locked source campaigns has no inspectable product-partition tree.",
		);
	}

	const operations: any[] = [];
	let tempId = -9000;
	for (const [assetGroupId, rows] of pmaxByGroup) {
		if (
			rows.length !== 1 ||
			rows[0]?.assetGroupListingGroupFilter?.parentListingGroupFilter ||
			rows[0]?.assetGroupListingGroupFilter?.type !== "UNIT_INCLUDED"
		) {
			throw new Error(
				`Refusing launch: source PMax asset group ${assetGroupId} is not the supported single-node All products tree.`,
			);
		}
		const existing = rows[0].assetGroupListingGroupFilter.resourceName;
		const assetGroup =
			rows[0].assetGroup.resourceName ??
			`customers/${GOOGLE_ADS_ZIPGRIP_CUSTOMER_ID}/assetGroups/${assetGroupId}`;
		const root = `customers/${GOOGLE_ADS_ZIPGRIP_CUSTOMER_ID}/assetGroupListingGroupFilters/${assetGroupId}~${tempId--}`;
		operations.push(
			{ assetGroupListingGroupFilterOperation: { remove: existing } },
			{
				assetGroupListingGroupFilterOperation: {
					create: {
						resourceName: root,
						assetGroup,
						type: "SUBDIVISION",
						listingSource: "SHOPPING",
					},
				},
			},
			{
				assetGroupListingGroupFilterOperation: {
					create: {
						resourceName: `customers/${GOOGLE_ADS_ZIPGRIP_CUSTOMER_ID}/assetGroupListingGroupFilters/${assetGroupId}~${tempId--}`,
						assetGroup,
						parentListingGroupFilter: root,
						type: "UNIT_EXCLUDED",
						listingSource: "SHOPPING",
						caseValue: { productItemId: { value: GOOGLE_ADS_ZIPGRIP_ITEM_ID } },
					},
				},
			},
			{
				assetGroupListingGroupFilterOperation: {
					create: {
						resourceName: `customers/${GOOGLE_ADS_ZIPGRIP_CUSTOMER_ID}/assetGroupListingGroupFilters/${assetGroupId}~${tempId--}`,
						assetGroup,
						parentListingGroupFilter: root,
						type: "UNIT_INCLUDED",
						listingSource: "SHOPPING",
						caseValue: { productItemId: {} },
					},
				},
			},
		);
	}

	for (const [adGroupId, rows] of shoppingByGroup) {
		if (
			rows.length !== 1 ||
			rows[0]?.adGroupCriterion?.listingGroup?.parentAdGroupCriterion ||
			rows[0]?.adGroupCriterion?.listingGroup?.type !== "UNIT" ||
			rows[0]?.adGroupCriterion?.negative
		) {
			throw new Error(
				`Refusing launch: source Shopping ad group ${adGroupId} is not the supported single-node All products tree.`,
			);
		}
		const existingCriterion = rows[0].adGroupCriterion;
		const adGroup =
			rows[0].adGroup.resourceName ??
			`customers/${GOOGLE_ADS_ZIPGRIP_CUSTOMER_ID}/adGroups/${adGroupId}`;
		const root = `customers/${GOOGLE_ADS_ZIPGRIP_CUSTOMER_ID}/adGroupCriteria/${adGroupId}~${tempId--}`;
		const includedOther: any = {
			resourceName: `customers/${GOOGLE_ADS_ZIPGRIP_CUSTOMER_ID}/adGroupCriteria/${adGroupId}~${tempId--}`,
			adGroup,
			status: "ENABLED",
			negative: false,
			listingGroup: {
				type: "UNIT",
				parentAdGroupCriterion: root,
				caseValue: { productItemId: {} },
			},
		};
		if (existingCriterion.cpcBidMicros)
			includedOther.cpcBidMicros = existingCriterion.cpcBidMicros;
		operations.push(
			{ adGroupCriterionOperation: { remove: existingCriterion.resourceName } },
			{
				adGroupCriterionOperation: {
					create: {
						resourceName: root,
						adGroup,
						status: "ENABLED",
						negative: false,
						listingGroup: { type: "SUBDIVISION" },
					},
				},
			},
			{
				adGroupCriterionOperation: {
					create: {
						resourceName: `customers/${GOOGLE_ADS_ZIPGRIP_CUSTOMER_ID}/adGroupCriteria/${adGroupId}~${tempId--}`,
						adGroup,
						status: "ENABLED",
						negative: true,
						listingGroup: {
							type: "UNIT",
							parentAdGroupCriterion: root,
							caseValue: { productItemId: { value: GOOGLE_ADS_ZIPGRIP_ITEM_ID } },
						},
					},
				},
			},
			{ adGroupCriterionOperation: { create: includedOther } },
		);
	}

	operations.push(
		{
			assetGroupOperation: {
				update: { resourceName: zipGripAssetGroupResource(), status: "ENABLED" },
				updateMask: "status",
			},
		},
		{
			campaignOperation: {
				update: { resourceName: zipGripCampaignResource(), status: "ENABLED" },
				updateMask: "status",
			},
		},
	);
	return { state, sourcePmaxFilters, sourceShoppingCriteria, operations };
}

function googleAdsAssetResource(assetId: string) {
	return `customers/${GOOGLE_ADS_ZIPGRIP_CUSTOMER_ID}/assets/${assetId}`;
}

function buildAssetLinkOperation(
	assetResource: string,
	fieldType: string,
	brandGuidelinesEnabled: boolean,
) {
	const isBrandAsset = ["BUSINESS_NAME", "LOGO", "LANDSCAPE_LOGO"].includes(fieldType);
	if (brandGuidelinesEnabled && isBrandAsset) {
		return {
			campaignAssetOperation: {
				create: {
					campaign: zipGripCampaignResource(),
					asset: assetResource,
					fieldType,
					status: "ENABLED",
				},
			},
		};
	}
	return {
		assetGroupAssetOperation: {
			create: {
				assetGroup: zipGripAssetGroupResource(),
				asset: assetResource,
				fieldType,
				status: "ENABLED",
			},
		},
	};
}

async function reusableTextAssets() {
	const rows = await googleAdsSearch(`
		SELECT asset.id, asset.resource_name, asset.name, asset.text_asset.text
		FROM asset
		WHERE asset.type = 'TEXT'
		LIMIT 10000
	`);
	return new Map(
		rows
			.filter((row) => typeof row.asset?.textAsset?.text === "string")
			.map((row) => [row.asset.textAsset.text, row.asset.resourceName] as const),
	);
}

async function reusableYoutubeAssets() {
	const rows = await googleAdsSearch(`
		SELECT asset.id, asset.resource_name, asset.name,
			asset.youtube_video_asset.youtube_video_id,
			asset.youtube_video_asset.youtube_video_title
		FROM asset
		WHERE asset.type = 'YOUTUBE_VIDEO'
		LIMIT 10000
	`);
	return new Map(
		rows
			.filter((row) => typeof row.asset?.youtubeVideoAsset?.youtubeVideoId === "string")
			.map(
				(row) =>
					[row.asset.youtubeVideoAsset.youtubeVideoId, row.asset.resourceName] as const,
			),
	);
}

function imageDimensions(bytes: Uint8Array, mimeType: "image/jpeg" | "image/png") {
	if (!hasExpectedImageSignature(bytes, mimeType)) {
		throw new Error(`Image data does not match declared MIME type ${mimeType}.`);
	}
	if (mimeType === "image/png") {
		if (bytes.length < 24) throw new Error("PNG data is truncated.");
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		return { width: view.getUint32(16), height: view.getUint32(20) };
	}
	let offset = 2;
	while (offset + 9 < bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset++;
			continue;
		}
		const marker = bytes[offset + 1];
		if (marker === 0xd8 || marker === 0xd9) {
			offset += 2;
			continue;
		}
		if (offset + 3 >= bytes.length) break;
		const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
		if (length < 2 || offset + 2 + length > bytes.length) break;
		if (
			(marker >= 0xc0 && marker <= 0xc3) ||
			(marker >= 0xc5 && marker <= 0xc7) ||
			(marker >= 0xc9 && marker <= 0xcb) ||
			(marker >= 0xcd && marker <= 0xcf)
		) {
			return {
				height: (bytes[offset + 5] << 8) | bytes[offset + 6],
				width: (bytes[offset + 7] << 8) | bytes[offset + 8],
			};
		}
		offset += 2 + length;
	}
	throw new Error("JPEG dimensions could not be read.");
}

function validateZipGripImage(
	bytes: Uint8Array,
	mimeType: "image/jpeg" | "image/png",
	fieldType:
		| "MARKETING_IMAGE"
		| "SQUARE_MARKETING_IMAGE"
		| "PORTRAIT_MARKETING_IMAGE"
		| "LOGO"
		| "LANDSCAPE_LOGO",
) {
	if (bytes.length > 5_120_000) throw new Error("Image exceeds Google's 5,120 KB limit.");
	const dimensions = imageDimensions(bytes, mimeType);
	const rules = {
		MARKETING_IMAGE: { ratio: 1.91, minWidth: 600, minHeight: 314 },
		SQUARE_MARKETING_IMAGE: { ratio: 1, minWidth: 300, minHeight: 300 },
		PORTRAIT_MARKETING_IMAGE: { ratio: 0.8, minWidth: 480, minHeight: 600 },
		LOGO: { ratio: 1, minWidth: 128, minHeight: 128 },
		LANDSCAPE_LOGO: { ratio: 4, minWidth: 512, minHeight: 128 },
	}[fieldType];
	if (dimensions.width < rules.minWidth || dimensions.height < rules.minHeight) {
		throw new Error(
			`${fieldType} is ${dimensions.width}x${dimensions.height}; minimum is ${rules.minWidth}x${rules.minHeight}.`,
		);
	}
	const ratio = dimensions.width / dimensions.height;
	if (Math.abs(ratio - rules.ratio) > 0.02) {
		throw new Error(
			`${fieldType} aspect ratio is ${ratio.toFixed(3)}; required ratio is ${rules.ratio}.`,
		);
	}
	return { ...dimensions, bytes: bytes.length, aspect_ratio: ratio };
}

function googleAdsMetrics(metrics: any = {}) {
	const cost = Number(metrics.costMicros ?? 0) / 1_000_000;
	const conversions = Number(metrics.conversions ?? 0);
	const conversionValue = Number(metrics.conversionsValue ?? 0);
	return {
		impressions: Number(metrics.impressions ?? 0),
		clicks: Number(metrics.clicks ?? 0),
		cost_aud: cost,
		ctr: Number(metrics.ctr ?? 0),
		average_cpc_aud: Number(metrics.averageCpc ?? 0) / 1_000_000,
		conversions,
		conversion_value: conversionValue,
		all_conversions: Number(metrics.allConversions ?? 0),
		all_conversion_value: Number(metrics.allConversionsValue ?? 0),
		cost_per_conversion_aud: conversions > 0 ? cost / conversions : null,
		reported_roas: cost > 0 ? conversionValue / cost : null,
	};
}

function normalizeGoogleAdsRows(rows: any[]) {
	return rows.map((row) => ({
		...row,
		...(row.metrics ? { metrics: googleAdsMetrics(row.metrics) } : {}),
	}));
}

function ga4ReportResult(report: any, startDate: string, endDate: string) {
	const dimensionNames = (report.dimensionHeaders ?? []).map((header: any) => header.name);
	const metricNames = (report.metricHeaders ?? []).map((header: any) => header.name);
	const rows = (report.rows ?? []).map((row: any) => ({
		...Object.fromEntries(
			dimensionNames.map((name: string, index: number) => [
				name,
				row.dimensionValues?.[index]?.value ?? "",
			]),
		),
		...Object.fromEntries(
			metricNames.map((name: string, index: number) => [
				name,
				row.metricValues?.[index]?.value ?? "0",
			]),
		),
	}));

	return {
		start_date: startDate,
		end_date: endDate,
		row_count: report.rowCount ?? rows.length,
		rows,
		property_quota: report.propertyQuota,
	};
}

async function getAllOrders(startDate: string, endDate: string) {
	const allOrders: any[] = [];
	const perPage = 100;
	const maxPages = 50;

	for (let page = 1; page <= maxPages; page++) {
		const response = await wcFetch("orders", {
			after: `${startDate}T00:00:00`,
			before: `${endDate}T23:59:59`,
			per_page: perPage,
			page,
			orderby: "date",
			order: "asc",
		});

		const orders = await response.json<any[]>();

		allOrders.push(...orders);

		if (orders.length < perPage) {
			break;
		}
	}

	return allOrders;
}

function isGenuineCommercialOrder(order: any) {
	const total = Number(order.total ?? 0);

	return total > GENUINE_ORDER_MIN_TOTAL && GENUINE_STATUSES.has(order.status);
}

function normaliseCohortEmail(value: unknown) {
	if (typeof value !== "string") return null;
	const email = value.trim().toLowerCase();
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function normaliseCohortPhone(value: unknown) {
	if (typeof value !== "string" && typeof value !== "number") return null;
	const digits = String(value).replace(/\D/g, "");
	if (digits.length < 8) return null;
	return digits.startsWith("61") && digits.length >= 10
		? digits.slice(2)
		: digits.replace(/^0/, "");
}

function zipGripTextMatches(value: unknown) {
	const text = String(value ?? "").toLowerCase();
	return (
		text.includes("zipgrip") ||
		text.includes("zip-grip") ||
		text.includes("zip sided") ||
		text.includes("zip-sided") ||
		text.includes("zipsided") ||
		text.includes("zip guided") ||
		text.includes("zip-guided") ||
		text.includes("zipscreen") ||
		text.includes("zip screen")
	);
}

function isSampleLineItem(item: any) {
	return /sample/i.test(String(item?.name ?? "")) || /sample/i.test(String(item?.sku ?? ""));
}

function isZipGripSampleOrder(order: any) {
	if (!GENUINE_STATUSES.has(String(order?.status ?? ""))) return false;
	const lineItems = Array.isArray(order?.line_items) ? order.line_items : [];
	const explicitZipSample = lineItems.some(
		(item: any) =>
			isSampleLineItem(item) &&
			zipGripTextMatches(String(item?.name ?? "") + " " + String(item?.sku ?? "")),
	);
	if (explicitZipSample) return true;

	const hasGenericSample = lineItems.some((item: any) => isSampleLineItem(item));
	return hasGenericSample && safeOrderAttribution(order).sample_intent === "ZipGrip";
}

function zipGripPurchaseLineRevenue(order: any) {
	return (Array.isArray(order?.line_items) ? order.line_items : []).reduce(
		(total: number, item: any) => {
			if (isSampleLineItem(item)) return total;
			if (!zipGripTextMatches(String(item?.name ?? "") + " " + String(item?.sku ?? ""))) {
				return total;
			}
			return total + Number(item?.total ?? 0);
		},
		0,
	);
}

function isZipGripPurchaseOrder(order: any) {
	return isGenuineCommercialOrder(order) && zipGripPurchaseLineRevenue(order) > 0;
}

function cohortDateMs(value: unknown) {
	const date = String(value ?? "").slice(0, 10);
	const ms = Date.parse(date + "T00:00:00Z");
	return Number.isFinite(ms) ? ms : null;
}

function cohortTimestampMs(value: unknown) {
	const ms = Date.parse(String(value ?? ""));
	return Number.isFinite(ms) ? ms : null;
}

function cohortMedian(values: number[]) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function cohortDaysBetween(start: unknown, end: unknown) {
	const startMs = cohortDateMs(start);
	const endMs = cohortDateMs(end);
	if (startMs === null || endMs === null) return null;
	return Math.floor((endMs - startMs) / 86_400_000);
}

function safeOrderAttribution(order: any) {
	const meta = Array.isArray(order?.meta_data) ? order.meta_data : [];

	const getMeta = (key: string) => {
		const item = meta.find((entry: any) => entry?.key === key);
		return item?.value ?? null;
	};

	const sessionEntry = getMeta("_wc_order_attribution_session_entry");

	let gclid: string | null = null;
	let gbraid: string | null = null;
	let gadCampaignId: string | null = null;
	let landingPath: string | null = null;
	let landingProduct: string | null = null;
	let sampleIntent: "ZipGrip" | "Outdoor" | "Roller" | "Unknown" = "Unknown";

	if (typeof sessionEntry === "string" && sessionEntry.trim()) {
		try {
			const url = new URL(sessionEntry);

			gclid = url.searchParams.get("gclid");
			gbraid = url.searchParams.get("gbraid");
			gadCampaignId = url.searchParams.get("gad_campaignid");
			landingPath = url.pathname || "/";

			const searchable = `${url.pathname} ${url.search}`.toLowerCase();

			// Most-specific classification first.
			if (
				searchable.includes("zipgrip") ||
				searchable.includes("zip-grip") ||
				searchable.includes("zip-sided") ||
				searchable.includes("zip-sided-outdoor") ||
				searchable.includes("zip-guided") ||
				searchable.includes("zipsided") ||
				searchable.includes("zipscreen")
			) {
				sampleIntent = "ZipGrip";
				landingProduct = "ZipGrip / Zip Sided Outdoor Blinds";
			} else if (
				searchable.includes("outdoor-blind") ||
				searchable.includes("outdoor_blind") ||
				searchable.includes("outdoor")
			) {
				sampleIntent = "Outdoor";
				landingProduct = "Outdoor Blinds";
			} else if (
				searchable.includes("roller-blind") ||
				searchable.includes("roller_blind") ||
				searchable.includes("roller")
			) {
				sampleIntent = "Roller";
				landingProduct = "Roller Blinds";
			}
		} catch {
			// Preserve the native Woo attribution even if session_entry
			// is not a valid absolute URL.
		}
	}

	return {
		source_type: getMeta("_wc_order_attribution_source_type"),
		referrer: getMeta("_wc_order_attribution_referrer"),
		utm_campaign: getMeta("_wc_order_attribution_utm_campaign"),
		utm_source: getMeta("_wc_order_attribution_utm_source"),
		utm_medium: getMeta("_wc_order_attribution_utm_medium"),
		utm_content: getMeta("_wc_order_attribution_utm_content"),
		utm_id: getMeta("_wc_order_attribution_utm_id"),
		utm_term: getMeta("_wc_order_attribution_utm_term"),
		utm_source_platform: getMeta("_wc_order_attribution_utm_source_platform"),
		utm_creative_format: getMeta("_wc_order_attribution_utm_creative_format"),
		utm_marketing_tactic: getMeta("_wc_order_attribution_utm_marketing_tactic"),

		gclid,
		gbraid,
		gad_campaignid: gadCampaignId,
		landing_path: landingPath,
		landing_product: landingProduct,
		sample_intent: sampleIntent,

		session_entry: sessionEntry,
		session_start_time: getMeta("_wc_order_attribution_session_start_time"),
		session_pages: getMeta("_wc_order_attribution_session_pages"),
		session_count: getMeta("_wc_order_attribution_session_count"),
	};
}

function safeOrder(order: any) {
	return {
		id: order.id,
		date_created: order.date_created,
		status: order.status,
		customer_id: order.customer_id,
		currency: order.currency,
		total: order.total,
		discount_total: order.discount_total,
		shipping_total: order.shipping_total,
		payment_method_title: order.payment_method_title,
		attribution: safeOrderAttribution(order),
		line_items: order.line_items?.map((item: any) => ({
			product_id: item.product_id,
			variation_id: item.variation_id,
			name: item.name,
			sku: item.sku,
			quantity: item.quantity,
			subtotal: item.subtotal,
			total: item.total,
		})),
		coupon_lines: order.coupon_lines?.map((coupon: any) => ({
			code: coupon.code,
			discount: coupon.discount,
		})),
	};
}

function toolResult(data: any) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(data, null, 2),
			},
		],
	};
}

function toolError(error: unknown) {
	return {
		content: [
			{
				type: "text" as const,
				text: error instanceof Error ? error.message : String(error),
			},
		],
		isError: true,
	};
}

function createServer() {
	const server = new McpServer({
		name: "Blindmotion WooCommerce",
		version: "2.0.0",
	});

	/*
	 * Existing test tools
	 */

	server.registerTool(
		"add",
		{
			inputSchema: z.object({
				a: z.number(),
				b: z.number(),
			}),
		},
		async ({ a, b }) => ({
			content: [
				{
					type: "text",
					text: String(a + b),
				},
			],
		}),
	);

	server.registerTool(
		"calculate",
		{
			inputSchema: z.object({
				operation: z.enum(["add", "subtract", "multiply", "divide"]),
				a: z.number(),
				b: z.number(),
			}),
		},
		async ({ operation, a, b }) => {
			let result: number;

			switch (operation) {
				case "add":
					result = a + b;
					break;

				case "subtract":
					result = a - b;
					break;

				case "multiply":
					result = a * b;
					break;

				case "divide":
					if (b === 0) {
						return {
							content: [
								{
									type: "text",
									text: "Error: Cannot divide by zero",
								},
							],
						};
					}

					result = a / b;
					break;
			}

			return {
				content: [
					{
						type: "text",
						text: String(result),
					},
				],
			};
		},
	);

	/*
	 * Existing working WooCommerce tool
	 */

	server.registerTool(
		"get_recent_orders",
		{
			description: "Return recent Blindmotion WooCommerce orders without customer PII",
			inputSchema: z.object({
				limit: z.number().int().min(1).max(20),
			}),
		},
		async ({ limit }) => {
			try {
				const response = await wcFetch("orders", {
					per_page: limit,
					orderby: "date",
					order: "desc",
				});

				const orders = await response.json<any[]>();

				return toolResult(orders.map(safeOrder));
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/*
	 * 1. Sales Summary
	 */

	server.registerTool(
		"get_sales_summary",
		{
			description:
				"Summarise genuine Blindmotion commercial orders, revenue, AOV and discounts for a date range. Orders of $20 or less and non-commercial statuses are excluded.",
			inputSchema: z.object({
				start_date: z.string(),
				end_date: z.string(),
			}),
		},
		async ({ start_date, end_date }) => {
			try {
				const orders = await getAllOrders(start_date, end_date);

				const genuineOrders = orders.filter(isGenuineCommercialOrder);

				const revenue = genuineOrders.reduce(
					(sum, order) => sum + Number(order.total ?? 0),
					0,
				);

				const discounts = genuineOrders.reduce(
					(sum, order) => sum + Number(order.discount_total ?? 0),
					0,
				);

				const shipping = genuineOrders.reduce(
					(sum, order) => sum + Number(order.shipping_total ?? 0),
					0,
				);

				const orderCount = genuineOrders.length;

				const statusCounts: Record<string, number> = {};

				for (const order of genuineOrders) {
					statusCounts[order.status] = (statusCounts[order.status] ?? 0) + 1;
				}

				const sampleOrLowValueOrders = orders.filter(
					(order) => Number(order.total ?? 0) <= GENUINE_ORDER_MIN_TOTAL,
				).length;

				return toolResult({
					start_date,
					end_date,
					commercial_start_date: COMMERCIAL_START_DATE,
					genuine_order_min_total: GENUINE_ORDER_MIN_TOTAL,
					genuine_statuses: Array.from(GENUINE_STATUSES),
					order_count: orderCount,
					revenue: Number(revenue.toFixed(2)),
					average_order_value:
						orderCount > 0 ? Number((revenue / orderCount).toFixed(2)) : 0,
					discount_total: Number(discounts.toFixed(2)),
					shipping_total: Number(shipping.toFixed(2)),
					status_counts: statusCounts,
					sample_or_low_value_orders: sampleOrLowValueOrders,
					all_orders_in_period: orders.length,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/*
	 * 2. Query Orders
	 */

	server.registerTool(
		"get_zipgrip_sample_to_purchase_cohort",
		{
			description:
				"Measure ZipGrip sample-to-purchase conversion using privacy-safe first-party WooCommerce matching. Email/phone matching occurs only inside the Worker; no customer PII is returned.",
			inputSchema: z.object({
				start_date: z.string().date(),
				end_date: z.string().date(),
				as_of_date: z.string().date().optional(),
				windows_days: z
					.array(z.number().int().min(7).max(365))
					.min(1)
					.max(8)
					.default([30, 60, 90, 180]),
				gross_margin_pct: z.number().min(0).max(100).default(51),
			}),
		},
		async ({ start_date, end_date, as_of_date, windows_days, gross_margin_pct }) => {
			try {
				const asOfDate = as_of_date ?? new Date().toISOString().slice(0, 10);
				const startMs = cohortDateMs(start_date);
				const endMs = cohortDateMs(end_date);
				const asOfMs = cohortDateMs(asOfDate);
				if (startMs === null || endMs === null || asOfMs === null) {
					throw new Error("Invalid cohort date supplied.");
				}
				if (startMs > endMs) throw new Error("start_date must be on or before end_date.");
				if (endMs > asOfMs) throw new Error("end_date cannot be after as_of_date.");
				if ((asOfMs - startMs) / 86_400_000 > 730) {
					throw new Error("Cohort analysis is capped at 730 days per request.");
				}

				const windows = [...new Set(windows_days)].sort((a, b) => a - b);
				const orders = await getAllOrders(start_date, asOfDate);
				const sampleOrders = orders.filter((order) => {
					const orderMs = cohortDateMs(order?.date_created);
					return (
						orderMs !== null &&
						orderMs >= startMs &&
						orderMs <= endMs &&
						isZipGripSampleOrder(order)
					);
				});
				const purchaseOrders = orders.filter(isZipGripPurchaseOrder);

				type CohortCustomer = {
					identity_key: string;
					matchable: boolean;
					email: string | null;
					phone: string | null;
					customer_id: number | null;
					first_sample_order_id: number;
					first_sample_date: string;
					sample_order_ids: number[];
				};

				const customers = new Map<string, CohortCustomer>();
				for (const order of [...sampleOrders].sort(
					(a, b) =>
						Number(cohortDateMs(a?.date_created)) -
						Number(cohortDateMs(b?.date_created)),
				)) {
					const email = normaliseCohortEmail(order?.billing?.email);
					const phone = normaliseCohortPhone(order?.billing?.phone);
					const customerId =
						Number(order?.customer_id ?? 0) > 0 ? Number(order.customer_id) : null;
					const identityKey = email
						? "email:" + email
						: phone
							? "phone:" + phone
							: customerId
								? "customer:" + String(customerId)
								: "unmatchable:" + String(order.id);
					const existing = customers.get(identityKey);
					if (existing) {
						existing.sample_order_ids.push(Number(order.id));
						continue;
					}
					customers.set(identityKey, {
						identity_key: identityKey,
						matchable: Boolean(email || phone || customerId),
						email,
						phone,
						customer_id: customerId,
						first_sample_order_id: Number(order.id),
						first_sample_date: String(order.date_created).slice(0, 10),
						sample_order_ids: [Number(order.id)],
					});
				}

				const customerRecords = [...customers.values()];
				const matchableCustomers = customerRecords.filter((customer) => customer.matchable);

				function purchaseMatchMethod(customer: CohortCustomer, order: any) {
					const purchaseEmail = normaliseCohortEmail(order?.billing?.email);
					if (customer.email && purchaseEmail === customer.email) return "email" as const;
					const purchasePhone = normaliseCohortPhone(order?.billing?.phone);
					if (customer.phone && purchasePhone === customer.phone) return "phone" as const;
					if (
						customer.customer_id &&
						Number(order?.customer_id ?? 0) === customer.customer_id
					) {
						return "customer_id" as const;
					}
					return null;
				}

				const windowResults = windows.map((windowDays) => {
					const matured = matchableCustomers.filter((customer) => {
						const sampleMs = cohortDateMs(customer.first_sample_date)!;
						return sampleMs + windowDays * 86_400_000 <= asOfMs;
					});
					const conversions: any[] = [];
					for (const customer of matured) {
						const sampleMs = cohortDateMs(customer.first_sample_date)!;
						const sampleTimestampMs =
							cohortTimestampMs(
								sampleOrders.find(
									(order) => Number(order.id) === customer.first_sample_order_id,
								)?.date_created,
							) ?? sampleMs;
						const windowEndMs = sampleMs + windowDays * 86_400_000;
						const matched = purchaseOrders
							.map((order) => ({
								order,
								match_method: purchaseMatchMethod(customer, order),
							}))
							.filter(({ order, match_method }) => {
								if (!match_method) return false;
								const purchaseMs = cohortDateMs(order?.date_created);
								const purchaseTimestampMs = cohortTimestampMs(order?.date_created);
								return (
									purchaseMs !== null &&
									purchaseTimestampMs !== null &&
									purchaseTimestampMs > sampleTimestampMs &&
									purchaseMs <= windowEndMs
								);
							})
							.sort(
								(a, b) =>
									Number(cohortDateMs(a.order?.date_created)) -
									Number(cohortDateMs(b.order?.date_created)),
							);
						if (!matched.length) continue;
						const first = matched[0];
						const orderRevenue = matched.reduce(
							(total, row) => total + Number(row.order?.total ?? 0),
							0,
						);
						const zipGripRevenue = matched.reduce(
							(total, row) => total + zipGripPurchaseLineRevenue(row.order),
							0,
						);
						conversions.push({
							first_sample_order_id: customer.first_sample_order_id,
							sample_order_ids: customer.sample_order_ids,
							first_sample_date: customer.first_sample_date,
							match_method: first.match_method,
							first_purchase_order_id: Number(first.order.id),
							first_purchase_date: String(first.order.date_created).slice(0, 10),
							days_to_first_purchase: cohortDaysBetween(
								customer.first_sample_date,
								first.order.date_created,
							),
							purchase_order_ids: matched.map((row) => Number(row.order.id)),
							qualifying_order_revenue_aud: orderRevenue,
							zipgrip_line_revenue_aud: zipGripRevenue,
						});
					}

					const totalOrderRevenue = conversions.reduce(
						(total, conversion) => total + conversion.qualifying_order_revenue_aud,
						0,
					);
					const totalZipGripRevenue = conversions.reduce(
						(total, conversion) => total + conversion.zipgrip_line_revenue_aud,
						0,
					);
					const maturedCount = matured.length;
					const convertedCount = conversions.length;
					const matchMethodCounts = conversions.reduce(
						(counts, conversion) => {
							counts[conversion.match_method] =
								(counts[conversion.match_method] ?? 0) + 1;
							return counts;
						},
						{} as Record<string, number>,
					);
					const expectedOrderRevenue = maturedCount
						? totalOrderRevenue / maturedCount
						: null;
					const expectedZipGripRevenue = maturedCount
						? totalZipGripRevenue / maturedCount
						: null;
					return {
						window_days: windowDays,
						matured_matchable_sample_customers: maturedCount,
						converted_customers: convertedCount,
						conversion_rate: maturedCount ? convertedCount / maturedCount : null,
						match_methods: matchMethodCounts,
						purchase_order_count: conversions.reduce(
							(total, conversion) => total + conversion.purchase_order_ids.length,
							0,
						),
						qualifying_order_revenue_aud: totalOrderRevenue,
						zipgrip_line_revenue_aud: totalZipGripRevenue,
						average_qualifying_order_revenue_per_converted_customer_aud: convertedCount
							? totalOrderRevenue / convertedCount
							: null,
						median_qualifying_order_revenue_per_converted_customer_aud: cohortMedian(
							conversions.map(
								(conversion) => conversion.qualifying_order_revenue_aud,
							),
						),
						median_days_to_first_purchase: cohortMedian(
							conversions
								.map((conversion) => conversion.days_to_first_purchase)
								.filter((value): value is number => typeof value === "number"),
						),
						expected_qualifying_order_revenue_per_matured_sample_customer_aud:
							expectedOrderRevenue,
						expected_zipgrip_line_revenue_per_matured_sample_customer_aud:
							expectedZipGripRevenue,
						expected_gross_profit_per_matured_sample_customer_aud:
							expectedZipGripRevenue === null
								? null
								: expectedZipGripRevenue * (gross_margin_pct / 100),
						matches: conversions,
					};
				});

				return toolResult({
					cohort: {
						start_date,
						end_date,
						as_of_date: asOfDate,
						gross_margin_pct,
					},
					sample_order_count: sampleOrders.length,
					unique_sample_customers: customerRecords.length,
					matchable_sample_customers: matchableCustomers.length,
					unmatchable_sample_customers:
						customerRecords.length - matchableCustomers.length,
					identity_coverage_rate: customerRecords.length
						? matchableCustomers.length / customerRecords.length
						: null,
					windows: windowResults,
					privacy: {
						billing_email_returned: false,
						billing_phone_returned: false,
						matching_performed_inside_worker: true,
						match_priority: ["email", "phone", "customer_id"],
					},
					methodology: {
						sample_definition:
							"Zip-labelled sample product, or a generic sample order whose native Woo attribution is classified as ZipGrip intent.",
						purchase_definition:
							"Later genuine commercial WooCommerce order containing non-sample ZipGrip/Zip Sided/zip-guided line-item revenue.",
						denominator:
							"Unique matchable sample customers mature enough to have completed each requested conversion window.",
					},
					read_only: true,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_orders",
		{
			description:
				"Query Blindmotion WooCommerce orders by date range and optional status. Returns order and line-item data without customer PII.",
			inputSchema: z.object({
				start_date: z.string(),
				end_date: z.string(),
				status: z.string().optional(),
				limit: z.number().int().min(1).max(100),
			}),
		},
		async ({ start_date, end_date, status, limit }) => {
			try {
				const response = await wcFetch("orders", {
					after: `${start_date}T00:00:00`,
					before: `${end_date}T23:59:59`,
					status,
					per_page: limit,
					orderby: "date",
					order: "desc",
				});

				const orders = await response.json<any[]>();

				return toolResult(orders.map(safeOrder));
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/*
	 * 3. Products
	 */

	server.registerTool(
		"get_products",
		{
			description:
				"Return Blindmotion WooCommerce products including product ID, SKU, price, status and categories.",
			inputSchema: z.object({
				search: z.string().optional(),
				status: z.string().optional(),
				category_id: z.number().int().optional(),
				limit: z.number().int().min(1).max(100),
			}),
		},
		async ({ search, status, category_id, limit }) => {
			try {
				const response = await wcFetch("products", {
					search,
					status,
					category: category_id,
					per_page: limit,
					orderby: "title",
					order: "asc",
				});

				const products = await response.json<any[]>();

				const safeProducts = products.map((product) => ({
					id: product.id,
					name: product.name,
					slug: product.slug,
					sku: product.sku,
					status: product.status,
					type: product.type,
					price: product.price,
					regular_price: product.regular_price,
					sale_price: product.sale_price,
					on_sale: product.on_sale,
					stock_status: product.stock_status,
					categories: product.categories?.map((category: any) => ({
						id: category.id,
						name: category.name,
						slug: category.slug,
					})),
				}));

				return toolResult(safeProducts);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"clone_product_as_draft_guarded",
		{
			description:
				"Clone one exactly identified WooCommerce product while forcing the new product to DRAFT and hidden catalogue visibility. The source is never modified and activation/publication is impossible.",
			inputSchema: z.object({
				source_product_id: z.number().int().positive(),
				expected_source_name: z.string().trim().min(1).max(200),
				new_name: z.string().trim().min(3).max(200),
				confirmation: z.literal(CLONE_PRODUCT_CONFIRMATION),
			}),
		},
		async ({ source_product_id, expected_source_name, new_name }) => {
			try {
				if (new_name === expected_source_name) {
					throw new Error(
						"Refusing clone: the new name must differ from the source name.",
					);
				}
				const sourceResponse = await wcFetch(`products/${source_product_id}`);
				const source = await sourceResponse.json<any>();
				if (source.name !== expected_source_name) {
					throw new Error(
						`Refusing clone: product ${source_product_id} is named "${source.name}", not the expected source name.`,
					);
				}
				const existingResponse = await wcFetch("products", {
					search: new_name,
					status: "any",
					per_page: 100,
				});
				const existing = (await existingResponse.json<any[]>()).find(
					(product) =>
						String(product.name).trim().toLowerCase() === new_name.toLowerCase(),
				);
				if (existing) {
					throw new Error(
						`Refusing clone: product ${existing.id} already has the exact target name "${new_name}".`,
					);
				}

				const copyFields = [
					"type",
					"description",
					"short_description",
					"regular_price",
					"sale_price",
					"date_on_sale_from",
					"date_on_sale_to",
					"virtual",
					"downloadable",
					"downloads",
					"download_limit",
					"download_expiry",
					"external_url",
					"button_text",
					"tax_status",
					"tax_class",
					"manage_stock",
					"stock_quantity",
					"backorders",
					"sold_individually",
					"weight",
					"dimensions",
					"shipping_class",
					"reviews_allowed",
					"upsell_ids",
					"cross_sell_ids",
					"categories",
					"tags",
					"images",
					"attributes",
					"default_attributes",
					"grouped_products",
					"menu_order",
				] as const;
				const clonePayload: Record<string, unknown> = {
					name: new_name,
					status: "draft",
					catalog_visibility: "hidden",
					sku: "",
				};
				for (const field of copyFields) {
					if (source[field] !== undefined && source[field] !== null) {
						clonePayload[field] = source[field];
					}
				}
				clonePayload.meta_data = (source.meta_data ?? [])
					.filter((meta: any) => !["_edit_lock", "_edit_last"].includes(String(meta.key)))
					.map((meta: any) => ({ key: meta.key, value: meta.value }));
				const createdResponse = await wcCreate("products", clonePayload);
				const created = await createdResponse.json<any>();
				const verificationResponse = await wcFetch(`products/${created.id}`);
				const verified = await verificationResponse.json<any>();
				if (
					verified.status !== "draft" ||
					verified.catalog_visibility !== "hidden" ||
					verified.name !== new_name
				) {
					throw new Error(
						`Clone ${created.id} failed draft/hidden/name verification. It must be reviewed manually; source product was not modified.`,
					);
				}
				return toolResult({
					created: true,
					source_modified: false,
					source: { id: source.id, name: source.name, status: source.status },
					clone: {
						id: verified.id,
						name: verified.name,
						slug: verified.slug,
						status: verified.status,
						catalog_visibility: verified.catalog_visibility,
						type: verified.type,
						meta_record_count: verified.meta_data?.length ?? 0,
					},
					publication_performed: false,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"install_update_blindmotion_visualizer_plugin_guarded",
		{
			description:
				"Install or update only the isolated blindmotion-visualizer WordPress plugin through the locked Blindmotion WordPress bridge. Validates a ZIP signature, exact SHA-256 digest, semantic version, fixed slug/main file and expected installed version; cannot write another plugin.",
			inputSchema: z.object({
				target_version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
				expected_current_version: z
					.string()
					.regex(/^(?:NONE|\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/),
				archive_sha256: z.string().regex(/^[a-f0-9]{64}$/),
				plugin_zip_base64: z.string().min(100).max(8_000_000),
				confirmation: z.literal(VISUALIZER_PLUGIN_CONFIRMATION),
			}),
		},
		async ({ target_version, expected_current_version, archive_sha256, plugin_zip_base64 }) => {
			try {
				const bytes = decodeBase64(plugin_zip_base64);
				if (bytes.length < 64 || bytes.length > 6_000_000) {
					throw new Error("Visualizer ZIP must decode to between 64 bytes and 6 MB.");
				}
				if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
					throw new Error("Visualizer package is not a ZIP archive.");
				}
				const calculatedSha256 = await sha256Hex(bytes);
				if (calculatedSha256 !== archive_sha256) {
					throw new Error("Visualizer ZIP SHA-256 does not match the confirmed digest.");
				}
				const bridgeResponse = await wpMcpWrite("visualizer-plugin", {
					action: expected_current_version === "NONE" ? "install" : "update",
					plugin_slug: VISUALIZER_PLUGIN_SLUG,
					main_file: VISUALIZER_PLUGIN_MAIN_FILE,
					target_version,
					expected_current_version,
					archive_sha256,
					archive_base64: plugin_zip_base64,
					activate: true,
				});
				const verified = await bridgeResponse.json<any>();
				if (
					verified.plugin_slug !== VISUALIZER_PLUGIN_SLUG ||
					verified.main_file !== VISUALIZER_PLUGIN_MAIN_FILE ||
					verified.version !== target_version ||
					verified.archive_sha256 !== archive_sha256 ||
					verified.active !== true
				) {
					throw new Error(
						"WordPress bridge response failed visualizer identity/version/digest verification.",
					);
				}
				return toolResult({
					completed: true,
					plugin_slug: verified.plugin_slug,
					main_file: verified.main_file,
					previous_version: verified.previous_version ?? null,
					version: verified.version,
					archive_sha256: verified.archive_sha256,
					active: verified.active,
					rollback_available: verified.rollback_available === true,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_product_images",
		{
			description:
				"Audit Blindmotion WooCommerce featured, gallery and custom-field/product-option images with read-only WordPress attachment metadata, including original dimensions and aspect ratio.",
			inputSchema: z.object({
				product_id: z.number().int().positive().optional(),
				search: z.string().optional(),
				status: z.string().optional(),
				category_id: z.number().int().optional(),
				limit: z.number().int().min(1).max(100).default(100),
			}),
		},
		async ({ product_id, search, status, category_id, limit }) => {
			try {
				const mediaById = new Map<number, Promise<any>>();
				const mediaByUrl = new Map<string, Promise<any | null>>();
				let mediaCatalogPromise: Promise<Map<string, any>> | undefined;

				const preloadMediaByIds = async (attachmentIds: number[]) => {
					const missingIds = [...new Set(attachmentIds)].filter(
						(attachmentId) => !mediaById.has(attachmentId),
					);
					for (let index = 0; index < missingIds.length; index += 100) {
						const batch = missingIds.slice(index, index + 100);
						const response = await wpFetch(
							`media?include=${batch.join(",")}&per_page=100`,
						);
						const mediaItems = await response.json<any[]>();
						for (const media of mediaItems) {
							mediaById.set(media.id, Promise.resolve(media));
						}
					}
				};

				const getMediaCatalog = () => {
					if (!mediaCatalogPromise) {
						mediaCatalogPromise = (async () => {
							const firstResponse = await wpFetch("media?per_page=100&page=1");
							const firstPage = await firstResponse.json<any[]>();
							const reportedPages = Number(
								firstResponse.headers.get("X-WP-TotalPages") ?? 1,
							);
							// Keep the catalogue scan safely below Cloudflare's subrequest ceiling.
							const totalPages = Math.min(Math.max(reportedPages, 1), 40);
							const mediaItems = [...firstPage];
							for (let page = 2; page <= totalPages; page += 5) {
								const pageNumbers = Array.from(
									{ length: Math.min(5, totalPages - page + 1) },
									(_, offset) => page + offset,
								);
								const responses = await Promise.all(
									pageNumbers.map((pageNumber) =>
										wpFetch(`media?per_page=100&page=${pageNumber}`),
									),
								);
								for (const response of responses) {
									mediaItems.push(...(await response.json<any[]>()));
								}
							}
							return new Map(
								mediaItems.map((media) => [
									mediaFilenameKey(media.source_url ?? ""),
									media,
								]),
							);
						})();
					}
					return mediaCatalogPromise;
				};

				const getMediaById = (attachmentId: number) => {
					if (!mediaById.has(attachmentId)) {
						mediaById.set(
							attachmentId,
							wpFetch(`media/${attachmentId}`).then((response) =>
								response.json<any>(),
							),
						);
					}
					return mediaById.get(attachmentId)!;
				};

				const getMediaByUrl = (sourceUrl: string) => {
					if (!mediaByUrl.has(sourceUrl)) {
						mediaByUrl.set(
							sourceUrl,
							(async () => {
								const filename = mediaFilenameKey(sourceUrl);
								if (!filename) return null;
								return (await getMediaCatalog()).get(filename) ?? null;
							})(),
						);
					}
					return mediaByUrl.get(sourceUrl)!;
				};

				const response = product_id
					? await wcFetch(`products/${product_id}`)
					: await wcFetch("products", {
							search,
							status,
							category: category_id,
							per_page: limit,
							orderby: "title",
							order: "asc",
						});
				const payload = await response.json<any>();
				const products = Array.isArray(payload) ? payload : [payload];
				const customReferencesByProduct = new Map<number, ProductImageReference[]>();
				const attachmentIds: number[] = [];
				for (const product of products) {
					for (const image of product.images ?? []) attachmentIds.push(image.id);
					const references = collectProductImageReferences(product.meta_data);
					customReferencesByProduct.set(product.id, references);
					for (const reference of references) {
						if (reference.attachment_id) attachmentIds.push(reference.attachment_id);
					}
				}
				await preloadMediaByIds(attachmentIds);

				const results = await Promise.all(
					products.map(async (product: any) => {
						const standardImages = await Promise.all(
							(product.images ?? []).map(async (image: any, index: number) => {
								try {
									const media = await getMediaById(image.id);
									return mediaMetadata(media, {
										role: index === 0 ? "featured" : "gallery",
										position: index,
										attachment_id: image.id,
										source_url: image.src,
									});
								} catch (error) {
									return {
										role: index === 0 ? "featured" : "gallery",
										position: index,
										attachment_id: image.id,
										name: image.name,
										alt: image.alt,
										source_url: image.src,
										metadata_error:
											error instanceof Error ? error.message : String(error),
									};
								}
							}),
						);

						const customFieldReferences =
							customReferencesByProduct.get(product.id) ?? [];
						const customFieldImages = await Promise.all(
							customFieldReferences.map(async (reference) => {
								try {
									const media = reference.attachment_id
										? await getMediaById(reference.attachment_id)
										: reference.source_url
											? await getMediaByUrl(reference.source_url)
											: null;
									if (!media) {
										return {
											...reference,
											metadata_error:
												"WordPress Media Library attachment could not be resolved",
										};
									}
									return mediaMetadata(media, reference);
								} catch (error) {
									return {
										...reference,
										metadata_error:
											error instanceof Error ? error.message : String(error),
									};
								}
							}),
						);
						const images = [...standardImages, ...customFieldImages];

						return {
							product_id: product.id,
							name: product.name,
							slug: product.slug,
							status: product.status,
							image_count: images.length,
							standard_image_count: standardImages.length,
							custom_field_image_count: customFieldImages.length,
							images,
						};
					}),
				);

				return toolResult(results);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_product_image_reference_report",
		{
			description:
				"Read-only report of reused product-image attachments and unresolved custom-field image references.",
			inputSchema: z.object({
				status: z.string().default("publish"),
				limit: z.number().int().min(1).max(100).default(100),
			}),
		},
		async ({ status, limit }) => {
			try {
				const response = await wcFetch("products", {
					status,
					per_page: limit,
					orderby: "title",
					order: "asc",
				});
				const products = await response.json<any[]>();
				const assignments: Array<Record<string, any>> = [];
				for (const product of products) {
					for (const [position, image] of (product.images ?? []).entries()) {
						assignments.push({
							product_id: product.id,
							product_name: product.name,
							role: position === 0 ? "featured" : "gallery",
							attachment_id: image.id,
							source_url: image.src,
						});
					}
					for (const reference of collectProductImageReferences(product.meta_data)) {
						assignments.push({
							product_id: product.id,
							product_name: product.name,
							...reference,
						});
					}
				}

				const ids = [
					...new Set(
						assignments
							.map((assignment) => assignment.attachment_id)
							.filter((id): id is number => Number.isInteger(id) && id > 0),
					),
				];
				const validIds = new Set<number>();
				for (let index = 0; index < ids.length; index += 100) {
					const batch = ids.slice(index, index + 100);
					const mediaResponse = await wpFetch(
						`media?include=${batch.join(",")}&per_page=100`,
					);
					for (const media of await mediaResponse.json<any[]>()) validIds.add(media.id);
				}
				const firstMediaResponse = await wpFetch("media?per_page=100&page=1");
				const mediaItems = await firstMediaResponse.json<any[]>();
				const reportedPages = Number(
					firstMediaResponse.headers.get("X-WP-TotalPages") ?? 1,
				);
				const totalPages = Math.min(Math.max(reportedPages, 1), 40);
				for (let page = 2; page <= totalPages; page += 5) {
					const pageNumbers = Array.from(
						{ length: Math.min(5, totalPages - page + 1) },
						(_, offset) => page + offset,
					);
					const pageResponses = await Promise.all(
						pageNumbers.map((pageNumber) =>
							wpFetch(`media?per_page=100&page=${pageNumber}`),
						),
					);
					for (const pageResponse of pageResponses) {
						mediaItems.push(...(await pageResponse.json<any[]>()));
					}
				}
				const mediaByFilename = new Map(
					mediaItems.map((media) => [mediaFilenameKey(media.source_url ?? ""), media]),
				);
				for (const assignment of assignments) {
					if (!assignment.attachment_id && assignment.source_url) {
						const media = mediaByFilename.get(mediaFilenameKey(assignment.source_url));
						if (media) assignment.resolved_attachment_id = media.id;
					}
				}

				const workerEnv = env as unknown as Record<string, string | undefined>;
				const siteHost = new URL(workerEnv.WC_SITE ?? "https://invalid.local").host;
				const unresolved = assignments.filter((assignment) => {
					if (assignment.attachment_id) return !validIds.has(assignment.attachment_id);
					if (!assignment.source_url) return true;
					try {
						return (
							new URL(assignment.source_url).host !== siteHost ||
							!assignment.resolved_attachment_id
						);
					} catch {
						return true;
					}
				});

				const grouped = new Map<string, any[]>();
				for (const assignment of assignments) {
					const resolvedId =
						assignment.attachment_id ?? assignment.resolved_attachment_id;
					const identity = resolvedId
						? `id:${resolvedId}`
						: `url:${normaliseImageUrl(assignment.source_url ?? "")}`;
					const group = grouped.get(identity) ?? [];
					group.push(assignment);
					grouped.set(identity, group);
				}
				const reused = [...grouped.entries()]
					.map(([identity, uses]) => ({
						identity,
						assignment_count: uses.length,
						product_count: new Set(uses.map((use) => use.product_id)).size,
						uses,
					}))
					.filter((group) => group.assignment_count > 1)
					.sort((a, b) => b.assignment_count - a.assignment_count);

				return toolResult({
					product_count: products.length,
					assignment_count: assignments.length,
					unique_reference_count: grouped.size,
					reused_reference_count: reused.length,
					unresolved_reference_count: unresolved.length,
					reused_references: reused,
					unresolved_references: unresolved,
					media_replacement_configured: Boolean(
						workerEnv.WP_USERNAME && workerEnv.WP_APPLICATION_PASSWORD,
					),
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"replace_product_option_image_guarded",
		{
			description:
				"Upload a new WordPress attachment and replace exactly one product-option image reference, preserving the original attachment and a durable rollback record. Cannot delete media.",
			inputSchema: z
				.object({
					product_id: z.number().int().positive(),
					meta_data_id: z.number().int().positive(),
					custom_field_key: z.string().min(1),
					custom_field_path: z.string().min(1),
					expected_attachment_id: z.number().int().positive().optional(),
					expected_source_url: z.string().url().optional(),
					replacement_attachment_id: z.number().int().positive().optional(),
					replacement_filename: z
						.string()
						.regex(/^[A-Za-z0-9._-]+$/)
						.optional(),
					replacement_mime_type: z
						.enum(["image/jpeg", "image/png", "image/webp"])
						.optional(),
					replacement_base64: z.string().min(4).max(8_000_000).optional(),
					confirmation: z.literal("CONFIRM REPLACE PRODUCT OPTION IMAGE"),
				})
				.refine(
					(value) =>
						value.expected_attachment_id !== undefined ||
						value.expected_source_url !== undefined,
					{ message: "An expected current attachment ID or URL is required." },
				)
				.refine(
					(value) => {
						const reusingAttachment = value.replacement_attachment_id !== undefined;
						const uploadSupplied =
							value.replacement_filename !== undefined &&
							value.replacement_mime_type !== undefined &&
							value.replacement_base64 !== undefined;
						return reusingAttachment !== uploadSupplied;
					},
					{
						message:
							"Provide either replacement_attachment_id or a complete filename/MIME/base64 upload payload.",
					},
				),
		},
		async ({
			product_id,
			meta_data_id,
			custom_field_key,
			custom_field_path,
			expected_attachment_id,
			expected_source_url,
			replacement_attachment_id,
			replacement_filename,
			replacement_mime_type,
			replacement_base64,
		}) => {
			try {
				const productResponse = await wcFetch(`products/${product_id}`);
				const product = await productResponse.json<any>();
				const meta = (product.meta_data ?? []).find(
					(item: any) => item.id === meta_data_id && item.key === custom_field_key,
				);
				if (!meta) throw new Error("The exact product meta record was not found.");

				const storedAsJson =
					typeof meta.value === "string" && /^[{[]/.test(meta.value.trim());
				const parsedValue = storedAsJson
					? JSON.parse(meta.value)
					: structuredClone(meta.value);
				const tokens = productMetaPathTokens(custom_field_key, custom_field_path);
				const oldValue = getNestedValue(parsedValue, tokens);
				const pairedAttachmentTokens =
					tokens[tokens.length - 1] === "image"
						? [...tokens.slice(0, -1), "attachment"]
						: undefined;
				const oldPairedAttachment = pairedAttachmentTokens
					? getNestedValue(parsedValue, pairedAttachmentTokens)
					: undefined;
				const hasPairedAttachment =
					pairedAttachmentTokens !== undefined &&
					Number.isInteger(Number(oldPairedAttachment)) &&
					Number(oldPairedAttachment) > 0;
				const attachmentMatches =
					expected_attachment_id === undefined ||
					Number(hasPairedAttachment ? oldPairedAttachment : oldValue) ===
						expected_attachment_id;
				const urlMatches =
					expected_source_url === undefined ||
					(typeof oldValue === "string" &&
						normaliseImageUrl(oldValue) === normaliseImageUrl(expected_source_url));
				if (!attachmentMatches || !urlMatches) {
					const currentReference =
						typeof oldValue === "string" || typeof oldValue === "number"
							? String(oldValue)
							: `[${Array.isArray(oldValue) ? "array" : typeof oldValue}]`;
					throw new Error(
						`Current image reference does not match the expected value; no write performed. Current stored reference: ${currentReference}`,
					);
				}
				if (
					typeof oldValue !== "number" &&
					!(
						typeof oldValue === "string" &&
						(/^\d+$/.test(oldValue) || /^https?:/i.test(oldValue))
					)
				) {
					throw new Error("The selected path is not a supported scalar image reference.");
				}

				let uploaded: any;
				if (replacement_attachment_id !== undefined) {
					const mediaResponse = await wpFetch(`media/${replacement_attachment_id}`);
					uploaded = await mediaResponse.json<any>();
					if (
						!uploaded?.id ||
						typeof uploaded.source_url !== "string" ||
						!/^image\/(jpeg|png|webp)$/i.test(uploaded.mime_type ?? "")
					) {
						throw new Error(
							"The replacement attachment is not a supported WordPress image.",
						);
					}
				} else {
					const bytes = decodeBase64(replacement_base64!);
					if (!bytes.length || bytes.length > 6_000_000) {
						throw new Error(
							"Replacement image must decode to between 1 byte and 6 MB.",
						);
					}
					if (!hasExpectedImageSignature(bytes, replacement_mime_type!)) {
						throw new Error(
							"Replacement bytes do not match the declared image MIME type.",
						);
					}
					uploaded = await wpUploadMedia(
						replacement_filename!,
						replacement_mime_type!,
						bytes,
					);
				}
				const newValue =
					typeof oldValue === "number"
						? uploaded.id
						: /^\d+$/.test(oldValue)
							? String(uploaded.id)
							: uploaded.source_url;
				setNestedValue(parsedValue, tokens, newValue);
				if (hasPairedAttachment && pairedAttachmentTokens) {
					setNestedValue(parsedValue, pairedAttachmentTokens, uploaded.id);
				}

				const backupKey = "_blindmotion_mcp_image_replacement_backups";
				const backupMeta = (product.meta_data ?? []).find(
					(item: any) => item.key === backupKey,
				);
				const backups = Array.isArray(backupMeta?.value) ? [...backupMeta.value] : [];
				const backup = {
					backup_id: crypto.randomUUID(),
					created_at: new Date().toISOString(),
					product_id,
					meta_data_id,
					custom_field_key,
					custom_field_path,
					old_value: oldValue,
					old_attachment_id: hasPairedAttachment
						? Number(oldPairedAttachment)
						: undefined,
					new_attachment_id: uploaded.id,
					new_source_url: uploaded.source_url,
				};
				backups.push(backup);
				const updateResponse = await wcWrite(`products/${product_id}`, {
					meta_data: [
						{
							id: meta_data_id,
							key: custom_field_key,
							value: storedAsJson ? JSON.stringify(parsedValue) : parsedValue,
						},
						{
							...(backupMeta?.id ? { id: backupMeta.id } : {}),
							key: backupKey,
							value: backups,
						},
					],
				});
				const updatedProduct = await updateResponse.json<any>();
				const updatedMeta = (updatedProduct.meta_data ?? []).find(
					(item: any) => item.id === meta_data_id,
				);
				const updatedParsed = storedAsJson
					? JSON.parse(updatedMeta.value)
					: updatedMeta.value;
				if (getNestedValue(updatedParsed, tokens) !== newValue) {
					throw new Error(
						"WooCommerce returned without verifying the new image reference.",
					);
				}
				if (
					hasPairedAttachment &&
					pairedAttachmentTokens &&
					Number(getNestedValue(updatedParsed, pairedAttachmentTokens)) !== uploaded.id
				) {
					throw new Error(
						"WooCommerce returned without verifying the paired WAPF attachment ID.",
					);
				}

				return toolResult({
					replaced: true,
					product_id,
					product_name: product.name,
					meta_data_id,
					custom_field_path,
					old_value: oldValue,
					new_value: newValue,
					new_attachment: mediaMetadata(uploaded),
					paired_attachment_updated: hasPairedAttachment,
					backup,
					original_attachment_deleted: false,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/*
	 * 4. Single Order
	 */

	server.registerTool(
		"get_order",
		{
			description:
				"Investigate one Blindmotion WooCommerce order by order ID without exposing billing or shipping PII.",
			inputSchema: z.object({
				order_id: z.number().int().positive(),
			}),
		},
		async ({ order_id }) => {
			try {
				const response = await wcFetch(`orders/${order_id}`);

				const order = await response.json<any>();

				return toolResult({
					...safeOrder(order),
					date_paid: order.date_paid,
					date_completed: order.date_completed,
					transaction_id: order.transaction_id,
					fee_lines: order.fee_lines?.map((fee: any) => ({
						name: fee.name,
						total: fee.total,
						tax: fee.total_tax,
					})),
					shipping_lines: order.shipping_lines?.map((shipping: any) => ({
						method_title: shipping.method_title,
						total: shipping.total,
					})),
					refunds: order.refunds?.map((refund: any) => ({
						id: refund.id,
						reason: refund.reason,
						total: refund.total,
					})),
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/*
	 * 5. Coupons
	 */

	server.registerTool(
		"get_coupons",
		{
			description:
				"Return Blindmotion WooCommerce coupon configuration and usage information.",
			inputSchema: z.object({
				search: z.string().optional(),
				limit: z.number().int().min(1).max(100),
			}),
		},
		async ({ search, limit }) => {
			try {
				const response = await wcFetch("coupons", {
					search,
					per_page: limit,
					orderby: "date",
					order: "desc",
				});

				const coupons = await response.json<any[]>();

				const safeCoupons = coupons.map((coupon) => ({
					id: coupon.id,
					code: coupon.code,
					discount_type: coupon.discount_type,
					amount: coupon.amount,
					usage_count: coupon.usage_count,
					usage_limit: coupon.usage_limit,
					usage_limit_per_user: coupon.usage_limit_per_user,
					individual_use: coupon.individual_use,
					minimum_amount: coupon.minimum_amount,
					maximum_amount: coupon.maximum_amount,
					date_created: coupon.date_created,
					date_expires: coupon.date_expires,
					free_shipping: coupon.free_shipping,
				}));

				return toolResult(safeCoupons);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/*
	 * 6. Customer Order History
	 */

	server.registerTool(
		"get_customer_order_history",
		{
			description:
				"Return commercial order history for a WooCommerce customer ID, excluding customer PII.",
			inputSchema: z.object({
				customer_id: z.number().int().positive(),
			}),
		},
		async ({ customer_id }) => {
			try {
				const allOrders: any[] = [];
				const perPage = 100;

				for (let page = 1; page <= 20; page++) {
					const response = await wcFetch("orders", {
						customer: customer_id,
						after: `${COMMERCIAL_START_DATE}T00:00:00`,
						per_page: perPage,
						page,
						orderby: "date",
						order: "asc",
					});

					const orders = await response.json<any[]>();

					allOrders.push(...orders);

					if (orders.length < perPage) {
						break;
					}
				}

				const genuineOrders = allOrders.filter(isGenuineCommercialOrder);

				const totalRevenue = genuineOrders.reduce(
					(sum, order) => sum + Number(order.total ?? 0),
					0,
				);

				return toolResult({
					customer_id,
					genuine_order_count: genuineOrders.length,
					total_revenue: Number(totalRevenue.toFixed(2)),
					average_order_value:
						genuineOrders.length > 0
							? Number((totalRevenue / genuineOrders.length).toFixed(2))
							: 0,
					first_genuine_order: genuineOrders[0] ? safeOrder(genuineOrders[0]) : null,
					most_recent_genuine_order:
						genuineOrders.length > 0
							? safeOrder(genuineOrders[genuineOrders.length - 1])
							: null,
					orders: genuineOrders.map(safeOrder),
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/*
	 * 7. Product Sales
	 */

	server.registerTool(
		"get_product_sales",
		{
			description:
				"Aggregate product quantities and line-item revenue from genuine Blindmotion commercial orders for a date range.",
			inputSchema: z.object({
				start_date: z.string(),
				end_date: z.string(),
				limit: z.number().int().min(1).max(100),
			}),
		},
		async ({ start_date, end_date, limit }) => {
			try {
				const orders = await getAllOrders(start_date, end_date);

				const genuineOrders = orders.filter(isGenuineCommercialOrder);

				const productMap = new Map<
					string,
					{
						product_id: number;
						variation_id: number;
						name: string;
						sku: string;
						quantity: number;
						revenue: number;
						order_ids: Set<number>;
					}
				>();

				for (const order of genuineOrders) {
					for (const item of order.line_items ?? []) {
						const key = `${item.product_id}:${item.variation_id ?? 0}`;

						if (!productMap.has(key)) {
							productMap.set(key, {
								product_id: item.product_id,
								variation_id: item.variation_id ?? 0,
								name: item.name,
								sku: item.sku ?? "",
								quantity: 0,
								revenue: 0,
								order_ids: new Set<number>(),
							});
						}

						const product = productMap.get(key)!;

						product.quantity += Number(item.quantity ?? 0);

						product.revenue += Number(item.total ?? 0);

						product.order_ids.add(order.id);
					}
				}

				const products = Array.from(productMap.values())
					.map((product) => ({
						product_id: product.product_id,
						variation_id: product.variation_id,
						name: product.name,
						sku: product.sku,
						quantity: product.quantity,
						revenue: Number(product.revenue.toFixed(2)),
						order_count: product.order_ids.size,
					}))
					.sort((a, b) => b.revenue - a.revenue)
					.slice(0, limit);

				return toolResult({
					start_date,
					end_date,
					genuine_order_count: genuineOrders.length,
					products,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/* Read-only Meta Ads reporting tools */

	server.registerTool(
		"get_meta_ad_account",
		{
			description:
				"Confirm the configured Blindmotion Meta ad account and return non-sensitive account metadata.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				const { adAccountId } = getMetaConfig();
				const account = await metaFetch(adAccountId, {
					fields: "id,account_id,name,account_status,currency,timezone_name,business_name,amount_spent,balance",
				});
				return toolResult(account);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_meta_ads_summary",
		{
			description:
				"Summarise Blindmotion Meta Ads spend, reach, clicks, purchases, purchase conversion value and purchase ROAS for a date range.",
			inputSchema: z.object({
				start_date: z.string(),
				end_date: z.string(),
			}),
		},
		async ({ start_date, end_date }) => {
			try {
				const { adAccountId } = getMetaConfig();
				const result = await metaFetch(`${adAccountId}/insights`, {
					fields: META_INSIGHT_FIELDS,
					level: "account",
					time_range: metaDateRange(start_date, end_date),
				});
				return toolResult({
					start_date,
					end_date,
					data: enrichMetaInsights(result.data ?? []),
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	const registerMetaPerformanceTool = (
		name: string,
		level: "campaign" | "adset" | "ad",
		identityFields: string,
		description: string,
	) => {
		server.registerTool(
			name,
			{
				description,
				inputSchema: z.object({
					start_date: z.string(),
					end_date: z.string(),
					limit: z.number().int().min(1).max(100).default(50),
				}),
			},
			async ({ start_date, end_date, limit }) => {
				try {
					const { adAccountId } = getMetaConfig();
					const result = await metaFetch(`${adAccountId}/insights`, {
						fields: `${identityFields},${META_INSIGHT_FIELDS}`,
						level,
						time_range: metaDateRange(start_date, end_date),
						limit,
					});
					return toolResult({
						start_date,
						end_date,
						level,
						data: enrichMetaInsights(result.data ?? []),
					});
				} catch (error) {
					return toolError(error);
				}
			},
		);
	};

	registerMetaPerformanceTool(
		"get_meta_campaign_performance",
		"campaign",
		"campaign_id,campaign_name,objective",
		"Return read-only Meta Ads campaign performance, including purchase value and ROAS, for a date range.",
	);
	registerMetaPerformanceTool(
		"get_meta_adset_performance",
		"adset",
		"campaign_id,campaign_name,adset_id,adset_name,objective",
		"Return read-only Meta Ads ad-set performance, including purchase value and ROAS, for a date range.",
	);
	registerMetaPerformanceTool(
		"get_meta_ad_performance",
		"ad",
		"campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,objective",
		"Return read-only Meta Ads ad performance, including purchase value and ROAS, for a date range.",
	);

	server.registerTool(
		"get_meta_daily_performance",
		{
			description:
				"Return daily Blindmotion Meta Ads account performance, including purchase value and ROAS, for a date range.",
			inputSchema: z.object({
				start_date: z.string(),
				end_date: z.string(),
			}),
		},
		async ({ start_date, end_date }) => {
			try {
				const { adAccountId } = getMetaConfig();
				const result = await metaFetch(`${adAccountId}/insights`, {
					fields: META_INSIGHT_FIELDS,
					level: "account",
					time_increment: 1,
					time_range: metaDateRange(start_date, end_date),
					limit: 100,
				});
				return toolResult({
					start_date,
					end_date,
					data: enrichMetaInsights(result.data ?? []),
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_meta_budget_settings",
		{
			description:
				"Inspect current Meta campaign and ad-set budgets. Read-only; use this before any budget update.",
			inputSchema: z.object({
				status: z.enum(["ACTIVE", "PAUSED", "ALL"]).default("ACTIVE"),
				limit: z.number().int().min(1).max(100).default(50),
			}),
		},
		async ({ status, limit }) => {
			try {
				const { adAccountId } = getMetaConfig();
				const params: Record<string, string | number | undefined> = {
					fields: "id,name,status,effective_status,daily_budget,lifetime_budget,budget_remaining",
					limit,
				};
				if (status !== "ALL") params.effective_status = JSON.stringify([status]);

				const [campaignResult, adsetResult] = await Promise.all([
					metaFetch(`${adAccountId}/campaigns`, params),
					metaFetch(`${adAccountId}/adsets`, {
						...params,
						fields: "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,budget_remaining",
					}),
				]);

				return toolResult({
					currency: "AUD",
					campaigns: (campaignResult.data ?? []).map((item: any) =>
						safeMetaBudgetObject(item, "campaign"),
					),
					adsets: (adsetResult.data ?? []).map((item: any) =>
						safeMetaBudgetObject(item, "adset"),
					),
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"update_meta_daily_budget",
		{
			description:
				"Update only the daily budget of one Meta campaign or ad set after explicit confirmation. Increases are limited to 25% and A$500/day.",
			inputSchema: z.object({
				object_type: z.enum(["campaign", "adset"]),
				object_id: z.string().regex(/^\d+$/),
				new_daily_budget_aud: z.number().positive().max(500),
				confirmation: z.literal("CONFIRM META BUDGET UPDATE"),
			}),
		},
		async ({ object_type, object_id, new_daily_budget_aud }) => {
			try {
				const { adAccountId } = getMetaConfig();
				const configuredAccountId = adAccountId.replace(/^act_/, "");
				const current = await metaFetch(object_id, {
					fields:
						object_type === "adset"
							? "id,name,account_id,campaign_id,status,effective_status,daily_budget,lifetime_budget"
							: "id,name,account_id,status,effective_status,daily_budget,lifetime_budget",
				});

				if (String(current.account_id) !== configuredAccountId) {
					throw new Error(
						"Refusing update: object does not belong to the configured Meta ad account.",
					);
				}

				const currentBudget = metaBudgetAmount(current.daily_budget);
				if (currentBudget === null || currentBudget <= 0) {
					throw new Error(
						`Refusing update: ${object_type} does not have a daily budget at this level. Inspect its parent campaign or ad sets.`,
					);
				}

				const roundedBudget = Number(new_daily_budget_aud.toFixed(2));
				if (roundedBudget > currentBudget * 1.25) {
					throw new Error(
						`Refusing update: increases are capped at 25% per change. Current budget is A$${currentBudget.toFixed(2)}.`,
					);
				}

				await metaPost(object_id, { daily_budget: Math.round(roundedBudget * 100) });
				const verified = await metaFetch(object_id, {
					fields: "id,name,account_id,status,effective_status,daily_budget,lifetime_budget",
				});

				return toolResult({
					updated: true,
					object_type,
					object_id,
					name: verified.name,
					currency: "AUD",
					previous_daily_budget: currentBudget,
					requested_daily_budget: roundedBudget,
					verified_daily_budget: metaBudgetAmount(verified.daily_budget),
					unchanged_fields: [
						"targeting",
						"creative",
						"status",
						"optimisation",
						"bid_strategy",
					],
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/* Guarded Meta campaign creation tools. Every created delivery object is PAUSED. */

	server.registerTool(
		"get_meta_campaign_creation_assets",
		{
			description:
				"Inspect reusable Meta pixels and ad creatives for building a new campaign. Read-only.",
			inputSchema: z.object({
				creative_limit: z.number().int().min(1).max(100).default(50),
			}),
		},
		async ({ creative_limit }) => {
			try {
				const { adAccountId } = getMetaConfig();
				const [pixelResult, creativeResult] = await Promise.all([
					metaFetch(adAccountId + "/adspixels", {
						fields: "id,name,last_fired_time,is_unavailable",
						limit: 100,
					}),
					metaFetch(adAccountId + "/adcreatives", {
						fields: "id,name,status,object_story_id,thumbnail_url,image_hash,video_id,call_to_action_type",
						limit: creative_limit,
					}),
				]);
				return toolResult({
					account_id: adAccountId,
					pixels: pixelResult.data ?? [],
					creatives: creativeResult.data ?? [],
					note: "Only existing creatives are exposed; this tool cannot upload or modify media.",
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_meta_lead_campaign_assets",
		{
			description:
				"List owned Facebook Pages, active Instant Forms, account videos and existing creatives for a paused Meta lead campaign. Read-only; optional search filters video and creative names.",
			inputSchema: z.object({
				page_id: z.string().regex(/^\d+$/).optional(),
				search: z.string().trim().max(100).optional(),
				form_limit: z.number().int().min(1).max(100).default(100),
				media_limit: z.number().int().min(1).max(100).default(100),
			}),
		},
		async ({ page_id, search, form_limit, media_limit }) => {
			try {
				const { adAccountId } = getMetaConfig();
				const pages = await getOwnedMetaPages();
				if (page_id && !pages.some((item: any) => String(item.id) === page_id)) {
					throw new Error("Selected Facebook Page is not assigned to this ad account.");
				}
				const [forms, videos, creativeResult] = await Promise.all([
					page_id ? getOwnedMetaLeadForms(page_id, form_limit) : Promise.resolve([]),
					getOwnedMetaVideos(media_limit, page_id),
					metaFetch(adAccountId + "/adcreatives", {
						fields: "id,name,status,object_story_id,thumbnail_url,image_hash,video_id,call_to_action_type,object_story_spec",
						limit: media_limit,
					}),
				]);
				const query = search?.toLowerCase();
				const matches = (item: any) =>
					!query ||
					[
						String(item.title ?? ""),
						String(item.name ?? ""),
						String(item.description ?? ""),
					]
						.join(" ")
						.toLowerCase()
						.includes(query);
				return toolResult({
					account_id: adAccountId,
					pages,
					selected_page_id: page_id ?? null,
					instant_forms: forms.filter((item: any) => item.status === "ACTIVE"),
					videos: videos.filter(matches),
					creatives: (creativeResult.data ?? []).filter(matches),
					search: search ?? null,
					note: "Meta's Marketing API does not reliably expose Media Library folder membership. Search matches asset titles, descriptions and creative names; existing creatives can be reused directly.",
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_meta_owned_ad_videos",
		{
			description:
				"List videos owned by the configured Meta ad account with exact titles, IDs, upload times, durations, processing status and derived dimensions. Read-only; does not depend on Business Media Library folder access.",
			inputSchema: z.object({
				search: z.string().trim().max(200).optional(),
				created_on_or_after: z.string().date().optional(),
				limit: z.number().int().min(1).max(500).default(100),
			}),
		},
		async ({ search, created_on_or_after, limit }) => {
			try {
				const { adAccountId } = getMetaConfig();
				const videos = await getOwnedMetaVideos(limit);
				const query = search?.toLowerCase();
				const filteredVideos = videos.filter(
					(item: any) =>
						(!query ||
							[String(item.title ?? ""), String(item.description ?? "")]
								.join(" ")
								.toLowerCase()
								.includes(query)) &&
						(!created_on_or_after ||
							String(item.created_time ?? "").slice(0, 10) >= created_on_or_after),
				);
				return toolResult({
					account_id: adAccountId,
					videos: filteredVideos,
					search: search ?? null,
					created_on_or_after: created_on_or_after ?? null,
					ownership_verified_by: "configured_ad_account_advideos",
					read_only: true,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_meta_leads_for_owned_forms",
		{
			description:
				"Retrieve leads from explicitly identified active Instant Forms owned by an assigned Blindmotion Page. Read-only; returns lead contact fields so the business can recover and follow up enquiries after a form-routing error.",
			inputSchema: z.object({
				page_id: z.string().regex(/^\d+$/),
				forms: z
					.array(
						z.object({
							form_id: z.string().regex(/^\d+$/),
							expected_name: z.string().trim().min(3).max(200),
						}),
					)
					.min(1)
					.max(10),
				created_on_or_after: z.string().datetime(),
				limit_per_form: z.number().int().min(1).max(100).default(100),
			}),
		},
		async ({ page_id, forms, created_on_or_after, limit_per_form }) => {
			try {
				await assertOwnedMetaPage(page_id);
				const pageAccessToken = await getOwnedMetaPageAccessToken(page_id);
				const ownedForms = await getOwnedMetaLeadForms(page_id, 100);
				const validatedForms = forms.map(({ form_id, expected_name }) => {
					const form = ownedForms.find((item: any) => String(item.id) === form_id);
					if (!form || form.status !== "ACTIVE") {
						throw new Error(
							`Form ${form_id} is not an active form owned by the selected Page.`,
						);
					}
					if (String(form.name) !== expected_name) {
						throw new Error(`Form ${form_id} name does not exactly match expectation.`);
					}
					return form;
				});
				const rows: any[] = [];
				for (const form of validatedForms) {
					const leads = await getAllMetaEdgeRows(
						String(form.id) + "/leads",
						{
							fields: "id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,field_data,platform,is_organic",
						},
						limit_per_form,
						pageAccessToken,
					);
					rows.push(
						...leads
							.filter(
								(item: any) =>
									String(item.created_time ?? "") >= created_on_or_after,
							)
							.map((item: any) => ({ ...item, source_form_name: form.name })),
					);
				}
				rows.sort((a, b) => String(a.created_time).localeCompare(String(b.created_time)));
				return toolResult({
					page_id,
					forms: validatedForms.map((form: any) => ({ id: form.id, name: form.name })),
					created_on_or_after,
					lead_count: rows.length,
					leads: rows,
					read_only: true,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"create_meta_spring_instant_form_for_paused_ads",
		{
			description:
				"Create one owned Spring Instant Form for use only in a separately reviewed PAUSED campaign. Meta forms are ACTIVE form definitions and do not deliver by themselves; this tool cannot create or activate an ad.",
			inputSchema: z.object({
				campaign_id: z.string().regex(/^\d+$/),
				page_id: z.string().regex(/^\d+$/),
				name: z.string().trim().min(3).max(200),
				locale: z
					.string()
					.regex(/^[a-z]{2}_[A-Z]{2}$/)
					.default("en_AU"),
				privacy_policy_url: z.string().url(),
				follow_up_action_url: z.string().url(),
				question_page_custom_headline: z.string().trim().min(3).max(200),
				custom_questions: z
					.array(
						z.object({
							key: z.string().regex(/^[a-z0-9_]{1,64}$/),
							label: z.string().trim().min(1).max(200),
							options: z
								.array(
									z.object({
										key: z.string().regex(/^[a-z0-9_]{1,64}$/),
										value: z.string().trim().min(1).max(100),
									}),
								)
								.min(2)
								.max(20)
								.optional(),
						}),
					)
					.max(10)
					.default([]),
				confirmation: z.literal(META_CREATE_SPRING_FORM_CONFIRMATION),
			}),
		},
		async ({
			campaign_id,
			page_id,
			name,
			locale,
			privacy_policy_url,
			follow_up_action_url,
			question_page_custom_headline,
			custom_questions,
		}) => {
			try {
				const formText = [name, question_page_custom_headline].join(" ");
				if (!/spring/i.test(formText) || /winter/i.test(formText)) {
					throw new Error(
						"Refusing creation: Spring form name/headline must reference spring and must not reference winter.",
					);
				}
				const campaign = await assertMetaObjectOwnership(campaign_id, "campaign");
				if (campaign.status !== "PAUSED" || campaign.objective !== "OUTCOME_LEADS") {
					throw new Error(
						"Refusing creation: intended campaign must be a PAUSED OUTCOME_LEADS campaign.",
					);
				}
				const page = await assertOwnedMetaPage(page_id);
				const existingForms = await getOwnedMetaLeadForms(page_id, 100);
				if (
					existingForms.some(
						(item: any) =>
							String(item.name).trim().toLowerCase() === name.trim().toLowerCase(),
					)
				) {
					throw new Error(
						"Refusing creation: an Instant Form already uses this exact name.",
					);
				}
				const duplicateQuestionKeys = custom_questions.filter(
					(item, index) =>
						custom_questions.findIndex((candidate) => candidate.key === item.key) !==
						index,
				);
				if (duplicateQuestionKeys.length) {
					throw new Error("Refusing creation: custom question keys must be unique.");
				}
				const reservedQuestionKeys = new Set(["full_name", "phone_number", "email"]);
				if (custom_questions.some((item) => reservedQuestionKeys.has(item.key))) {
					throw new Error(
						"Refusing creation: custom question keys cannot replace required contact fields.",
					);
				}
				for (const question of custom_questions) {
					if (
						question.options &&
						new Set(question.options.map((option) => option.key)).size !==
							question.options.length
					) {
						throw new Error(
							`Refusing creation: option keys for ${question.key} must be unique.`,
						);
					}
				}

				const questions = [
					{ type: "FULL_NAME", key: "full_name" },
					{ type: "PHONE", key: "phone_number" },
					{ type: "EMAIL", key: "email" },
					...custom_questions.map((question) => ({ type: "CUSTOM", ...question })),
				];
				const pageAccessToken = await getOwnedMetaPageAccessToken(page_id);
				const created = await metaPost(
					page_id + "/leadgen_forms",
					{
						name,
						locale,
						questions: JSON.stringify(questions),
						question_page_custom_headline,
						privacy_policy: JSON.stringify({
							url: privacy_policy_url,
							link_text: "View Privacy Policy",
						}),
						follow_up_action_url,
					},
					pageAccessToken,
				);
				const verified = await metaFetch(
					String(created.id),
					{
						fields: "id,name,status,locale,created_time,questions,privacy_policy_url,follow_up_action_url,question_page_custom_headline",
					},
					pageAccessToken,
				);
				if (verified.status !== "ACTIVE") {
					throw new Error("Created Instant Form failed ACTIVE definition verification.");
				}
				return toolResult({
					created: true,
					activation_performed: false,
					delivery_possible_without_a_separate_ad: false,
					object_type: "instant_form",
					intended_paused_campaign: campaign,
					page,
					form: verified,
					note: "Meta Instant Forms do not have a PAUSED state. This ACTIVE form definition cannot deliver on its own and must be attached only to separately reviewed PAUSED ads.",
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"create_meta_leads_campaign_paused",
		{
			description:
				"Create one new Meta OUTCOME_LEADS campaign in PAUSED state. Cannot activate delivery.",
			inputSchema: z.object({
				name: z.string().trim().min(3).max(200),
				budget_level: z.enum(["campaign", "adset"]),
				daily_budget_aud: z.number().positive().max(500).optional(),
				confirmation: z.literal(META_CREATE_CONFIRMATION),
			}),
		},
		async ({ name, budget_level, daily_budget_aud }) => {
			try {
				if (budget_level === "campaign" && daily_budget_aud === undefined) {
					throw new Error("A campaign-level daily budget is required.");
				}
				if (budget_level === "adset" && daily_budget_aud !== undefined) {
					throw new Error("Do not provide a campaign budget when budget_level is adset.");
				}
				await refuseDuplicateMetaName("campaigns", name);
				const { adAccountId } = getMetaConfig();
				const params: Record<string, string | number> = {
					name,
					objective: "OUTCOME_LEADS",
					buying_type: "AUCTION",
					special_ad_categories: JSON.stringify([]),
					status: "PAUSED",
				};
				if (daily_budget_aud !== undefined) {
					params.daily_budget = metaDailyBudgetMinorUnits(daily_budget_aud);
					params.bid_strategy = "LOWEST_COST_WITHOUT_CAP";
				}
				const created = await metaPost(adAccountId + "/campaigns", params);
				const verified = await metaFetch(created.id, {
					fields: "id,name,account_id,status,effective_status,objective,daily_budget,lifetime_budget,bid_strategy,special_ad_categories",
				});
				if (verified.status !== "PAUSED" || verified.objective !== "OUTCOME_LEADS") {
					throw new Error(
						"Created campaign failed the PAUSED OUTCOME_LEADS verification.",
					);
				}
				return toolResult({
					created: true,
					activation_performed: false,
					object_type: "campaign",
					budget_level,
					...verified,
					daily_budget_aud: metaBudgetAmount(verified.daily_budget),
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"create_meta_sales_campaign_paused",
		{
			description:
				"Create one new Meta OUTCOME_SALES campaign in PAUSED state. Cannot activate delivery.",
			inputSchema: z.object({
				name: z.string().trim().min(3).max(200),
				budget_level: z.enum(["campaign", "adset"]),
				daily_budget_aud: z.number().positive().max(500).optional(),
				confirmation: z.literal(META_CREATE_CONFIRMATION),
			}),
		},
		async ({ name, budget_level, daily_budget_aud }) => {
			try {
				if (budget_level === "campaign" && daily_budget_aud === undefined) {
					throw new Error("A campaign-level daily budget is required.");
				}
				if (budget_level === "adset" && daily_budget_aud !== undefined) {
					throw new Error("Do not provide a campaign budget when budget_level is adset.");
				}
				await refuseDuplicateMetaName("campaigns", name);
				const { adAccountId } = getMetaConfig();
				const params: Record<string, string | number> = {
					name,
					objective: "OUTCOME_SALES",
					buying_type: "AUCTION",
					special_ad_categories: JSON.stringify([]),
					status: "PAUSED",
				};
				if (daily_budget_aud !== undefined) {
					params.daily_budget = metaDailyBudgetMinorUnits(daily_budget_aud);
					params.bid_strategy = "LOWEST_COST_WITHOUT_CAP";
				}
				const created = await metaPost(adAccountId + "/campaigns", params);
				const verified = await metaFetch(created.id, {
					fields: "id,name,account_id,status,effective_status,objective,daily_budget,lifetime_budget,bid_strategy,special_ad_categories",
				});
				return toolResult({
					created: true,
					activation_performed: false,
					object_type: "campaign",
					budget_level,
					...verified,
					daily_budget_aud: metaBudgetAmount(verified.daily_budget),
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"create_meta_instant_form_adset_paused",
		{
			description:
				"Create one PAUSED ON_AD Instant-Form lead ad set under an owned PAUSED OUTCOME_LEADS campaign. Targeting is hard-limited to a Sydney radius of no more than 50 km; the selected active form is ownership-checked for subsequent creative creation.",
			inputSchema: z.object({
				campaign_id: z.string().regex(/^\d+$/),
				name: z.string().trim().min(3).max(200),
				page_id: z.string().regex(/^\d+$/),
				lead_form_id: z.string().regex(/^\d+$/),
				daily_budget_aud: z.number().positive().max(500).optional(),
				sydney_radius_km: z.number().int().min(1).max(50).default(50),
				age_min: z.number().int().min(18).max(65).default(35),
				age_max: z.number().int().min(18).max(65).default(65),
				genders: z
					.array(z.union([z.literal(1), z.literal(2)]))
					.max(2)
					.optional(),
				confirmation: z.literal(META_CREATE_CONFIRMATION),
			}),
		},
		async ({
			campaign_id,
			name,
			page_id,
			lead_form_id,
			daily_budget_aud,
			sydney_radius_km,
			age_min,
			age_max,
			genders,
		}) => {
			try {
				if (age_max < age_min) throw new Error("age_max must be at least age_min.");
				const campaign = await assertMetaObjectOwnership(campaign_id, "campaign");
				if (campaign.objective !== "OUTCOME_LEADS") {
					throw new Error("Refusing creation: parent campaign is not OUTCOME_LEADS.");
				}
				if (campaign.status !== "PAUSED") {
					throw new Error("Refusing creation: parent campaign must be PAUSED.");
				}

				const page = await assertOwnedMetaPage(page_id);
				const form = await assertOwnedActiveMetaLeadForm(page_id, lead_form_id);
				await refuseDuplicateMetaName("adsets", name);
				const targeting: Record<string, unknown> = {
					geo_locations: {
						cities: [
							{
								key: "114925",
								radius: sydney_radius_km,
								distance_unit: "kilometer",
							},
						],
						location_types: ["home", "recent"],
					},
					age_min,
					age_max,
					targeting_automation: {
						advantage_audience: 1,
						individual_setting: { age: 1, gender: 1, geo: 0 },
					},
				};
				if (genders?.length) targeting.genders = genders;

				const params: Record<string, string | number> = {
					campaign_id,
					name,
					status: "PAUSED",
					billing_event: "IMPRESSIONS",
					optimization_goal: "QUALITY_LEAD",
					destination_type: "ON_AD",
					promoted_object: JSON.stringify({ page_id }),
					targeting: JSON.stringify(targeting),
					bid_strategy: "LOWEST_COST_WITHOUT_CAP",
				};

				const campaignBudget = metaBudgetAmount(campaign.daily_budget);
				if (campaignBudget === null) {
					if (daily_budget_aud === undefined) {
						throw new Error(
							"An ad-set daily budget is required because the parent has no campaign budget.",
						);
					}
					params.daily_budget = metaDailyBudgetMinorUnits(daily_budget_aud);
				} else if (daily_budget_aud !== undefined) {
					throw new Error(
						"Do not provide an ad-set budget when the parent uses campaign-level budgeting.",
					);
				}

				const { adAccountId } = getMetaConfig();
				const created = await metaPost(adAccountId + "/adsets", params);
				const verified = await metaFetch(created.id, {
					fields: "id,name,account_id,campaign_id,status,effective_status,daily_budget,lifetime_budget,billing_event,optimization_goal,destination_type,promoted_object,targeting",
				});
				if (
					verified.status !== "PAUSED" ||
					verified.destination_type !== "ON_AD" ||
					verified.optimization_goal !== "QUALITY_LEAD"
				) {
					throw new Error(
						"Created ad set failed PAUSED ON_AD QUALITY_LEAD verification.",
					);
				}
				return toolResult({
					created: true,
					activation_performed: false,
					object_type: "adset",
					...verified,
					daily_budget_aud: metaBudgetAmount(verified.daily_budget),
					validated_page: page,
					validated_instant_form: form,
					note: "Meta associates the Instant Form with each ad creative, not the ad set. The form was ownership/status checked here and must be supplied again when creating the ad.",
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"create_meta_website_sales_adset_paused",
		{
			description:
				"Create one PAUSED website-sales ad set under an owned PAUSED campaign, restricted to Australian targeting and an assigned Meta pixel.",
			inputSchema: z.object({
				campaign_id: z.string().regex(/^\d+$/),
				name: z.string().trim().min(3).max(200),
				pixel_id: z.string().regex(/^\d+$/),
				conversion_event: z.enum(["PURCHASE", "LEAD"]).default("PURCHASE"),
				daily_budget_aud: z.number().positive().max(500).optional(),
				age_min: z.number().int().min(18).max(65).default(18),
				age_max: z.number().int().min(18).max(65).default(65),
				genders: z
					.array(z.union([z.literal(1), z.literal(2)]))
					.max(2)
					.optional(),
				confirmation: z.literal(META_CREATE_CONFIRMATION),
			}),
		},
		async ({
			campaign_id,
			name,
			pixel_id,
			conversion_event,
			daily_budget_aud,
			age_min,
			age_max,
			genders,
		}) => {
			try {
				if (age_max < age_min) throw new Error("age_max must be at least age_min.");
				const campaign = await assertMetaObjectOwnership(campaign_id, "campaign");
				if (campaign.objective !== "OUTCOME_SALES") {
					throw new Error("Refusing creation: parent campaign is not OUTCOME_SALES.");
				}
				if (campaign.status !== "PAUSED") {
					throw new Error("Refusing creation: parent campaign must be PAUSED.");
				}

				const { adAccountId } = getMetaConfig();
				const pixels = await metaFetch(adAccountId + "/adspixels", {
					fields: "id,name,is_unavailable",
					limit: 100,
				});
				const pixel = (pixels.data ?? []).find((item: any) => String(item.id) === pixel_id);
				if (!pixel || pixel.is_unavailable) {
					throw new Error(
						"Refusing creation: pixel is unavailable or not assigned to this ad account.",
					);
				}
				await refuseDuplicateMetaName("adsets", name);

				const targeting: Record<string, unknown> = {
					geo_locations: { countries: ["AU"] },
					age_min,
					age_max,
				};
				if (genders?.length) targeting.genders = genders;

				const params: Record<string, string | number> = {
					campaign_id,
					name,
					status: "PAUSED",
					billing_event: "IMPRESSIONS",
					optimization_goal: "OFFSITE_CONVERSIONS",
					destination_type: "WEBSITE",
					promoted_object: JSON.stringify({
						pixel_id,
						custom_event_type: conversion_event,
					}),
					targeting: JSON.stringify(targeting),
					bid_strategy: "LOWEST_COST_WITHOUT_CAP",
				};

				const campaignBudget = metaBudgetAmount(campaign.daily_budget);
				if (campaignBudget === null) {
					if (daily_budget_aud === undefined) {
						throw new Error(
							"An ad-set daily budget is required because the parent has no campaign budget.",
						);
					}
					params.daily_budget = metaDailyBudgetMinorUnits(daily_budget_aud);
				} else if (daily_budget_aud !== undefined) {
					throw new Error(
						"Do not provide an ad-set budget when the parent uses campaign-level budgeting.",
					);
				}

				const created = await metaPost(adAccountId + "/adsets", params);
				const verified = await metaFetch(created.id, {
					fields: "id,name,account_id,campaign_id,status,effective_status,daily_budget,lifetime_budget,billing_event,optimization_goal,destination_type,promoted_object,targeting",
				});
				return toolResult({
					created: true,
					activation_performed: false,
					object_type: "adset",
					...verified,
					daily_budget_aud: metaBudgetAmount(verified.daily_budget),
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"create_meta_instant_form_video_ad_paused",
		{
			description:
				"Create a new owned video creative linked to an active Instant Form, then create one PAUSED ad under an owned PAUSED ON_AD lead ad set. Cannot activate delivery.",
			inputSchema: z.object({
				adset_id: z.string().regex(/^\d+$/),
				page_id: z.string().regex(/^\d+$/),
				lead_form_id: z.string().regex(/^\d+$/),
				video_id: z.string().regex(/^\d+$/),
				name: z.string().trim().min(3).max(200),
				primary_text: z.string().trim().min(1).max(5000),
				headline: z.string().trim().min(1).max(255),
				description: z.string().trim().max(255).optional(),
				cta_type: z
					.enum(["GET_QUOTE", "LEARN_MORE", "SIGN_UP", "APPLY_NOW"])
					.default("GET_QUOTE"),
				confirmation: z.literal(META_CREATE_CONFIRMATION),
			}),
		},
		async ({
			adset_id,
			page_id,
			lead_form_id,
			video_id,
			name,
			primary_text,
			headline,
			description,
			cta_type,
		}) => {
			try {
				await assertMetaObjectOwnership(adset_id, "adset");
				const adset = await metaFetch(adset_id, {
					fields: "id,name,account_id,campaign_id,status,effective_status,optimization_goal,destination_type,promoted_object",
				});
				if (adset.status !== "PAUSED") {
					throw new Error("Refusing creation: parent ad set must be PAUSED.");
				}
				if (
					adset.destination_type !== "ON_AD" ||
					adset.optimization_goal !== "QUALITY_LEAD"
				) {
					throw new Error(
						"Refusing creation: parent ad set must be ON_AD and optimized for QUALITY_LEAD.",
					);
				}
				if (String(adset.promoted_object?.page_id) !== page_id) {
					throw new Error("Refusing creation: selected Page does not match the ad set.");
				}
				const campaign = await assertMetaObjectOwnership(
					String(adset.campaign_id),
					"campaign",
				);
				if (campaign.status !== "PAUSED" || campaign.objective !== "OUTCOME_LEADS") {
					throw new Error(
						"Refusing creation: parent campaign must be a PAUSED OUTCOME_LEADS campaign.",
					);
				}

				const [page, form, video] = await Promise.all([
					assertOwnedMetaPage(page_id),
					assertOwnedActiveMetaLeadForm(page_id, lead_form_id),
					assertOwnedMetaVideo(video_id, page_id),
				]);
				await Promise.all([
					refuseDuplicateMetaName("ads", name),
					refuseDuplicateMetaName("adcreatives", name + " | Creative"),
				]);

				const videoData: Record<string, unknown> = {
					video_id,
					message: primary_text,
					title: headline,
					call_to_action: {
						type: cta_type,
						value: { lead_gen_form_id: lead_form_id },
					},
				};
				if (description) videoData.link_description = description;

				const { adAccountId } = getMetaConfig();
				const createdCreative = await metaPost(adAccountId + "/adcreatives", {
					name: name + " | Creative",
					object_story_spec: JSON.stringify({
						page_id,
						video_data: videoData,
					}),
				});
				let createdAd: any;
				try {
					createdAd = await metaPost(adAccountId + "/ads", {
						name,
						adset_id,
						creative: JSON.stringify({ creative_id: createdCreative.id }),
						status: "PAUSED",
					});
				} catch (error) {
					if (error instanceof Error) {
						error.message =
							"Creative " +
							createdCreative.id +
							" was created, but PAUSED ad creation failed: " +
							error.message;
						throw error;
					}
					throw error;
				}

				const verified = await metaFetch(createdAd.id, {
					fields: "id,name,account_id,campaign_id,adset_id,status,effective_status,creative{id,name,status,object_story_id,thumbnail_url,object_story_spec}",
				});
				if (verified.status !== "PAUSED") {
					throw new Error("Created ad failed PAUSED verification.");
				}
				return toolResult({
					created: true,
					activation_performed: false,
					object_type: "ad",
					...verified,
					validated_page: page,
					validated_instant_form: form,
					validated_video: video,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"create_meta_instant_form_placement_video_ad_paused",
		{
			description:
				"Create one new placement-customized creative from explicitly validated 4:5 and 9:16 videos owned by the configured ad account, then create one PAUSED Instant-Form ad. Exact titles, upload times, durations and dimensions are required. Feed placements use 4:5; Stories and Reels use 9:16. The owned parent may be ACTIVE only for a Spring repair; the new ad always remains PAUSED and cannot deliver until separately switched.",
			inputSchema: z.object({
				adset_id: z.string().regex(/^\d+$/),
				page_id: z.string().regex(/^\d+$/),
				lead_form_id: z.string().regex(/^\d+$/),
				asset_pair_label: z.string().trim().min(3).max(100),
				video_4x5_id: z.string().regex(/^\d+$/),
				video_4x5_expected_name: z.string().trim().min(1).max(300),
				video_4x5_expected_created_time: z.string().trim().min(20).max(40),
				video_4x5_expected_length_seconds: z.number().positive().max(600),
				video_4x5_expected_width: z.number().int().positive().max(10000),
				video_4x5_expected_height: z.number().int().positive().max(10000),
				video_9x16_id: z.string().regex(/^\d+$/),
				video_9x16_expected_name: z.string().trim().min(1).max(300),
				video_9x16_expected_created_time: z.string().trim().min(20).max(40),
				video_9x16_expected_length_seconds: z.number().positive().max(600),
				video_9x16_expected_width: z.number().int().positive().max(10000),
				video_9x16_expected_height: z.number().int().positive().max(10000),
				name: z.string().trim().min(3).max(200),
				primary_text: z.string().trim().min(1).max(5000),
				headline: z.string().trim().min(1).max(255),
				description: z.string().trim().max(255).optional(),
				cta_type: z
					.enum(["GET_QUOTE", "LEARN_MORE", "SIGN_UP", "APPLY_NOW"])
					.default("GET_QUOTE"),
				confirmation: z.literal(META_CREATE_CONFIRMATION),
			}),
		},
		async ({
			adset_id,
			page_id,
			lead_form_id,
			asset_pair_label,
			video_4x5_id,
			video_4x5_expected_name,
			video_4x5_expected_created_time,
			video_4x5_expected_length_seconds,
			video_4x5_expected_width,
			video_4x5_expected_height,
			video_9x16_id,
			video_9x16_expected_name,
			video_9x16_expected_created_time,
			video_9x16_expected_length_seconds,
			video_9x16_expected_width,
			video_9x16_expected_height,
			name,
			primary_text,
			headline,
			description,
			cta_type,
		}) => {
			try {
				const adCopy = [name, primary_text, headline, description ?? ""].join(" ");
				if (!/spring/i.test(adCopy) || /winter/i.test(adCopy)) {
					throw new Error(
						"Refusing creation: Spring ad name/copy must reference spring and must not reference winter.",
					);
				}
				const expectedAssetNames = [video_4x5_expected_name, video_9x16_expected_name].join(
					" ",
				);
				if (!/spring/i.test(expectedAssetNames) || /winter/i.test(expectedAssetNames)) {
					throw new Error(
						"Refusing creation: both expected video names must be Spring-specific.",
					);
				}
				const adset = await assertMetaObjectOwnership(adset_id, "adset");
				if (!["PAUSED", "ACTIVE"].includes(adset.status)) {
					throw new Error("Refusing creation: parent ad set must be PAUSED or ACTIVE.");
				}
				const adsetDetails = await metaFetch(adset_id, {
					fields: "id,name,account_id,campaign_id,status,effective_status,optimization_goal,destination_type,promoted_object",
				});
				if (
					adsetDetails.destination_type !== "ON_AD" ||
					adsetDetails.optimization_goal !== "QUALITY_LEAD"
				) {
					throw new Error(
						"Refusing creation: parent ad set must be ON_AD and optimized for QUALITY_LEAD.",
					);
				}
				if (String(adsetDetails.promoted_object?.page_id) !== page_id) {
					throw new Error("Refusing creation: selected Page does not match the ad set.");
				}
				const campaign = await assertMetaObjectOwnership(
					String(adsetDetails.campaign_id),
					"campaign",
				);
				if (
					!["PAUSED", "ACTIVE"].includes(campaign.status) ||
					campaign.objective !== "OUTCOME_LEADS" ||
					(campaign.status === "ACTIVE" && !/spring/i.test(campaign.name))
				) {
					throw new Error(
						"Refusing creation: parent campaign must be an OUTCOME_LEADS campaign; ACTIVE parents are allowed only for an explicitly Spring-named repair.",
					);
				}

				const [page, form, video4x5, video9x16, instagramUserId] = await Promise.all([
					assertOwnedMetaPage(page_id),
					assertOwnedActiveMetaLeadForm(page_id, lead_form_id),
					assertOwnedMetaAdAccountVideo(video_4x5_id),
					assertOwnedMetaAdAccountVideo(video_9x16_id),
					getMetaInstagramIdentityForPage(page_id, adset_id),
				]);
				const videoName = (video: any) => String(video.name ?? video.title ?? "").trim();
				if (videoName(video4x5) !== video_4x5_expected_name) {
					throw new Error(
						"Refusing creation: 4:5 video name does not exactly match expectation.",
					);
				}
				if (videoName(video9x16) !== video_9x16_expected_name) {
					throw new Error(
						"Refusing creation: 9:16 video name does not exactly match expectation.",
					);
				}
				if (video_4x5_id === video_9x16_id) {
					throw new Error("Refusing creation: placement videos must use different IDs.");
				}
				if (
					!videoName(video4x5).includes(asset_pair_label) ||
					!videoName(video9x16).includes(asset_pair_label)
				) {
					throw new Error(
						"Refusing creation: both placement videos must contain the same expected asset pair label.",
					);
				}
				const assertVideoMetadata = (
					video: any,
					expected: {
						createdTime: string;
						length: number;
						width: number;
						height: number;
						ratio: number;
					},
					label: string,
				) => {
					const width = Number(video.width);
					const height = Number(video.height);
					const length = Number(video.length);
					if (video.status?.video_status !== "ready") {
						throw new Error(
							`Refusing creation: ${label} video processing is not ready.`,
						);
					}
					if (String(video.created_time ?? "") !== expected.createdTime) {
						throw new Error(
							`Refusing creation: ${label} video upload time does not exactly match expectation.`,
						);
					}
					if (!Number.isFinite(length) || Math.abs(length - expected.length) > 0.001) {
						throw new Error(
							`Refusing creation: ${label} video duration does not exactly match expectation.`,
						);
					}
					if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) {
						throw new Error(
							`Refusing creation: Meta did not provide dimensions for the ${label} video.`,
						);
					}
					if (width !== expected.width || height !== expected.height) {
						throw new Error(
							`Refusing creation: ${label} video dimensions ${width}x${height} do not exactly match expected ${expected.width}x${expected.height}.`,
						);
					}
					if (Math.abs(width / height - expected.ratio) > 0.02) {
						throw new Error(
							`Refusing creation: ${label} asset dimensions are ${width}x${height}, not ${label}.`,
						);
					}
				};
				assertVideoMetadata(
					video4x5,
					{
						createdTime: video_4x5_expected_created_time,
						length: video_4x5_expected_length_seconds,
						width: video_4x5_expected_width,
						height: video_4x5_expected_height,
						ratio: 4 / 5,
					},
					"4:5",
				);
				assertVideoMetadata(
					video9x16,
					{
						createdTime: video_9x16_expected_created_time,
						length: video_9x16_expected_length_seconds,
						width: video_9x16_expected_width,
						height: video_9x16_expected_height,
						ratio: 9 / 16,
					},
					"9:16",
				);
				if (
					Math.abs(Number(video4x5.length) - Number(video9x16.length)) > 0.05 ||
					String(video4x5.created_time).slice(0, 10) !==
						String(video9x16.created_time).slice(0, 10)
				) {
					throw new Error(
						"Refusing creation: placement videos do not form a same-duration, same-upload-date pair.",
					);
				}
				await Promise.all([
					refuseDuplicateMetaName("ads", name),
					refuseDuplicateMetaName("adcreatives", name + " | Placement Creative"),
				]);

				const assetFeedSpec: Record<string, unknown> = {
					ad_formats: ["SINGLE_VIDEO"],
					optimization_type: "REGULAR",
					bodies: [{ text: primary_text }],
					titles: [{ text: headline }],
					descriptions: description ? [{ text: description }] : [],
					videos: [
						{ video_id: video_4x5_id, adlabels: [{ name: "video_feed_4x5" }] },
						{ video_id: video_9x16_id, adlabels: [{ name: "video_vertical_9x16" }] },
					],
					call_to_action_types: [cta_type],
					call_to_actions: [
						{ type: cta_type, value: { lead_gen_form_id: lead_form_id } },
					],
					asset_customization_rules: [
						{
							customization_spec: {
								publisher_platforms: ["facebook", "instagram"],
								facebook_positions: [
									"feed",
									"marketplace",
									"video_feeds",
									"search",
								],
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
				const { adAccountId } = getMetaConfig();
				const createdCreative = await metaPost(adAccountId + "/adcreatives", {
					name: name + " | Placement Creative",
					object_story_spec: JSON.stringify({
						page_id,
						instagram_user_id: instagramUserId,
					}),
					asset_feed_spec: JSON.stringify(assetFeedSpec),
				});
				let createdAd: any;
				try {
					createdAd = await metaPost(adAccountId + "/ads", {
						name,
						adset_id,
						creative: JSON.stringify({ creative_id: createdCreative.id }),
						status: "PAUSED",
					});
				} catch (error) {
					if (error instanceof Error) {
						error.message =
							"Placement creative " +
							createdCreative.id +
							" was created, but PAUSED ad creation failed: " +
							error.message;
					}
					throw error;
				}
				const verified = await metaFetch(createdAd.id, {
					fields: "id,name,account_id,campaign_id,adset_id,status,effective_status,creative{id,name,status,object_story_id,thumbnail_url,object_story_spec,asset_feed_spec}",
				});
				const verifiedCreative = verified.creative ?? {};
				const verifiedVideoIds = new Set(
					(verifiedCreative.asset_feed_spec?.videos ?? []).map((item: any) =>
						String(item.video_id),
					),
				);
				if (
					verified.status !== "PAUSED" ||
					!verifiedVideoIds.has(video_4x5_id) ||
					!verifiedVideoIds.has(video_9x16_id) ||
					!collectMetaLeadFormIds(verifiedCreative).has(lead_form_id)
				) {
					throw new Error(
						"Created ad failed PAUSED, placement-video, or Instant-Form verification.",
					);
				}
				return toolResult({
					created: true,
					activation_performed: false,
					object_type: "ad",
					...verified,
					validated_page: page,
					validated_instagram_user_id: instagramUserId,
					validated_instant_form: form,
					validated_4x5_video: video4x5,
					validated_9x16_video: video9x16,
					ownership_verified_by: "configured_ad_account_advideos",
					placement_mapping: {
						feeds: video_4x5_id,
						stories_and_reels: video_9x16_id,
					},
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"create_meta_ad_from_existing_creative_paused",
		{
			description:
				"Create one PAUSED Meta ad using an existing owned creative under an owned PAUSED ad set. For Instant-Form ads, expected_lead_form_id verifies the creative is linked to the intended owned active form.",
			inputSchema: z.object({
				adset_id: z.string().regex(/^\d+$/),
				creative_id: z.string().regex(/^\d+$/),
				expected_lead_form_id: z.string().regex(/^\d+$/).optional(),
				name: z.string().trim().min(3).max(200),
				confirmation: z.literal(META_CREATE_CONFIRMATION),
			}),
		},
		async ({ adset_id, creative_id, expected_lead_form_id, name }) => {
			try {
				const adset = await assertMetaObjectOwnership(adset_id, "adset");
				if (adset.status !== "PAUSED") {
					throw new Error("Refusing creation: parent ad set must be PAUSED.");
				}
				await assertMetaObjectOwnership(creative_id, "creative");
				if (expected_lead_form_id) {
					const adsetDetails = await metaFetch(adset_id, {
						fields: "id,campaign_id,destination_type,promoted_object",
					});
					if (adsetDetails.destination_type !== "ON_AD") {
						throw new Error(
							"Refusing creation: expected_lead_form_id can only be used with an ON_AD ad set.",
						);
					}
					const pageId = String(adsetDetails.promoted_object?.page_id ?? "");
					await assertOwnedActiveMetaLeadForm(pageId, expected_lead_form_id);
					const creative = await metaFetch(creative_id, {
						fields: "id,name,account_id,status,object_story_spec,asset_feed_spec",
					});
					if (!collectMetaLeadFormIds(creative).has(expected_lead_form_id)) {
						throw new Error(
							"Refusing creation: existing creative is not linked to the expected Instant Form.",
						);
					}
				}
				await refuseDuplicateMetaName("ads", name);
				const { adAccountId } = getMetaConfig();
				const created = await metaPost(adAccountId + "/ads", {
					name,
					adset_id,
					creative: JSON.stringify({ creative_id }),
					status: "PAUSED",
				});
				const verified = await metaFetch(created.id, {
					fields: "id,name,account_id,campaign_id,adset_id,status,effective_status,creative{id,name,status,object_story_id}",
				});
				return toolResult({
					created: true,
					activation_performed: false,
					object_type: "ad",
					...verified,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"repair_active_spring_meta_ads_guarded",
		{
			description:
				"Atomically switch a reviewed Spring lead campaign from delivered ads using incorrect forms to PAUSED replacement ads using one exact intended form. Validates ownership, campaign/ad-set identity, form linkage, placement customisation and status; activates replacements, pauses old ads, verifies the final state, and never deletes history.",
			inputSchema: z.object({
				campaign_id: z.string().regex(/^\d+$/),
				expected_campaign_name: z.string().trim().min(3).max(200),
				adset_id: z.string().regex(/^\d+$/),
				expected_adset_name: z.string().trim().min(3).max(200),
				page_id: z.string().regex(/^\d+$/),
				intended_form_id: z.string().regex(/^\d+$/),
				intended_form_expected_name: z.string().trim().min(3).max(200),
				replacement_ads: z
					.array(
						z.object({
							ad_id: z.string().regex(/^\d+$/),
							expected_name: z.string().trim().min(3).max(200),
						}),
					)
					.min(1)
					.max(10),
				incorrect_ads: z
					.array(
						z.object({
							ad_id: z.string().regex(/^\d+$/),
							expected_name: z.string().trim().min(3).max(200),
						}),
					)
					.min(1)
					.max(10),
				confirmation: z.literal(META_REPAIR_SPRING_ADS_CONFIRMATION),
			}),
		},
		async ({
			campaign_id,
			expected_campaign_name,
			adset_id,
			expected_adset_name,
			page_id,
			intended_form_id,
			intended_form_expected_name,
			replacement_ads,
			incorrect_ads,
		}) => {
			try {
				const campaign = await assertMetaObjectOwnership(campaign_id, "campaign");
				if (
					campaign.name !== expected_campaign_name ||
					campaign.status !== "ACTIVE" ||
					campaign.objective !== "OUTCOME_LEADS" ||
					!/spring/i.test(campaign.name)
				) {
					throw new Error(
						"Refusing repair: campaign identity, status, objective or Spring name did not match.",
					);
				}
				const adset = await assertMetaObjectOwnership(adset_id, "adset");
				if (
					String(adset.campaign_id) !== campaign_id ||
					adset.name !== expected_adset_name ||
					adset.status !== "ACTIVE"
				) {
					throw new Error(
						"Refusing repair: active parent ad set did not exactly match expectation.",
					);
				}
				const form = await assertOwnedActiveMetaLeadForm(page_id, intended_form_id);
				if (
					String(form.name) !== intended_form_expected_name ||
					!/spring/i.test(form.name)
				) {
					throw new Error(
						"Refusing repair: intended Spring form name did not exactly match expectation.",
					);
				}
				const allIds = [...replacement_ads, ...incorrect_ads].map((item) => item.ad_id);
				if (new Set(allIds).size !== allIds.length) {
					throw new Error(
						"Refusing repair: replacement and incorrect ad IDs must be unique.",
					);
				}
				const loadAd = async (item: { ad_id: string; expected_name: string }) => {
					const ad = await metaFetch(item.ad_id, {
						fields: "id,name,account_id,campaign_id,adset_id,status,effective_status,creative{id,name,status,object_story_spec,asset_feed_spec}",
					});
					await assertMetaObjectOwnership(item.ad_id, "ad");
					if (
						ad.name !== item.expected_name ||
						String(ad.campaign_id) !== campaign_id ||
						String(ad.adset_id) !== adset_id
					) {
						throw new Error(
							`Refusing repair: ad ${item.ad_id} identity or parent did not match.`,
						);
					}
					return ad;
				};
				const replacements = await Promise.all(replacement_ads.map(loadAd));
				const incorrect = await Promise.all(incorrect_ads.map(loadAd));
				for (const ad of replacements) {
					if (ad.status !== "PAUSED")
						throw new Error(`Replacement ad ${ad.id} is not PAUSED.`);
					const formIds = collectMetaLeadFormIds(ad.creative);
					if (formIds.size !== 1 || !formIds.has(intended_form_id)) {
						throw new Error(
							`Replacement ad ${ad.id} is not linked exclusively to the intended form.`,
						);
					}
					const rules = ad.creative?.asset_feed_spec?.asset_customization_rules ?? [];
					if (!Array.isArray(rules) || rules.length < 2) {
						throw new Error(
							`Replacement ad ${ad.id} lacks verified feed versus Stories/Reels placement rules.`,
						);
					}
				}
				for (const ad of incorrect) {
					if (ad.status !== "ACTIVE")
						throw new Error(`Incorrect ad ${ad.id} is not ACTIVE.`);
					if (collectMetaLeadFormIds(ad.creative).has(intended_form_id)) {
						throw new Error(
							`Incorrect ad ${ad.id} already uses the intended form; refusing to pause it.`,
						);
					}
				}

				const changed: Array<{ id: string; previous: "ACTIVE" | "PAUSED" }> = [];
				try {
					for (const ad of replacements) {
						await metaPost(ad.id, { status: "ACTIVE" });
						changed.push({ id: ad.id, previous: "PAUSED" });
					}
					for (const ad of incorrect) {
						await metaPost(ad.id, { status: "PAUSED" });
						changed.push({ id: ad.id, previous: "ACTIVE" });
					}
				} catch (switchError) {
					for (const item of changed.reverse()) {
						try {
							await metaPost(item.id, { status: item.previous });
						} catch {
							/* best-effort rollback */
						}
					}
					throw switchError;
				}
				const verifiedReplacements = await Promise.all(
					replacements.map((ad) =>
						metaFetch(ad.id, {
							fields: "id,name,status,effective_status,creative{id,object_story_spec,asset_feed_spec}",
						}),
					),
				);
				const verifiedIncorrect = await Promise.all(
					incorrect.map((ad) =>
						metaFetch(ad.id, { fields: "id,name,status,effective_status" }),
					),
				);
				if (
					verifiedReplacements.some((ad) => ad.status !== "ACTIVE") ||
					verifiedIncorrect.some((ad) => ad.status !== "PAUSED")
				) {
					throw new Error(
						"Repair switch completed but final status verification failed; inspect campaign immediately.",
					);
				}
				return toolResult({
					repaired: true,
					campaign: { id: campaign.id, name: campaign.name, status: campaign.status },
					adset: { id: adset.id, name: adset.name, status: adset.status },
					intended_form: { id: form.id, name: form.name },
					active_replacement_ads: verifiedReplacements,
					paused_historical_ads: verifiedIncorrect,
					deleted_ads: [],
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"archive_meta_paused_draft_ads_guarded",
		{
			description:
				"Archive explicitly identified incorrect Meta draft ads only after verifying exact names, ownership, PAUSED status, PAUSED parent campaign, and zero lifetime spend and impressions. Cannot archive active or previously delivered ads.",
			inputSchema: z.object({
				campaign_id: z.string().regex(/^\d+$/),
				expected_campaign_name: z.string().trim().min(3).max(200),
				ads: z
					.array(
						z.object({
							ad_id: z.string().regex(/^\d+$/),
							expected_name: z.string().trim().min(3).max(200),
						}),
					)
					.min(1)
					.max(10),
				retirement_reason: z.literal("INCORRECT SPRING DRAFT"),
				confirmation: z.literal(META_ARCHIVE_DRAFT_ADS_CONFIRMATION),
			}),
		},
		async ({ campaign_id, expected_campaign_name, ads }) => {
			try {
				const campaign = await assertMetaObjectOwnership(campaign_id, "campaign");
				if (campaign.name !== expected_campaign_name || !/spring/i.test(campaign.name)) {
					throw new Error(
						"Refusing retirement: campaign name does not exactly match the expected Spring campaign.",
					);
				}
				if (campaign.status !== "PAUSED") {
					throw new Error("Refusing retirement: parent campaign must be PAUSED.");
				}
				if (new Set(ads.map((item) => item.ad_id)).size !== ads.length) {
					throw new Error("Refusing retirement: each ad ID may appear only once.");
				}

				const validated = await Promise.all(
					ads.map(async ({ ad_id, expected_name }) => {
						const ad = await assertMetaObjectOwnership(ad_id, "ad");
						if (String(ad.campaign_id) !== campaign_id) {
							throw new Error(
								`Refusing retirement: ad ${ad_id} is not in campaign ${campaign_id}.`,
							);
						}
						if (ad.name !== expected_name) {
							throw new Error(
								`Refusing retirement: ad ${ad_id} name does not exactly match expectation.`,
							);
						}
						if (ad.status !== "PAUSED") {
							throw new Error(`Refusing retirement: ad ${ad_id} is not PAUSED.`);
						}
						const insights = await metaFetch(ad_id + "/insights", {
							fields: "spend,impressions",
							date_preset: "maximum",
							limit: 100,
						});
						const totals = (insights.data ?? []).reduce(
							(accumulator: { spend: number; impressions: number }, row: any) => ({
								spend: accumulator.spend + Number(row.spend ?? 0),
								impressions: accumulator.impressions + Number(row.impressions ?? 0),
							}),
							{ spend: 0, impressions: 0 },
						);
						if (totals.spend !== 0 || totals.impressions !== 0) {
							throw new Error(
								`Refusing retirement: ad ${ad_id} has delivery history (${totals.impressions} impressions, ${totals.spend} spend).`,
							);
						}
						return { ad, lifetime_delivery: totals };
					}),
				);

				const archived: any[] = [];
				for (const item of validated) {
					try {
						await metaPost(item.ad.id, { status: "ARCHIVED" });
						const verified = await metaFetch(item.ad.id, {
							fields: "id,name,account_id,campaign_id,adset_id,status,effective_status,updated_time",
						});
						if (verified.status !== "ARCHIVED") {
							throw new Error(`Ad ${item.ad.id} failed ARCHIVED verification.`);
						}
						archived.push({ ...verified, lifetime_delivery: item.lifetime_delivery });
					} catch (error) {
						return toolResult({
							completed: false,
							archived,
							failed_ad_id: item.ad.id,
							error: error instanceof Error ? error.message : String(error),
							note: "All ads were prevalidated before retirement; a Meta API failure caused a partial archive result.",
						});
					}
				}
				return toolResult({
					completed: true,
					archived,
					deleted: false,
					activation_performed: false,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_meta_campaign_draft",
		{
			description:
				"Inspect one owned Meta campaign and its ad sets and ads before activation. Read-only.",
			inputSchema: z.object({
				campaign_id: z.string().regex(/^\d+$/),
			}),
		},
		async ({ campaign_id }) => {
			try {
				const campaign = await assertMetaObjectOwnership(campaign_id, "campaign");
				const [adsets, ads] = await Promise.all([
					metaFetch(campaign_id + "/adsets", {
						fields: "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,billing_event,optimization_goal,destination_type,promoted_object,targeting",
						limit: 100,
					}),
					metaFetch(campaign_id + "/ads", {
						fields: "id,name,campaign_id,adset_id,status,effective_status,creative{id,name,status,object_story_id,thumbnail_url,object_story_spec,asset_feed_spec}",
						limit: 100,
					}),
				]);
				return toolResult({
					campaign: {
						...campaign,
						daily_budget_aud: metaBudgetAmount(campaign.daily_budget),
						lifetime_budget_aud: metaBudgetAmount(campaign.lifetime_budget),
					},
					adsets: (adsets.data ?? []).map((item: any) => ({
						...item,
						daily_budget_aud: metaBudgetAmount(item.daily_budget),
						lifetime_budget_aud: metaBudgetAmount(item.lifetime_budget),
					})),
					ads: ads.data ?? [],
					ready_for_review:
						campaign.status === "PAUSED" &&
						(adsets.data ?? []).length > 0 &&
						(ads.data ?? []).length > 0,
					activation_tool_available: false,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/* Read-only Google Ads reporting tools */

	const googleAdsDateSchema = {
		start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
		end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	};
	const googleAdsMetricFields =
		"metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.ctr, metrics.average_cpc, metrics.conversions, metrics.conversions_value, metrics.all_conversions, metrics.all_conversions_value";

	server.registerTool(
		"get_google_ads_account",
		{
			description:
				"Confirm read-only access to the configured Blindmotion Google Ads production account and return non-sensitive account metadata.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				const { customerId, loginCustomerId, serviceAccount } = getGoogleAdsConfig();
				const rows = await googleAdsSearch(`
					SELECT customer.id, customer.descriptive_name, customer.currency_code,
						customer.time_zone, customer.manager, customer.test_account,
						customer.auto_tagging_enabled
					FROM customer LIMIT 1
				`);
				return toolResult({
					access_confirmed: true,
					manager_customer_id: loginCustomerId,
					customer_id: customerId,
					service_account: serviceAccount.client_email,
					account: rows[0]?.customer ?? null,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"find_google_ads_campaign_across_manager",
		{
			description:
				"Locate one or more Google Ads campaign IDs across all accessible non-manager client accounts beneath the configured manager account. Read-only diagnostic for attribution reconciliation.",
			inputSchema: z.object({
				campaign_ids: z.array(z.string().regex(/^\d+$/)).min(1).max(20),
			}),
		},
		async ({ campaign_ids }) => {
			try {
				const { loginCustomerId, customerId } = getGoogleAdsConfig();

				const uniqueCampaignIds = [...new Set(campaign_ids.map((id) => id.trim()))];

				const idsClause = uniqueCampaignIds.join(", ");

				const clientRows = await googleAdsSearchCustomer(
					loginCustomerId,
					`
						SELECT
							customer_client.id,
							customer_client.descriptive_name,
							customer_client.manager,
							customer_client.level,
							customer_client.status
						FROM customer_client
						WHERE customer_client.level > 0
					`,
				);

				const clients = new Map<
					string,
					{
						customer_id: string;
						customer_name: string | null;
						level: number | null;
						status: string | null;
					}
				>();

				for (const row of clientRows) {
					const client = row.customerClient;
					const id = String(client?.id ?? "");

					if (!/^\d{10}$/.test(id) || client?.manager === true) {
						continue;
					}

					clients.set(id, {
						customer_id: id,
						customer_name: client?.descriptiveName ?? null,
						level: Number.isFinite(Number(client?.level)) ? Number(client.level) : null,
						status: client?.status ?? null,
					});
				}

				// Always include the currently configured production account,
				// even if manager enumeration behaves unexpectedly.
				if (!clients.has(customerId)) {
					clients.set(customerId, {
						customer_id: customerId,
						customer_name: null,
						level: null,
						status: null,
					});
				}

				const matches: any[] = [];
				const unqueryableClients: any[] = [];

				for (const client of clients.values()) {
					try {
						const rows = await googleAdsSearchCustomer(
							client.customer_id,
							`
								SELECT
									campaign.id,
									campaign.name,
									campaign.status,
									campaign.advertising_channel_type
								FROM campaign
								WHERE campaign.id IN (${idsClause})
							`,
						);

						for (const row of rows) {
							matches.push({
								customer_id: client.customer_id,
								customer_name: client.customer_name,
								manager_level: client.level,
								customer_status: client.status,
								campaign: row.campaign,
							});
						}
					} catch (error) {
						unqueryableClients.push({
							customer_id: client.customer_id,
							customer_name: client.customer_name,
							manager_level: client.level,
							customer_status: client.status,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}

				const matchedIds = new Set(
					matches.map((match) => String(match.campaign?.id ?? "")),
				);

				return toolResult({
					manager_customer_id: loginCustomerId,
					configured_customer_id: customerId,
					requested_campaign_ids: uniqueCampaignIds,
					client_accounts_considered: clients.size,
					matches,
					unmatched_campaign_ids: uniqueCampaignIds.filter((id) => !matchedIds.has(id)),
					unqueryable_clients: unqueryableClients,
					read_only: true,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);
	server.registerTool(
		"get_google_ads_summary",
		{
			description:
				"Summarise Blindmotion Google Ads impressions, clicks, spend, conversions, conversion value and reported ROAS for a date range.",
			inputSchema: z.object(googleAdsDateSchema),
		},
		async ({ start_date, end_date }) => {
			try {
				assertGoogleAdsDate(start_date, "start_date");
				assertGoogleAdsDate(end_date, "end_date");
				const rows = await googleAdsSearch(`
					SELECT customer.id, ${googleAdsMetricFields}
					FROM customer
					WHERE segments.date BETWEEN '${start_date}' AND '${end_date}'
				`);
				return toolResult({ start_date, end_date, data: normalizeGoogleAdsRows(rows) });
			} catch (error) {
				return toolError(error);
			}
		},
	);

	const registerGoogleAdsPerformanceTool = (
		name: string,
		resource: "campaign" | "ad_group" | "ad_group_ad",
		identityFields: string,
		description: string,
	) => {
		server.registerTool(
			name,
			{
				description,
				inputSchema: z.object({
					...googleAdsDateSchema,
					limit: z.number().int().min(1).max(1000).default(100),
				}),
			},
			async ({ start_date, end_date, limit }) => {
				try {
					assertGoogleAdsDate(start_date, "start_date");
					assertGoogleAdsDate(end_date, "end_date");
					const rows = await googleAdsSearch(`
						SELECT ${identityFields}, ${googleAdsMetricFields}
						FROM ${resource}
						WHERE segments.date BETWEEN '${start_date}' AND '${end_date}'
						ORDER BY metrics.cost_micros DESC
						LIMIT ${limit}
					`);
					return toolResult({ start_date, end_date, data: normalizeGoogleAdsRows(rows) });
				} catch (error) {
					return toolError(error);
				}
			},
		);
	};

	registerGoogleAdsPerformanceTool(
		"get_google_ads_campaign_performance",
		"campaign",
		"campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type",
		"Return read-only Blindmotion Google Ads campaign performance for a date range.",
	);
	registerGoogleAdsPerformanceTool(
		"get_google_ads_ad_group_performance",
		"ad_group",
		"campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group.status, ad_group.type",
		"Return read-only Blindmotion Google Ads ad-group performance for a date range.",
	);
	registerGoogleAdsPerformanceTool(
		"get_google_ads_ad_performance",
		"ad_group_ad",
		"campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.status",
		"Return read-only Blindmotion Google Ads individual-ad performance for a date range.",
	);

	server.registerTool(
		"get_google_ads_keyword_performance",
		{
			description:
				"Return read-only Google Ads keyword performance including keyword text and match type for a date range.",
			inputSchema: z.object({
				...googleAdsDateSchema,
				limit: z.number().int().min(1).max(1000).default(250),
			}),
		},
		async ({ start_date, end_date, limit }) => {
			try {
				const rows = await googleAdsSearch(`
					SELECT campaign.id, campaign.name, ad_group.id, ad_group.name,
						ad_group_criterion.criterion_id, ad_group_criterion.status,
						ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
						${googleAdsMetricFields}
					FROM keyword_view
					WHERE segments.date BETWEEN '${start_date}' AND '${end_date}'
					ORDER BY metrics.cost_micros DESC LIMIT ${limit}
				`);
				return toolResult({ start_date, end_date, data: normalizeGoogleAdsRows(rows) });
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_google_ads_search_terms",
		{
			description:
				"Return actual Google search terms that triggered Blindmotion ads, with performance metrics, for a date range.",
			inputSchema: z.object({
				...googleAdsDateSchema,
				limit: z.number().int().min(1).max(1000).default(250),
			}),
		},
		async ({ start_date, end_date, limit }) => {
			try {
				const rows = await googleAdsSearch(`
					SELECT campaign.id, campaign.name, ad_group.id, ad_group.name,
						search_term_view.search_term, search_term_view.status,
						${googleAdsMetricFields}
					FROM search_term_view
					WHERE segments.date BETWEEN '${start_date}' AND '${end_date}'
					ORDER BY metrics.cost_micros DESC LIMIT ${limit}
				`);
				return toolResult({ start_date, end_date, data: normalizeGoogleAdsRows(rows) });
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_google_ads_conversion_performance",
		{
			description:
				"Return Google Ads conversions and conversion value grouped by conversion action for a date range.",
			inputSchema: z.object(googleAdsDateSchema),
		},
		async ({ start_date, end_date }) => {
			try {
				const rows = await googleAdsSearch(`
					SELECT segments.conversion_action_name, segments.conversion_action_category,
						metrics.conversions, metrics.conversions_value,
						metrics.all_conversions, metrics.all_conversions_value
					FROM customer
					WHERE segments.date BETWEEN '${start_date}' AND '${end_date}'
					ORDER BY metrics.all_conversions DESC
				`);
				return toolResult({ start_date, end_date, data: normalizeGoogleAdsRows(rows) });
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_google_ads_product_performance",
		{
			description:
				"Return read-only Shopping and Performance Max product performance by Merchant Center item for a date range.",
			inputSchema: z.object({
				...googleAdsDateSchema,
				limit: z.number().int().min(1).max(1000).default(250),
			}),
		},
		async ({ start_date, end_date, limit }) => {
			try {
				const rows = await googleAdsSearch(`
					SELECT campaign.id, campaign.name, segments.product_item_id,
						segments.product_title, segments.product_brand,
						segments.product_type_l1, ${googleAdsMetricFields}
					FROM shopping_performance_view
					WHERE segments.date BETWEEN '${start_date}' AND '${end_date}'
					ORDER BY metrics.cost_micros DESC LIMIT ${limit}
				`);
				return toolResult({ start_date, end_date, data: normalizeGoogleAdsRows(rows) });
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_google_ads_daily_performance",
		{
			description:
				"Return daily Blindmotion Google Ads spend, traffic, conversions and conversion value for a date range.",
			inputSchema: z.object(googleAdsDateSchema),
		},
		async ({ start_date, end_date }) => {
			try {
				const rows = await googleAdsSearch(`
					SELECT segments.date, ${googleAdsMetricFields}
					FROM customer
					WHERE segments.date BETWEEN '${start_date}' AND '${end_date}'
					ORDER BY segments.date ASC
				`);
				return toolResult({ start_date, end_date, data: normalizeGoogleAdsRows(rows) });
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/* Guarded Google Ads creation tools. They can only build a PAUSED ZipGrip draft. */

	const zipGripBudgetSchema = z
		.number()
		.min(5)
		.max(50)
		.default(20)
		.describe("Daily campaign budget in AUD, hard-limited to A$5–A$50.");

	server.registerTool(
		"preview_google_ads_zipgrip_pmax_paused",
		{
			description:
				"Preview and API-validate the fixed Blindmotion ZipGrip retail Performance Max draft. Read-only: validateOnly is used and no Google Ads resources are created.",
			inputSchema: z.object({
				daily_budget_aud: zipGripBudgetSchema,
			}),
		},
		async ({ daily_budget_aud }) => {
			try {
				assertZipGripGoogleAdsAccount();
				const existing = await findExistingZipGripCampaign();
				if (existing.length > 0) {
					return toolResult({
						valid_for_creation: false,
						reason: "A non-removed campaign already uses the locked campaign name.",
						existing_campaign: existing[0]?.campaign ?? existing[0],
						activation_tool_available: false,
					});
				}

				const plan = zipGripPmaxPlan(daily_budget_aud);
				await googleAdsMutate(plan.mutateOperations, true);
				const { mutateOperations: _operations, ...safePlan } = plan;
				return toolResult({
					valid_for_creation: true,
					api_validation_passed: true,
					created: false,
					...safePlan,
					confirmation_required: GOOGLE_ADS_ZIPGRIP_CONFIRMATION,
					note: "This is a product-filtered retail campaign skeleton. Add and review creative assets before any separately implemented activation step.",
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"create_google_ads_zipgrip_pmax_paused",
		{
			description:
				"Create the fixed Blindmotion ZipGrip retail Performance Max campaign skeleton, asset group and gla_1301-only listing partition. Campaign and asset group are always PAUSED; this tool cannot enable delivery.",
			inputSchema: z.object({
				daily_budget_aud: zipGripBudgetSchema,
				confirmation: z.literal(GOOGLE_ADS_ZIPGRIP_CONFIRMATION),
			}),
		},
		async ({ daily_budget_aud }) => {
			try {
				assertZipGripGoogleAdsAccount();
				const existing = await findExistingZipGripCampaign();
				if (existing.length > 0) {
					throw new Error(
						"Refusing creation: a non-removed BM Online PMax — ZipGrip campaign already exists.",
					);
				}

				const plan = zipGripPmaxPlan(daily_budget_aud);
				await googleAdsMutate(plan.mutateOperations, true);
				const mutation = await googleAdsMutate(plan.mutateOperations, false);
				const campaigns = await findExistingZipGripCampaign();
				const campaign = campaigns[0]?.campaign;
				if (
					campaigns.length !== 1 ||
					campaign?.status !== "PAUSED" ||
					campaign?.advertisingChannelType !== "PERFORMANCE_MAX"
				) {
					throw new Error(
						"Creation returned, but the campaign failed the unique PAUSED Performance Max verification.",
					);
				}

				const assetGroups = await googleAdsSearch(`
					SELECT asset_group.id, asset_group.resource_name, asset_group.name,
						asset_group.status, asset_group.final_urls, campaign.id
					FROM asset_group
					WHERE campaign.id = ${campaign.id}
					LIMIT 10
				`);
				if (assetGroups.length !== 1 || assetGroups[0]?.assetGroup?.status !== "PAUSED") {
					throw new Error(
						"Campaign was created, but its asset group failed the unique PAUSED verification. Manual review is required.",
					);
				}

				return toolResult({
					created: true,
					activation_performed: false,
					api_validation_passed_before_creation: true,
					campaign,
					asset_group: assetGroups[0].assetGroup,
					merchant_id: plan.merchant_id,
					feed_label: plan.feed_label,
					included_item_id: plan.included_item_id,
					all_other_items: plan.all_other_items,
					daily_budget_aud,
					creative_assets_created: false,
					activation_tool_available: false,
					mutation_response_count: mutation.mutateOperationResponses?.length ?? 0,
					note: "The campaign is structurally created but intentionally incomplete for delivery until creative assets are added and reviewed.",
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	// Guarded ZipGrip asset management. Every write is locked to the known
	// PAUSED campaign and asset group, uses validateOnly, and cannot activate delivery.
	server.registerTool(
		"inspect_google_ads_zipgrip_asset_group",
		{
			description:
				"Read-only inspection of the locked ZipGrip PMax campaign and asset group, including current assets, Google ad strength, policy/serving status, requirements and completeness gaps.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				const state = await getZipGripAssetState();
				return toolResult({
					...state,
					created_or_modified: false,
					asset_strength_note:
						"Google's ad_strength and primary_status are output-only feedback. Completeness is also calculated from live non-removed asset links.",
					activation_prerequisite:
						"Activation remains out of scope until clean post-fix ZipGrip purchase tracking has been observed and the campaign is separately reviewed.",
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"preview_google_ads_zipgrip_exclusive_launch",
		{
			description:
				"Read-only preflight for the fixed ZipGrip launch: validate excluding gla_1301 from the locked existing PMax and Shopping product trees while enabling only the dedicated campaign and asset group.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				assertZipGripGoogleAdsAccount();
				const plan = await getZipGripExclusiveLaunchPlan();
				await googleAdsMutate(plan.operations, true);
				return toolResult({
					valid_for_launch: true,
					api_validation_passed: true,
					created_or_modified: false,
					dedicated_campaign_id: GOOGLE_ADS_ZIPGRIP_CAMPAIGN_ID,
					dedicated_asset_group_id: GOOGLE_ADS_ZIPGRIP_ASSET_GROUP_ID,
					excluded_item_id: GOOGLE_ADS_ZIPGRIP_ITEM_ID,
					source_pmax_campaign_id: GOOGLE_ADS_ZIPGRIP_SOURCE_PMAX_ID,
					source_shopping_campaign_ids: GOOGLE_ADS_ZIPGRIP_SOURCE_SHOPPING_IDS,
					pmax_asset_groups_to_change: new Set(
						plan.sourcePmaxFilters.map((row) => String(row.assetGroup?.id)),
					).size,
					shopping_ad_groups_to_change: new Set(
						plan.sourceShoppingCriteria.map((row) => String(row.adGroup?.id)),
					).size,
					confirmation_required: GOOGLE_ADS_ZIPGRIP_LAUNCH_CONFIRMATION,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"launch_google_ads_zipgrip_exclusively_guarded",
		{
			description:
				"Atomically exclude gla_1301 from the three locked existing campaign product trees and enable only the locked dedicated ZipGrip PMax campaign and asset group. Requires simple All products source trees, full asset approval, exact confirmation and validateOnly preflight.",
			inputSchema: z.object({
				confirmation: z.literal(GOOGLE_ADS_ZIPGRIP_LAUNCH_CONFIRMATION),
			}),
		},
		async () => {
			try {
				assertZipGripGoogleAdsAccount();
				const plan = await getZipGripExclusiveLaunchPlan();
				await googleAdsMutate(plan.operations, true);
				const mutation = await googleAdsMutate(plan.operations, false);
				const launched = await googleAdsSearch(`
					SELECT campaign.id, campaign.name, campaign.status,
						asset_group.id, asset_group.name, asset_group.status
					FROM asset_group
					WHERE campaign.id = ${GOOGLE_ADS_ZIPGRIP_CAMPAIGN_ID}
						AND asset_group.id = ${GOOGLE_ADS_ZIPGRIP_ASSET_GROUP_ID}
					LIMIT 1
				`);
				if (
					launched.length !== 1 ||
					launched[0]?.campaign?.status !== "ENABLED" ||
					launched[0]?.assetGroup?.status !== "ENABLED"
				) {
					throw new Error(
						"The atomic launch mutation returned, but the dedicated campaign and asset group did not verify as ENABLED. Manual review is required.",
					);
				}
				return toolResult({
					launched: true,
					api_validation_passed_before_mutation: true,
					campaign: launched[0].campaign,
					asset_group: launched[0].assetGroup,
					excluded_item_id: GOOGLE_ADS_ZIPGRIP_ITEM_ID,
					excluded_from_campaign_ids: [
						GOOGLE_ADS_ZIPGRIP_SOURCE_PMAX_ID,
						...GOOGLE_ADS_ZIPGRIP_SOURCE_SHOPPING_IDS,
					],
					sample_item_id_changed: false,
					daily_budget_changed: false,
					target_roas_added: false,
					mutation_response_count: mutation.mutateOperationResponses?.length ?? 0,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	const zipGripTextBatchSchema = z
		.object({
			headlines: z.array(z.string().trim().min(1).max(30)).max(15).default([]),
			long_headlines: z.array(z.string().trim().min(1).max(90)).max(5).default([]),
			descriptions: z.array(z.string().trim().min(1).max(90)).max(5).default([]),
			business_name: z.string().trim().min(1).max(25).optional(),
			confirmation: z.literal(GOOGLE_ADS_ZIPGRIP_TEXT_CONFIRMATION),
		})
		.superRefine((value, context) => {
			if (
				value.headlines.length +
					value.long_headlines.length +
					value.descriptions.length +
					(value.business_name ? 1 : 0) ===
				0
			) {
				context.addIssue({ code: "custom", message: "Supply at least one text asset." });
			}
			for (const [field, values] of [
				["headlines", value.headlines],
				["long_headlines", value.long_headlines],
				["descriptions", value.descriptions],
			] as const) {
				if (new Set(values).size !== values.length) {
					context.addIssue({
						code: "custom",
						path: [field],
						message: `Duplicate ${field.replace("_", " ")} are not allowed.`,
					});
				}
			}
		});

	server.registerTool(
		"add_google_ads_zipgrip_text_assets_guarded",
		{
			description:
				"Create or reuse text assets and link them only to the locked PAUSED ZipGrip campaign/asset group. Enforces limits, paused-state verification, exact confirmation and validateOnly preflight. Cannot activate delivery.",
			inputSchema: zipGripTextBatchSchema,
		},
		async ({ headlines, long_headlines, descriptions, business_name }) => {
			try {
				const before = await getZipGripAssetState();
				const requested = [
					...headlines.map((text) => ({ fieldType: "HEADLINE", text })),
					...long_headlines.map((text) => ({ fieldType: "LONG_HEADLINE", text })),
					...descriptions.map((text) => ({ fieldType: "DESCRIPTION", text })),
					...(business_name ? [{ fieldType: "BUSINESS_NAME", text: business_name }] : []),
				];
				const linked = new Set([
					...before.asset_group_assets.map(
						(row: any) =>
							`${row.assetGroupAsset?.fieldType}\u0000${row.asset?.textAsset?.text ?? ""}`,
					),
					...before.campaign_brand_assets.map(
						(row: any) =>
							`${row.campaignAsset?.fieldType}\u0000${row.asset?.textAsset?.text ?? ""}`,
					),
				]);
				const additions = requested.filter(
					(item) => !linked.has(`${item.fieldType}\u0000${item.text}`),
				);
				if (additions.length === 0) {
					return toolResult({
						created_or_linked: false,
						reason: "Every supplied text/field-type pair is already linked.",
						activation_performed: false,
					});
				}
				for (const fieldType of [
					"HEADLINE",
					"LONG_HEADLINE",
					"DESCRIPTION",
					"BUSINESS_NAME",
				] as const) {
					const total =
						(before.counts[fieldType] ?? 0) +
						additions.filter((item) => item.fieldType === fieldType).length;
					if (total > ZIPGRIP_ASSET_REQUIREMENTS[fieldType].max) {
						throw new Error(
							`${fieldType} would exceed Google's maximum of ${ZIPGRIP_ASSET_REQUIREMENTS[fieldType].max}.`,
						);
					}
				}

				const reusable = await reusableTextAssets();
				const operations: any[] = [];
				const summary: any[] = [];
				let temporaryId = -1000;
				for (const item of additions) {
					let assetResource = reusable.get(item.text);
					const reused = Boolean(assetResource);
					if (!assetResource) {
						const currentId = temporaryId--;
						assetResource = googleAdsAssetResource(String(currentId));
						operations.push({
							assetOperation: {
								create: {
									resourceName: assetResource,
									name: `ZipGrip ${item.fieldType} ${Math.abs(currentId)}`,
									textAsset: { text: item.text },
								},
							},
						});
					}
					operations.push(
						buildAssetLinkOperation(
							assetResource,
							item.fieldType,
							before.brand_guidelines_enabled,
						),
					);
					summary.push({
						field_type: item.fieldType,
						text: item.text,
						reused_existing_asset: reused,
						link_level:
							before.brand_guidelines_enabled && item.fieldType === "BUSINESS_NAME"
								? "CAMPAIGN"
								: "ASSET_GROUP",
					});
				}
				await googleAdsMutate(operations, true);
				const mutation = await googleAdsMutate(operations, false);
				const after = await getZipGripAssetState();
				return toolResult({
					created_or_linked: true,
					api_validation_passed_before_creation: true,
					activation_performed: false,
					assets: summary,
					mutation_response_count: mutation.mutateOperationResponses?.length ?? 0,
					completeness: after.completeness,
					google_ad_strength: after.asset_group?.adStrength,
					activation_tool_available: false,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	const zipGripImageFieldTypeSchema = z.enum([
		"MARKETING_IMAGE",
		"SQUARE_MARKETING_IMAGE",
		"PORTRAIT_MARKETING_IMAGE",
		"LOGO",
		"LANDSCAPE_LOGO",
	]);
	const zipGripImageItemSchema = z
		.object({
			field_type: zipGripImageFieldTypeSchema,
			name: z.string().trim().min(1).max(100),
			mime_type: z.enum(["image/jpeg", "image/png"]).optional(),
			image_base64: z.string().min(100).max(7_000_000).optional(),
			existing_asset_id: z
				.string()
				.regex(/^[1-9][0-9]*$/)
				.optional(),
		})
		.superRefine((value, context) => {
			const completeUpload = Boolean(value.image_base64 && value.mime_type);
			const anyUpload = value.image_base64 !== undefined || value.mime_type !== undefined;
			const reuse = value.existing_asset_id !== undefined;
			if (reuse === anyUpload || (anyUpload && !completeUpload)) {
				context.addIssue({
					code: "custom",
					message:
						"Provide either existing_asset_id, or both mime_type and image_base64.",
				});
			}
		});

	const zipGripBootstrapSchema = z
		.object({
			headlines: z.array(z.string().trim().min(1).max(30)).min(3).max(15),
			long_headlines: z.array(z.string().trim().min(1).max(90)).min(1).max(5),
			descriptions: z.array(z.string().trim().min(1).max(90)).min(2).max(5),
			business_name: z.string().trim().min(1).max(25),
			images: z.array(zipGripImageItemSchema).min(3).max(20),
			confirmation: z.literal(GOOGLE_ADS_ZIPGRIP_BOOTSTRAP_CONFIRMATION),
		})
		.superRefine((value, context) => {
			for (const [field, values] of [
				["headlines", value.headlines],
				["long_headlines", value.long_headlines],
				["descriptions", value.descriptions],
			] as const) {
				if (new Set(values).size !== values.length) {
					context.addIssue({
						code: "custom",
						path: [field],
						message: `Duplicate ${field.replace("_", " ")} are not allowed.`,
					});
				}
			}
			for (const fieldType of [
				"MARKETING_IMAGE",
				"SQUARE_MARKETING_IMAGE",
				"LOGO",
			] as const) {
				if (!value.images.some((image) => image.field_type === fieldType)) {
					context.addIssue({
						code: "custom",
						path: ["images"],
						message: `The bootstrap bundle requires at least one ${fieldType}.`,
					});
				}
			}
			const imageIdentities = value.images.map(
				(image) =>
					`${image.field_type}\u0000${image.existing_asset_id ?? image.image_base64}`,
			);
			if (new Set(imageIdentities).size !== imageIdentities.length) {
				context.addIssue({
					code: "custom",
					path: ["images"],
					message: "Duplicate image/field-type pairs are not allowed.",
				});
			}
		});

	server.registerTool(
		"bootstrap_google_ads_zipgrip_asset_group_guarded",
		{
			description:
				"Atomically create or reuse and link a complete initial text, image and brand bundle only to the locked PAUSED ZipGrip campaign/asset group. Requires Google's full minimum asset set, exact confirmation, paused-state verification and validateOnly preflight. Cannot activate delivery.",
			inputSchema: zipGripBootstrapSchema,
		},
		async ({ headlines, long_headlines, descriptions, business_name, images }) => {
			try {
				const before = await getZipGripAssetState();
				if (before.minimum_complete) {
					throw new Error(
						"Refusing bootstrap: the ZipGrip asset group already meets Google's minimum asset requirements.",
					);
				}

				const requestedText = [
					...headlines.map((text) => ({ fieldType: "HEADLINE", text })),
					...long_headlines.map((text) => ({ fieldType: "LONG_HEADLINE", text })),
					...descriptions.map((text) => ({ fieldType: "DESCRIPTION", text })),
					{ fieldType: "BUSINESS_NAME", text: business_name },
				];
				const linkedText = new Set([
					...before.asset_group_assets.map(
						(row: any) =>
							`${row.assetGroupAsset?.fieldType}\u0000${row.asset?.textAsset?.text ?? ""}`,
					),
					...before.campaign_brand_assets.map(
						(row: any) =>
							`${row.campaignAsset?.fieldType}\u0000${row.asset?.textAsset?.text ?? ""}`,
					),
				]);
				const textAdditions = requestedText.filter(
					(item) => !linkedText.has(`${item.fieldType}\u0000${item.text}`),
				);

				const requestedCounts: Record<string, number> = {};
				for (const item of textAdditions) {
					requestedCounts[item.fieldType] = (requestedCounts[item.fieldType] ?? 0) + 1;
				}
				for (const image of images) {
					requestedCounts[image.field_type] =
						(requestedCounts[image.field_type] ?? 0) + 1;
				}
				for (const [fieldType, adding] of Object.entries(requestedCounts)) {
					const requirement =
						ZIPGRIP_ASSET_REQUIREMENTS[
							fieldType as keyof typeof ZIPGRIP_ASSET_REQUIREMENTS
						];
					if (
						!requirement ||
						(before.counts[fieldType] ?? 0) + adding > requirement.max
					) {
						throw new Error(
							`${fieldType} would exceed Google's maximum of ${requirement?.max ?? 0}.`,
						);
					}
				}
				for (const fieldType of [
					"HEADLINE",
					"LONG_HEADLINE",
					"DESCRIPTION",
					"MARKETING_IMAGE",
					"SQUARE_MARKETING_IMAGE",
					"BUSINESS_NAME",
					"LOGO",
				] as const) {
					const total =
						(before.counts[fieldType] ?? 0) + (requestedCounts[fieldType] ?? 0);
					if (total < ZIPGRIP_ASSET_REQUIREMENTS[fieldType].min) {
						throw new Error(
							`The bootstrap bundle would leave ${fieldType} below Google's minimum of ${ZIPGRIP_ASSET_REQUIREMENTS[fieldType].min}.`,
						);
					}
				}

				const reusableText = await reusableTextAssets();
				const existingImageLinks = new Set([
					...before.asset_group_assets.map(
						(row: any) =>
							`${row.assetGroupAsset?.fieldType}\u0000${row.asset?.resourceName}`,
					),
					...before.campaign_brand_assets.map(
						(row: any) =>
							`${row.campaignAsset?.fieldType}\u0000${row.asset?.resourceName}`,
					),
				]);
				const assetOperations: any[] = [];
				const assetGroupLinkOperations: any[] = [];
				const campaignLinkOperations: any[] = [];
				const textSummary: any[] = [];
				const imageSummary: any[] = [];
				let textTemporaryId = -4000;
				let imageTemporaryId = -5000;

				for (const item of textAdditions) {
					let assetResource = reusableText.get(item.text);
					const reused = Boolean(assetResource);
					if (!assetResource) {
						const currentId = textTemporaryId--;
						assetResource = googleAdsAssetResource(String(currentId));
						assetOperations.push({
							assetOperation: {
								create: {
									resourceName: assetResource,
									name: `ZipGrip ${item.fieldType} ${Math.abs(currentId)}`,
									textAsset: { text: item.text },
								},
							},
						});
					}
					const linkOperation = buildAssetLinkOperation(
						assetResource,
						item.fieldType,
						before.brand_guidelines_enabled,
					);
					if (linkOperation.campaignAssetOperation) {
						campaignLinkOperations.push(linkOperation);
					} else {
						assetGroupLinkOperations.push(linkOperation);
					}
					textSummary.push({
						field_type: item.fieldType,
						text: item.text,
						reused_existing_asset: reused,
					});
				}

				for (const image of images) {
					let assetResource: string;
					let imageInfo: any;
					if (image.existing_asset_id) {
						assetResource = googleAdsAssetResource(image.existing_asset_id);
						const rows = await googleAdsSearch(`
							SELECT asset.id, asset.resource_name, asset.name, asset.type,
								asset.image_asset.full_size.width_pixels,
								asset.image_asset.full_size.height_pixels,
								asset.image_asset.file_size
							FROM asset
							WHERE asset.id = ${image.existing_asset_id}
							LIMIT 1
						`);
						if (rows.length !== 1 || rows[0]?.asset?.type !== "IMAGE") {
							throw new Error(
								`Existing asset ${image.existing_asset_id} is not a uniquely verified image asset.`,
							);
						}
						if (existingImageLinks.has(`${image.field_type}\u0000${assetResource}`)) {
							throw new Error(
								`Asset ${image.existing_asset_id} is already linked as ${image.field_type}.`,
							);
						}
						imageInfo = rows[0].asset.imageAsset?.fullSize;
					} else {
						const bytes = decodeBase64(image.image_base64!);
						imageInfo = validateZipGripImage(bytes, image.mime_type!, image.field_type);
						const digest = await sha256Hex(bytes);
						const currentId = imageTemporaryId--;
						assetResource = googleAdsAssetResource(String(currentId));
						assetOperations.push({
							assetOperation: {
								create: {
									resourceName: assetResource,
									name: `${image.name.slice(0, 82)} ${digest.slice(0, 12)}`,
									imageAsset: { data: image.image_base64 },
								},
							},
						});
					}
					const linkOperation = buildAssetLinkOperation(
						assetResource,
						image.field_type,
						before.brand_guidelines_enabled,
					);
					if (linkOperation.campaignAssetOperation) {
						campaignLinkOperations.push(linkOperation);
					} else {
						assetGroupLinkOperations.push(linkOperation);
					}
					imageSummary.push({
						field_type: image.field_type,
						name: image.name,
						existing_asset_id: image.existing_asset_id ?? null,
						image: imageInfo,
					});
				}

				// Google evaluates the required PMax bundle atomically only when every
				// AssetOperation comes first and every AssetGroupAssetOperation remains
				// consecutive, before the campaign-level brand links.
				const operations = [
					...assetOperations,
					...assetGroupLinkOperations,
					...campaignLinkOperations,
				];
				await googleAdsMutate(operations, true);
				const mutation = await googleAdsMutate(operations, false);
				const after = await getZipGripAssetState();
				if (!after.minimum_complete) {
					throw new Error(
						"Bootstrap returned, but the ZipGrip asset group still fails minimum completeness. Manual review is required.",
					);
				}
				return toolResult({
					bootstrapped: true,
					api_validation_passed_before_creation: true,
					activation_performed: false,
					text_assets: textSummary,
					image_assets: imageSummary,
					mutation_response_count: mutation.mutateOperationResponses?.length ?? 0,
					completeness: after.completeness,
					google_ad_strength: after.asset_group?.adStrength,
					activation_tool_available: false,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"add_google_ads_zipgrip_image_assets_guarded",
		{
			description:
				"Upload JPEG/PNG assets or link existing Google Ads image assets only to the locked PAUSED ZipGrip campaign/asset group. Validates dimensions, ratio, size, limits, paused state, exact confirmation and validateOnly preflight. Cannot activate delivery.",
			inputSchema: z.object({
				images: z.array(zipGripImageItemSchema).min(1).max(20),
				confirmation: z.literal(GOOGLE_ADS_ZIPGRIP_IMAGE_CONFIRMATION),
			}),
		},
		async ({ images }) => {
			try {
				const before = await getZipGripAssetState();
				const requestedCounts: Record<string, number> = {};
				for (const image of images) {
					requestedCounts[image.field_type] =
						(requestedCounts[image.field_type] ?? 0) + 1;
				}
				for (const [fieldType, adding] of Object.entries(requestedCounts)) {
					const typedField = fieldType as
						| "MARKETING_IMAGE"
						| "SQUARE_MARKETING_IMAGE"
						| "PORTRAIT_MARKETING_IMAGE"
						| "LOGO"
						| "LANDSCAPE_LOGO";
					if (
						(before.counts[fieldType] ?? 0) + adding >
						ZIPGRIP_ASSET_REQUIREMENTS[typedField].max
					) {
						throw new Error(
							`${fieldType} would exceed Google's maximum of ${ZIPGRIP_ASSET_REQUIREMENTS[typedField].max}.`,
						);
					}
				}

				const existingLinks = new Set([
					...before.asset_group_assets.map(
						(row: any) =>
							`${row.assetGroupAsset?.fieldType}\u0000${row.asset?.resourceName}`,
					),
					...before.campaign_brand_assets.map(
						(row: any) =>
							`${row.campaignAsset?.fieldType}\u0000${row.asset?.resourceName}`,
					),
				]);
				const operations: any[] = [];
				const summary: any[] = [];
				let temporaryId = -2000;
				for (const image of images) {
					let assetResource: string;
					let imageInfo: any;
					if (image.existing_asset_id) {
						assetResource = googleAdsAssetResource(image.existing_asset_id);
						const rows = await googleAdsSearch(`
							SELECT asset.id, asset.resource_name, asset.name, asset.type,
								asset.image_asset.full_size.width_pixels,
								asset.image_asset.full_size.height_pixels,
								asset.image_asset.file_size
							FROM asset
							WHERE asset.id = ${image.existing_asset_id}
							LIMIT 1
						`);
						if (rows.length !== 1 || rows[0]?.asset?.type !== "IMAGE") {
							throw new Error(
								`Existing asset ${image.existing_asset_id} is not a uniquely verified image asset.`,
							);
						}
						if (existingLinks.has(`${image.field_type}\u0000${assetResource}`)) {
							throw new Error(
								`Asset ${image.existing_asset_id} is already linked as ${image.field_type}.`,
							);
						}
						imageInfo = rows[0].asset.imageAsset?.fullSize;
					} else {
						const bytes = decodeBase64(image.image_base64!);
						imageInfo = validateZipGripImage(bytes, image.mime_type!, image.field_type);
						const digest = await sha256Hex(bytes);
						const currentId = temporaryId--;
						assetResource = googleAdsAssetResource(String(currentId));
						operations.push({
							assetOperation: {
								create: {
									resourceName: assetResource,
									name: `${image.name.slice(0, 82)} ${digest.slice(0, 12)}`,
									imageAsset: { data: image.image_base64 },
								},
							},
						});
					}
					operations.push(
						buildAssetLinkOperation(
							assetResource,
							image.field_type,
							before.brand_guidelines_enabled,
						),
					);
					summary.push({
						field_type: image.field_type,
						name: image.name,
						existing_asset_id: image.existing_asset_id ?? null,
						image: imageInfo,
						link_level:
							before.brand_guidelines_enabled &&
							["LOGO", "LANDSCAPE_LOGO"].includes(image.field_type)
								? "CAMPAIGN"
								: "ASSET_GROUP",
					});
				}
				await googleAdsMutate(operations, true);
				const mutation = await googleAdsMutate(operations, false);
				const after = await getZipGripAssetState();
				return toolResult({
					created_or_linked: true,
					api_validation_passed_before_creation: true,
					activation_performed: false,
					images: summary,
					mutation_response_count: mutation.mutateOperationResponses?.length ?? 0,
					completeness: after.completeness,
					google_ad_strength: after.asset_group?.adStrength,
					activation_tool_available: false,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"link_google_ads_zipgrip_youtube_assets_guarded",
		{
			description:
				"Create or reuse YouTube assets and link them only to the locked PAUSED ZipGrip asset group. Enforces ID/count rules, paused-state verification, exact confirmation and validateOnly preflight. Cannot upload to YouTube or activate delivery.",
			inputSchema: z.object({
				videos: z
					.array(
						z.object({
							youtube_video_id: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
							name: z.string().trim().min(1).max(100),
						}),
					)
					.min(1)
					.max(15),
				confirmation: z.literal(GOOGLE_ADS_ZIPGRIP_VIDEO_CONFIRMATION),
			}),
		},
		async ({ videos }) => {
			try {
				const before = await getZipGripAssetState();
				if (new Set(videos.map((video) => video.youtube_video_id)).size !== videos.length) {
					throw new Error("Duplicate YouTube video IDs are not allowed.");
				}
				const linkedVideoIds = new Set(
					before.asset_group_assets
						.filter((row: any) => row.assetGroupAsset?.fieldType === "YOUTUBE_VIDEO")
						.map((row: any) => row.asset?.youtubeVideoAsset?.youtubeVideoId),
				);
				const additions = videos.filter(
					(video) => !linkedVideoIds.has(video.youtube_video_id),
				);
				if (additions.length === 0) {
					return toolResult({
						created_or_linked: false,
						reason: "Every supplied YouTube video is already linked.",
						activation_performed: false,
					});
				}
				if (
					(before.counts.YOUTUBE_VIDEO ?? 0) + additions.length >
					ZIPGRIP_ASSET_REQUIREMENTS.YOUTUBE_VIDEO.max
				) {
					throw new Error(
						"The request would exceed Google's limit of 15 YouTube videos.",
					);
				}

				const reusable = await reusableYoutubeAssets();
				const operations: any[] = [];
				const summary: any[] = [];
				let temporaryId = -3000;
				for (const video of additions) {
					let assetResource = reusable.get(video.youtube_video_id);
					const reused = Boolean(assetResource);
					if (!assetResource) {
						const currentId = temporaryId--;
						assetResource = googleAdsAssetResource(String(currentId));
						operations.push({
							assetOperation: {
								create: {
									resourceName: assetResource,
									name: `ZipGrip YouTube ${video.name}`.slice(0, 128),
									youtubeVideoAsset: { youtubeVideoId: video.youtube_video_id },
								},
							},
						});
					}
					operations.push(buildAssetLinkOperation(assetResource, "YOUTUBE_VIDEO", false));
					summary.push({
						youtube_video_id: video.youtube_video_id,
						name: video.name,
						reused_existing_asset: reused,
					});
				}
				await googleAdsMutate(operations, true);
				const mutation = await googleAdsMutate(operations, false);
				const after = await getZipGripAssetState();
				return toolResult({
					created_or_linked: true,
					api_validation_passed_before_creation: true,
					activation_performed: false,
					videos: summary,
					mutation_response_count: mutation.mutateOperationResponses?.length ?? 0,
					completeness: after.completeness,
					google_ad_strength: after.asset_group?.adStrength,
					activation_tool_available: false,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/* Read-only Google Analytics 4 reporting tools */

	server.registerTool(
		"get_ga4_property",
		{
			description:
				"Confirm access to the configured Blindmotion GA4 property and return a small non-sensitive activity check.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				const { propertyId, serviceAccount } = getGa4Config();
				const report = await ga4RunReport({
					dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }],
					metrics: [{ name: "sessions" }, { name: "activeUsers" }],
				});
				return toolResult({
					property_id: propertyId,
					service_account: serviceAccount.client_email,
					access_confirmed: true,
					activity_check: ga4ReportResult(report, "7daysAgo", "yesterday"),
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_ga4_summary",
		{
			description:
				"Summarise Blindmotion GA4 users, sessions, engagement, ecommerce purchases and reported revenue for a date range.",
			inputSchema: z.object({ start_date: z.string(), end_date: z.string() }),
		},
		async ({ start_date, end_date }) => {
			try {
				const report = await ga4RunReport({
					dateRanges: [{ startDate: start_date, endDate: end_date }],
					metrics: [
						{ name: "totalUsers" },
						{ name: "newUsers" },
						{ name: "activeUsers" },
						{ name: "sessions" },
						{ name: "engagedSessions" },
						{ name: "engagementRate" },
						{ name: "screenPageViews" },
						{ name: "keyEvents" },
						{ name: "ecommercePurchases" },
						{ name: "purchaseRevenue" },
					],
				});
				return toolResult(ga4ReportResult(report, start_date, end_date));
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_ga4_daily_performance",
		{
			description:
				"Return daily Blindmotion GA4 traffic, engagement, ecommerce purchases and revenue for a date range.",
			inputSchema: z.object({ start_date: z.string(), end_date: z.string() }),
		},
		async ({ start_date, end_date }) => {
			try {
				const report = await ga4RunReport({
					dateRanges: [{ startDate: start_date, endDate: end_date }],
					dimensions: [{ name: "date" }],
					metrics: [
						{ name: "activeUsers" },
						{ name: "sessions" },
						{ name: "engagedSessions" },
						{ name: "screenPageViews" },
						{ name: "keyEvents" },
						{ name: "ecommercePurchases" },
						{ name: "purchaseRevenue" },
					],
					limit: "10000",
					orderBys: [{ dimension: { dimensionName: "date" } }],
				});
				return toolResult(ga4ReportResult(report, start_date, end_date));
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_ga4_traffic_acquisition",
		{
			description:
				"Return Blindmotion GA4 session acquisition performance by channel and source/medium for a date range.",
			inputSchema: z.object({
				start_date: z.string(),
				end_date: z.string(),
				limit: z.number().int().min(1).max(250).default(100),
			}),
		},
		async ({ start_date, end_date, limit }) => {
			try {
				const report = await ga4RunReport({
					dateRanges: [{ startDate: start_date, endDate: end_date }],
					dimensions: [
						{ name: "sessionDefaultChannelGroup" },
						{ name: "sessionSourceMedium" },
					],
					metrics: [
						{ name: "sessions" },
						{ name: "activeUsers" },
						{ name: "engagedSessions" },
						{ name: "engagementRate" },
						{ name: "keyEvents" },
						{ name: "ecommercePurchases" },
						{ name: "purchaseRevenue" },
					],
					limit: String(limit),
					orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
				});
				return toolResult(ga4ReportResult(report, start_date, end_date));
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_ga4_landing_pages",
		{
			description:
				"Return Blindmotion GA4 landing-page traffic, engagement, ecommerce purchases and revenue for a date range.",
			inputSchema: z.object({
				start_date: z.string(),
				end_date: z.string(),
				limit: z.number().int().min(1).max(250).default(100),
			}),
		},
		async ({ start_date, end_date, limit }) => {
			try {
				const report = await ga4RunReport({
					dateRanges: [{ startDate: start_date, endDate: end_date }],
					dimensions: [{ name: "landingPagePlusQueryString" }],
					metrics: [
						{ name: "sessions" },
						{ name: "activeUsers" },
						{ name: "engagedSessions" },
						{ name: "engagementRate" },
						{ name: "keyEvents" },
						{ name: "ecommercePurchases" },
						{ name: "purchaseRevenue" },
					],
					limit: String(limit),
					orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
				});
				return toolResult(ga4ReportResult(report, start_date, end_date));
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_ga4_ecommerce_performance",
		{
			description:
				"Return Blindmotion GA4 ecommerce item views, cart additions, purchases and item revenue for a date range.",
			inputSchema: z.object({
				start_date: z.string(),
				end_date: z.string(),
				limit: z.number().int().min(1).max(250).default(100),
			}),
		},
		async ({ start_date, end_date, limit }) => {
			try {
				const report = await ga4RunReport({
					dateRanges: [{ startDate: start_date, endDate: end_date }],
					dimensions: [{ name: "itemId" }, { name: "itemName" }],
					metrics: [
						{ name: "itemsViewed" },
						{ name: "itemsAddedToCart" },
						{ name: "itemsPurchased" },
						{ name: "itemRevenue" },
					],
					limit: String(limit),
					orderBys: [{ metric: { metricName: "itemRevenue" }, desc: true }],
				});
				return toolResult(ga4ReportResult(report, start_date, end_date));
			} catch (error) {
				return toolError(error);
			}
		},
	);

	return server;
}

const handler = createMcpHandler(createServer);

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return handler(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
