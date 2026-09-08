import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const COMMERCIAL_START_DATE = "2024-07-01";
const GENUINE_ORDER_MIN_TOTAL = 20;

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
		throw new Error(`WordPress media upload failed: ${response.status} ${await response.text()}`);
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
		return bytes.slice(0, 8).every(
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
	return [...relativePath.matchAll(/(?:^|\.)([^.[\]]+)|\[(\d+)\]/g)].map((match) =>
		match[1] ?? Number(match[2]),
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

async function metaFetch(path: string, params: Record<string, string | number | undefined> = {}) {
	const { accessToken, apiVersion } = getMetaConfig();
	const url = new URL(`https://graph.facebook.com/${apiVersion}/${path}`);

	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) {
			url.searchParams.set(key, String(value));
		}
	}

	const response = await fetch(url.toString(), {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
		},
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Meta Marketing API request failed: ${response.status} ${body}`);
	}

	return response.json<any>();
}

async function metaPost(path: string, params: Record<string, string | number>) {
	const { accessToken, apiVersion } = getMetaConfig();
	const url = new URL(`https://graph.facebook.com/${apiVersion}/${path}`);
	const body = new URLSearchParams();

	for (const [key, value] of Object.entries(params)) body.set(key, String(value));

	const response = await fetch(url.toString(), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
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
const META_MAX_CREATION_DAILY_BUDGET_AUD = 500;

async function assertMetaObjectOwnership(
	objectId: string,
	objectType: "campaign" | "adset" | "creative",
) {
	const { adAccountId } = getMetaConfig();
	const configuredAccountId = adAccountId.replace(/^act_/, "");
	const fields =
		objectType === "adset"
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

async function getOwnedMetaLeadForms(pageId: string, limit = 100) {
	await assertOwnedMetaPage(pageId);
	const result = await metaFetch(pageId + "/leadgen_forms", {
		fields: "id,name,status,locale,created_time",
		limit,
	});
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

async function getOwnedMetaVideos(limit = 100) {
	const { adAccountId } = getMetaConfig();
	const result = await metaFetch(adAccountId + "/advideos", {
		fields: "id,title,description,created_time,updated_time,length,picture,status",
		limit,
	});
	return result.data ?? [];
}

async function assertOwnedMetaVideo(videoId: string) {
	const video = (await getOwnedMetaVideos(500)).find((item: any) => String(item.id) === videoId);
	if (!video) {
		throw new Error(
			"Refusing creation: video is not available in the configured Meta ad account.",
		);
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
					mediaItems.map((media) => [
						mediaFilenameKey(media.source_url ?? ""),
						media,
					]),
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
					replacement_filename: z.string().regex(/^[A-Za-z0-9._-]+$/).optional(),
					replacement_mime_type: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
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

				const storedAsJson = typeof meta.value === "string" && /^[{[]/.test(meta.value.trim());
				const parsedValue = storedAsJson ? JSON.parse(meta.value) : structuredClone(meta.value);
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
					!(typeof oldValue === "string" && (/^\d+$/.test(oldValue) || /^https?:/i.test(oldValue)))
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
						throw new Error("The replacement attachment is not a supported WordPress image.");
					}
				} else {
					const bytes = decodeBase64(replacement_base64!);
					if (!bytes.length || bytes.length > 6_000_000) {
						throw new Error("Replacement image must decode to between 1 byte and 6 MB.");
					}
					if (!hasExpectedImageSignature(bytes, replacement_mime_type!)) {
						throw new Error("Replacement bytes do not match the declared image MIME type.");
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
					throw new Error("WooCommerce returned without verifying the new image reference.");
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
					getOwnedMetaVideos(media_limit),
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
					assertOwnedMetaVideo(video_id),
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
						fields: "id,name,campaign_id,adset_id,status,effective_status,creative{id,name,status,object_story_id,thumbnail_url,object_story_spec}",
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
