import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const COMMERCIAL_START_DATE = "2024-07-01";
const GENUINE_ORDER_MIN_TOTAL = 20;
const SEARCH_CONSOLE_SITE_URL = "https://online.blindmotion.com.au/";

const GITHUB_REPO_OWNER = "PhilBarnett";
const GITHUB_REPO_NAME = "remote-mcp-server-authless2";
const GITHUB_REPO_FULL_NAME = `${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}`;
const GITHUB_REPO_ID = 1359135665;
const GITHUB_APP_EXPECTED_ID = "4894554";
const GITHUB_APP_EXPECTED_INSTALLATION_ID = "160530258";
const GITHUB_PATCH_CONFIRMATION = "CONFIRM CREATE BLINDMOTION MCP DRAFT PR";
const GITHUB_PATCHABLE_FILES = new Set(["src/index.ts", "README.md"]);
const GITHUB_MAX_PATCH_FILES = 2;
const GITHUB_MAX_FILE_BYTES = 750_000;

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
const GOOGLE_ADS_ZIPGRIP_ASSET_GROUP_REPAIR_CONFIRMATION = "CONFIRM ENABLE ZIPGRIP ASSET GROUP";
const GOOGLE_ADS_ZIPGRIP_SOURCE_PMAX_ID = "22733226130";
const GOOGLE_ADS_ZIPGRIP_SOURCE_SHOPPING_IDS = ["22732181006", "21527804393"] as const;
const GOOGLE_ADS_AUSTRALIA_GEO_TARGET_ID = "2036";
const GOOGLE_ADS_ENGLISH_LANGUAGE_ID = "1000";

// Reusable product-level Performance Max workflow. The Blindmotion account and
// Merchant Center remain fixed, but product/campaign identities are validated
// at runtime so a new product does not require another hard-coded tool family.
const GOOGLE_ADS_PRODUCT_PMAX_CUSTOMER_ID = "6610097637";
const GOOGLE_ADS_PRODUCT_PMAX_MERCHANT_ID = "5320593492";
const GOOGLE_ADS_PRODUCT_PMAX_FEED_LABEL = "AU";
const GOOGLE_ADS_PRODUCT_PMAX_CREATE_CONFIRMATION = "CONFIRM CREATE PAUSED PRODUCT PMAX";
const GOOGLE_ADS_PRODUCT_PMAX_BOOTSTRAP_CONFIRMATION = "CONFIRM BOOTSTRAP PAUSED PRODUCT PMAX";
const GOOGLE_ADS_PRODUCT_PMAX_VIDEO_CONFIRMATION = "CONFIRM LINK PAUSED PRODUCT PMAX VIDEOS";

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

async function wpAuthenticatedFetch(path: string) {
	const workerEnv = env as unknown as Record<string, string>;
	const url = new URL(`${workerEnv.WC_SITE}/wp-json/wp/v2/${path}`);
	const response = await fetch(url.toString(), {
		headers: {
			Authorization: getWpWriteAuthHeader(),
			Accept: "application/json",
		},
	});
	if (!response.ok) {
		throw new Error(
			`Authenticated WordPress read failed: ${response.status} ${await response.text()}`,
		);
	}
	return response;
}

async function wpAuthenticatedWrite(path: string, body: unknown) {
	const workerEnv = env as unknown as Record<string, string>;
	const url = new URL(`${workerEnv.WC_SITE}/wp-json/wp/v2/${path}`);
	const response = await fetch(url.toString(), {
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
			`Authenticated WordPress write failed: ${response.status} ${await response.text()}`,
		);
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
const FABRIC_SAMPLE_SETUP_CONFIRMATION = "CONFIRM APPLY FABRIC SAMPLE SETUP";
function parseWapfFieldGroup(value: unknown) {
	if (value && typeof value === "object") return value as Record<string, any>;
	if (typeof value !== "string" || value.trim() === "") return null;
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, any>) : null;
	} catch {
		return null;
	}
}

function wapfFieldLabel(field: any) {
	return String(
		field?.label ?? field?.title ?? field?.name ?? field?.options?.label ?? "",
	).trim();
}

function wapfFieldSummary(field: any, index: number) {
	return {
		index,
		id: field?.id ?? field?.key ?? null,
		label: wapfFieldLabel(field),
		type: field?.type ?? null,
		required: field?.required ?? field?.options?.required ?? null,
		pricing: field?.pricing ?? null,
		choices: Array.isArray(field?.options?.choices)
			? field.options.choices.map((choice: any, choiceIndex: number) => ({
					index: choiceIndex,
					label: choice?.label ?? choice?.name ?? null,
					slug: choice?.slug ?? null,
					pricing_type: choice?.pricing_type ?? null,
					pricing_amount: choice?.pricing_amount ?? null,
					image: choice?.image ?? null,
					attachment: choice?.attachment ?? null,
					options: choice?.options ?? null,
				}))
			: [],
		condition_data: field?.conditionals ?? field?.conditions ?? field?.rules ?? null,
	};
}

function singleWapfFieldGroup(product: any) {
	const matches = (product.meta_data ?? []).filter(
		(meta: any) => String(meta.key) === "_wapf_fieldgroup",
	);
	if (matches.length !== 1) {
		throw new Error(
			`Expected exactly one WAPF field group on product ${product.id}; found ${matches.length}.`,
		);
	}
	const group = parseWapfFieldGroup(matches[0].value);
	if (!group || !Array.isArray(group.fields)) {
		throw new Error(`Product ${product.id} WAPF field group is not readable.`);
	}
	return { meta: matches[0], group };
}

function wapfConditionalRules(field: any) {
	const conditionals = field?.conditionals;
	if (!Array.isArray(conditionals)) return [];
	return conditionals.flatMap((group: any) => (Array.isArray(group?.rules) ? group.rules : []));
}

function clearWapfPricing(value: any) {
	if (value && typeof value === "object") {
		value.pricing_type = "none";
		value.pricing_amount = 0;
	}
}

async function deterministicWapfToken(
	prefix: string,
	destinationProductId: number,
	sourceProductId: number,
	sourceToken: string,
	length: number,
) {
	const digest = await sha256Hex(
		new TextEncoder().encode(
			`${prefix}:${destinationProductId}:${sourceProductId}:${sourceToken}`,
		),
	);
	return digest.slice(0, length);
}

type FabricSamplePlanInput = {
	sourceProductId: number;
	destinationProductId: number;
	sourceFabricSelectorFieldId: string;
	destinationProductSelectorFieldId: string;
	destinationColourTemplateFieldId: string;
	sampleProductLabel: string;
};

async function buildFabricSamplePlan(source: any, destination: any, input: FabricSamplePlanInput) {
	const sourceWapf = singleWapfFieldGroup(source);
	const destinationWapf = singleWapfFieldGroup(destination);
	const sourceFields = sourceWapf.group.fields as any[];
	const destinationFields = destinationWapf.group.fields as any[];
	const sourceSelector = sourceFields.find(
		(field) => String(field?.id) === input.sourceFabricSelectorFieldId,
	);
	if (!sourceSelector) {
		throw new Error("The exact source fabric selector field was not found.");
	}
	const sourceChoices = sourceSelector?.options?.choices;
	if (!Array.isArray(sourceChoices) || sourceChoices.length < 1 || sourceChoices.length > 30) {
		throw new Error("The source fabric selector must contain between 1 and 30 choices.");
	}
	const sourceChoiceSlugs = sourceChoices.map((choice: any) => String(choice?.slug ?? ""));
	if (
		sourceChoiceSlugs.some((slug: string) => !/^[A-Za-z0-9_-]{1,80}$/.test(slug)) ||
		new Set(sourceChoiceSlugs).size !== sourceChoiceSlugs.length
	) {
		throw new Error("The source fabric selector has missing or duplicate choice slugs.");
	}

	const dependentFields = sourceFields.filter((field) => {
		const rules = wapfConditionalRules(field);
		return rules.some((rule: any) => String(rule?.field) === input.sourceFabricSelectorFieldId);
	});
	if (dependentFields.length !== sourceChoices.length) {
		throw new Error(
			`Expected one colour field per source fabric choice; found ${dependentFields.length} colour fields for ${sourceChoices.length} choices.`,
		);
	}
	const dependentChoiceSlugs: string[] = [];
	for (const field of dependentFields) {
		const rules = wapfConditionalRules(field);
		if (
			rules.length !== 1 ||
			String(rules[0]?.field) !== input.sourceFabricSelectorFieldId ||
			rules[0]?.condition !== "==" ||
			!sourceChoiceSlugs.includes(String(rules[0]?.value ?? ""))
		) {
			throw new Error(
				`Source colour field ${field?.id ?? "unknown"} has an unsupported conditional dependency.`,
			);
		}
		const choices = field?.options?.choices;
		if (!Array.isArray(choices) || choices.length < 1 || choices.length > 100) {
			throw new Error(
				`Source colour field ${field?.id ?? "unknown"} must contain between 1 and 100 choices.`,
			);
		}
		dependentChoiceSlugs.push(String(rules[0].value));
	}
	if (
		new Set(dependentChoiceSlugs).size !== sourceChoiceSlugs.length ||
		sourceChoiceSlugs.some((slug: string) => !dependentChoiceSlugs.includes(slug))
	) {
		throw new Error("Source fabric choices do not map one-to-one to colour fields.");
	}

	const destinationProductSelector = destinationFields.find(
		(field) => String(field?.id) === input.destinationProductSelectorFieldId,
	);
	const destinationProductChoices = destinationProductSelector?.options?.choices;
	if (!destinationProductSelector || !Array.isArray(destinationProductChoices)) {
		throw new Error("The exact destination product selector field was not found.");
	}
	if (destinationProductChoices.length < 1 || destinationProductChoices.length >= 30) {
		throw new Error("The destination product selector cannot accept another product choice.");
	}
	if (
		destinationProductChoices.some(
			(choice: any) =>
				String(choice?.label ?? "")
					.trim()
					.toLowerCase() === input.sampleProductLabel.trim().toLowerCase(),
		)
	) {
		throw new Error("The destination already contains this sample-product label.");
	}
	const destinationColourTemplate = destinationFields.find(
		(field) => String(field?.id) === input.destinationColourTemplateFieldId,
	);
	if (
		!destinationColourTemplate ||
		destinationColourTemplate.type !== "multi-image-swatch" ||
		!Array.isArray(destinationColourTemplate?.options?.choices)
	) {
		throw new Error(
			"The exact destination colour template must be a multi-image-swatch field.",
		);
	}
	if (!source?.images?.[0]?.id || typeof source.images[0]?.src !== "string") {
		throw new Error("The source product requires a featured image for its sample choice.");
	}

	const occupiedFieldIds = new Set(destinationFields.map((field) => String(field?.id ?? "")));
	const occupiedChoiceSlugs = new Set(
		destinationFields.flatMap((field) =>
			Array.isArray(field?.options?.choices)
				? field.options.choices.map((choice: any) => String(choice?.slug ?? ""))
				: [],
		),
	);
	const newProductChoiceSlug = await deterministicWapfToken(
		"sample-product-choice",
		input.destinationProductId,
		input.sourceProductId,
		String(source.id),
		5,
	);
	if (occupiedChoiceSlugs.has(newProductChoiceSlug)) {
		throw new Error(
			"The deterministic sample-product choice slug conflicts with the destination.",
		);
	}
	const plannedChoiceSlugs = new Set([newProductChoiceSlug]);

	const newProductChoice = structuredClone(destinationProductChoices[0]);
	newProductChoice.label = input.sampleProductLabel.trim();
	newProductChoice.slug = newProductChoiceSlug;
	newProductChoice.image = source.images[0].src;
	newProductChoice.attachment = Number(source.images[0].id);
	newProductChoice.selected = false;
	clearWapfPricing(newProductChoice);

	const newSelector = structuredClone(sourceSelector);
	newSelector.id = await deterministicWapfToken(
		"sample-fabric-field",
		input.destinationProductId,
		input.sourceProductId,
		String(sourceSelector.id),
		13,
	);
	if (occupiedFieldIds.has(String(newSelector.id))) {
		throw new Error(
			"The deterministic fabric-selector field ID conflicts with the destination.",
		);
	}
	newSelector.conditionals = [
		{
			rules: [
				{
					condition: "==",
					value: newProductChoiceSlug,
					field: String(destinationProductSelector.id),
					generated: false,
				},
			],
		},
	];
	newSelector.pricing = { type: "fixed", amount: 0, enabled: false };

	const sourceToNewChoiceSlug = new Map<string, string>();
	for (const choice of newSelector.options.choices) {
		const oldSlug = String(choice.slug);
		const newSlug = await deterministicWapfToken(
			"sample-fabric-choice",
			input.destinationProductId,
			input.sourceProductId,
			`${sourceSelector.id}:${oldSlug}`,
			5,
		);
		if (occupiedChoiceSlugs.has(newSlug) || plannedChoiceSlugs.has(newSlug)) {
			throw new Error("A deterministic fabric-choice slug conflicts with the destination.");
		}
		sourceToNewChoiceSlug.set(oldSlug, newSlug);
		plannedChoiceSlugs.add(newSlug);
		choice.slug = newSlug;
		choice.selected = false;
		clearWapfPricing(choice);
	}

	const newColourFields: any[] = [];
	for (const sourceColourField of dependentFields) {
		const rule = wapfConditionalRules(sourceColourField)[0];
		const newColourField = structuredClone(destinationColourTemplate);
		newColourField.id = await deterministicWapfToken(
			"sample-colour-field",
			input.destinationProductId,
			input.sourceProductId,
			String(sourceColourField.id),
			13,
		);
		if (
			occupiedFieldIds.has(String(newColourField.id)) ||
			String(newColourField.id) === String(newSelector.id) ||
			newColourFields.some((field) => String(field.id) === String(newColourField.id))
		) {
			throw new Error("A deterministic colour-field ID conflicts with the destination.");
		}
		newColourField.label = sourceColourField.label;
		newColourField.description = sourceColourField.description ?? "";
		newColourField.required = sourceColourField.required !== false;
		newColourField.options.choices = structuredClone(sourceColourField.options.choices);
		newColourField.conditionals = [
			{
				rules: [
					{
						condition: "==",
						value: sourceToNewChoiceSlug.get(String(rule.value)),
						field: String(newSelector.id),
						generated: false,
					},
				],
			},
		];
		newColourField.pricing = { type: "fixed", amount: 0, enabled: false };
		for (const colourChoice of newColourField.options.choices) {
			const oldSlug = String(colourChoice?.slug ?? "");
			if (!/^[A-Za-z0-9_-]{1,80}$/.test(oldSlug)) {
				throw new Error(
					`Source colour field ${sourceColourField.id} has an invalid choice slug.`,
				);
			}
			const newSlug = await deterministicWapfToken(
				"sample-colour-choice",
				input.destinationProductId,
				input.sourceProductId,
				`${sourceColourField.id}:${oldSlug}`,
				5,
			);
			if (occupiedChoiceSlugs.has(newSlug) || plannedChoiceSlugs.has(newSlug)) {
				throw new Error(
					"A deterministic colour-choice slug conflicts with the destination.",
				);
			}
			plannedChoiceSlugs.add(newSlug);
			colourChoice.slug = newSlug;
			colourChoice.selected = false;
			clearWapfPricing(colourChoice);
		}
		newColourFields.push(newColourField);
	}

	const updatedGroup = structuredClone(destinationWapf.group);
	const updatedProductSelector = updatedGroup.fields.find(
		(field: any) => String(field?.id) === input.destinationProductSelectorFieldId,
	);
	updatedProductSelector.options.choices.push(newProductChoice);
	updatedGroup.fields.push(newSelector, ...newColourFields);
	const [sourceHash, destinationHash, planHash] = await Promise.all([
		sha256Hex(new TextEncoder().encode(JSON.stringify(sourceWapf.meta.value))),
		sha256Hex(new TextEncoder().encode(JSON.stringify(destinationWapf.meta.value))),
		sha256Hex(new TextEncoder().encode(JSON.stringify(updatedGroup))),
	]);
	return {
		sourceWapf,
		destinationWapf,
		updatedGroup,
		sourceHash,
		destinationHash,
		planHash,
		newProductChoice,
		newSelector,
		newColourFields,
	};
}

const VISUALIZER_PLUGIN_CONFIRMATION = "CONFIRM INSTALL BLINDMOTION VISUALIZER";
const VISUALIZER_PLUGIN_SLUG = "blindmotion-visualizer";
const VISUALIZER_PLUGIN_MAIN_FILE = "blindmotion-visualizer/blindmotion-visualizer.php";

function decodeBasicHtmlEntities(value: string) {
	return value
		.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#0?39;|&apos;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">");
}

function htmlToPlainText(value: string) {
	return decodeBasicHtmlEntities(
		value
			.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
			.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
			.replace(/<[^>]+>/g, " "),
	)
		.replace(/\s+/g, " ")
		.trim();
}

function parseElementorData(value: unknown) {
	if (Array.isArray(value)) return value;
	if (typeof value !== "string" || value.trim() === "") return null;
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function elementorLiteralSettingMatches(nodes: any[], searchTerms: string[]) {
	const terms = searchTerms.map((term) => term.trim().toLowerCase()).filter(Boolean);
	const matches: any[] = [];
	function relevantSettings(settings: unknown) {
		if (!settings || typeof settings !== "object") return {};
		return Object.fromEntries(
			Object.entries(settings as Record<string, unknown>).filter(([key]) =>
				/(?:background|image|dce_|visibility|hide_|display|condition|css_classes)/i.test(key),
			),
		);
	}
	function visit(node: any, ancestors: any[] = []) {
		if (!node || typeof node !== "object") return;
		const settings = node.settings && typeof node.settings === "object" ? node.settings : {};
		const matchedSettings = Object.entries(settings)
			.map(([key, value]) => {
				const serialized =
					typeof value === "string" ? value : JSON.stringify(value ?? null);
				const normalized = serialized.toLowerCase();
				const matchedTerms = terms.filter((term) => normalized.includes(term));
				return { key, value, serialized, matchedTerms };
			})
			.filter(({ matchedTerms }) => matchedTerms.length > 0)
			.map(({ key, value, serialized, matchedTerms }) => ({
				key,
				matched_terms: matchedTerms,
				value_preview:
					typeof value === "string"
						? htmlToPlainText(value).slice(0, 4000)
						: serialized.slice(0, 4000),
				value_length: serialized.length,
			}));
		if (matchedSettings.length > 0) {
			matches.push({
				id: node.id ?? null,
				el_type: node.elType ?? null,
				widget_type: node.widgetType ?? null,
				matched_settings: matchedSettings,
				relevant_settings: relevantSettings(settings),
				ancestor_path: ancestors.map((ancestor) => ({
					id: ancestor.id ?? null,
					el_type: ancestor.elType ?? null,
					widget_type: ancestor.widgetType ?? null,
					relevant_settings: relevantSettings(ancestor.settings),
				})),
			});
		}
		for (const child of Array.isArray(node.elements) ? node.elements : []) {
			visit(child, [...ancestors, node]);
		}
	}
	for (const node of nodes) visit(node);
	return matches;
}

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

const FABRIC_COLLECTION_IMPORT_CONFIRMATION = "CONFIRM IMPORT FABRIC COLLECTION";

type FabricSwatch = {
	colour: string;
	variant?: string;
	image_url: string;
	source_page_url: string;
	filename: string;
	title: string;
	alt_text: string;
	warnings?: string[];
};

function decodeHtmlText(value: string) {
	return value
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&nbsp;/gi, " ")
		.replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
		.replace(/\s+/g, " ")
		.trim();
}

function htmlAttribute(fragment: string, name: string) {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = fragment.match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])(.*?)\\1`, "is"));
	return match ? decodeHtmlText(match[2]) : "";
}

function safeSlug(value: string) {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 120);
}

function assertPublicHttpsUrl(value: string) {
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password) {
		throw new Error("Fabric source URLs must be credential-free HTTPS URLs.");
	}
	const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
	if (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		hostname.startsWith("127.") ||
		hostname.startsWith("10.") ||
		hostname.startsWith("192.168.") ||
		hostname.startsWith("169.254.") ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
		hostname === "::1" ||
		hostname === "[::1]" ||
		/^\[?(?:fc|fd|fe[89ab])[0-9a-f]{2}:/i.test(hostname) ||
		/^\[?::ffff:(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(
			hostname,
		) ||
		hostname === "0.0.0.0"
	) {
		throw new Error("Private or local fabric source URLs are not permitted.");
	}
	return url;
}

async function fetchPublicResource(value: string, accept: string) {
	let url = assertPublicHttpsUrl(value);
	for (let redirects = 0; redirects <= 4; redirects++) {
		const response = await fetch(url.toString(), {
			headers: { Accept: accept, "User-Agent": "Blindmotion-Fabric-Importer/1.0" },
			redirect: "manual",
		});
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) throw new Error(`Redirect without a location from ${url.hostname}.`);
			url = assertPublicHttpsUrl(new URL(location, url).toString());
			continue;
		}
		if (!response.ok) {
			throw new Error(`Fabric source request failed: ${response.status} ${url.hostname}`);
		}
		return { response, finalUrl: url };
	}
	throw new Error("Fabric source exceeded the redirect limit.");
}

function absoluteSourceUrl(value: string, base: string) {
	return assertPublicHttpsUrl(new URL(value.replace(/^\/\//, "https://"), base).toString()).toString();
}

function fabricSwatchRecord(
	supplier: string,
	collection: string,
	colour: string,
	variant: string | undefined,
	imageUrl: string,
	sourcePageUrl: string,
): FabricSwatch {
	const identity = [supplier, collection, variant, colour].filter(
		(value): value is string => Boolean(value),
	);
	const extensionMatch = new URL(imageUrl).pathname.match(/\.(jpe?g|png|webp)$/i);
	const extension = extensionMatch?.[1]?.toLowerCase().replace("jpeg", "jpg") ?? "jpg";
	const filename = `${identity.map(safeSlug).filter(Boolean).join("-")}.${extension}`;
	return {
		colour,
		...(variant ? { variant } : {}),
		image_url: imageUrl,
		source_page_url: sourcePageUrl,
		filename,
		title: [collection, variant, colour].filter(Boolean).join(" – "),
		alt_text: [collection, variant, colour, "fabric swatch"].filter(Boolean).join(" "),
	};
}

async function extractLinkedPageSwatches(
	html: string,
	collectionUrl: string,
	supplier: string,
	collection: string,
	maxItems: number,
) {
	const links = new Map<string, string>();
	for (const match of html.matchAll(/<h2\b[^>]*class=["'][^"']*product-name[^"']*["'][^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/gi)) {
		const href = htmlAttribute(match[1], "href");
		const label = decodeHtmlText(match[2]);
		if (href && label) links.set(absoluteSourceUrl(href, collectionUrl), label);
	}
	if (!links.size) {
		for (const match of html.matchAll(/<a\b([^>]*)class=["'][^"']*product-image[^"']*["'][^>]*>/gi)) {
			const href = htmlAttribute(match[1], "href");
			const label = htmlAttribute(match[1], "title");
			if (href && label) links.set(absoluteSourceUrl(href, collectionUrl), label);
		}
	}
	if (!links.size) throw new Error("No linked fabric product pages were discovered.");
	if (links.size > maxItems) throw new Error(`Discovered ${links.size} items, above max_items ${maxItems}.`);

	const records = await Promise.all(
		[...links.entries()].map(async ([pageUrl, listingLabel]) => {
			const { response, finalUrl } = await fetchPublicResource(pageUrl, "text/html");
			const pageHtml = await response.text();
			const heading = decodeHtmlText(pageHtml.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? listingLabel);
			const zoom = pageHtml.match(/<a\b([^>]*)>\s*(?:<[^>]+>\s*)*Zoom(?:\s*<[^>]+>)*\s*<\/a>/i);
			let image = zoom ? htmlAttribute(zoom[1], "href") : "";
			if (!image) {
				const og = pageHtml.match(/<meta\b([^>]*(?:property|name)=["']og:image["'][^>]*)>/i);
				image = og ? htmlAttribute(og[1], "content") : "";
			}
			if (!image) throw new Error(`No full-size image found for ${heading}.`);
			const colour = heading
				.replace(new RegExp(`^${collection.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i"), "")
				.replace(/\s+(?:sheer|privacy|blockout|light\s*filter(?:ing)?)\b.*$/i, "")
				.trim();
			return fabricSwatchRecord(
				supplier,
				collection,
				colour || heading,
				undefined,
				absoluteSourceUrl(image, finalUrl.toString()),
				finalUrl.toString(),
			);
		}),
	);
	return records;
}

function extractSectionedAttributeSwatches(
	html: string,
	collectionUrl: string,
	supplier: string,
	collection: string,
	maxItems: number,
) {
	const records: FabricSwatch[] = [];
	const sectionPattern = /<h3\b[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3\b|<section\b[^>]*id=["']specifications|<div\b[^>]*id=["']specifications|$)/gi;
	for (const section of html.matchAll(sectionPattern)) {
		const variant = decodeHtmlText(section[1]);
		for (const card of section[2].matchAll(/<article\b([^>]*)>/gi)) {
			if (!/(?:^|\s)swatch(?:\s|$)/i.test(htmlAttribute(card[1], "class"))) continue;
			const colour = htmlAttribute(card[1], "data-swatch-title");
			const image = htmlAttribute(card[1], "data-swatch-image") || htmlAttribute(card[1], "data-swatch-thumbnail");
			if (!colour || !image) continue;
			const record = fabricSwatchRecord(
					supplier,
					collection,
					colour,
					variant,
					absoluteSourceUrl(image, collectionUrl),
					collectionUrl,
				);
			const variantToken = safeSlug(variant);
			if (variantToken && !safeSlug(new URL(record.image_url).pathname).includes(variantToken)) {
				record.warnings = [
					`Source image filename does not contain the section variant ${variant}; review before import.`,
				];
			}
			records.push(record);
		}
	}
	if (!records.length) throw new Error("No sectioned attribute swatches were discovered.");
	if (records.length > maxItems) throw new Error(`Discovered ${records.length} items, above max_items ${maxItems}.`);
	return records;
}

async function buildFabricCollectionManifest(input: {
	sourceUrl: string;
	supplier: string;
	collection: string;
	extractionStrategy: "linked_product_pages" | "sectioned_attribute_swatches";
	maxItems: number;
}) {
	const { response, finalUrl } = await fetchPublicResource(input.sourceUrl, "text/html");
	const html = await response.text();
	if (html.length > 4_000_000) throw new Error("Fabric collection HTML exceeds 4 MB.");
	const items =
		input.extractionStrategy === "linked_product_pages"
			? await extractLinkedPageSwatches(
					html,
					finalUrl.toString(),
					input.supplier,
					input.collection,
					input.maxItems,
				)
			: extractSectionedAttributeSwatches(
					html,
					finalUrl.toString(),
					input.supplier,
					input.collection,
					input.maxItems,
				);
	const identities = new Set<string>();
	const warnings: string[] = [];
	const imageUses = new Map<string, string[]>();
	for (const item of items) {
		const identity = `${item.variant ?? ""}|${item.colour}`.toLowerCase();
		if (identities.has(identity)) throw new Error(`Duplicate swatch identity discovered: ${identity}`);
		identities.add(identity);
		for (const warning of item.warnings ?? []) warnings.push(`${item.title}: ${warning}`);
		const uses = imageUses.get(item.image_url) ?? [];
		uses.push(item.title);
		imageUses.set(item.image_url, uses);
	}
	for (const [imageUrl, uses] of imageUses) {
		if (uses.length > 1) {
			warnings.push(`One source image is reused by multiple swatches (${uses.join(", ")}): ${imageUrl}`);
		}
	}
	const manifestCore = {
		source_url: finalUrl.toString(),
		supplier: input.supplier,
		collection: input.collection,
		extraction_strategy: input.extractionStrategy,
		warnings,
		items,
	};
	const manifestHash = await sha256Hex(new TextEncoder().encode(JSON.stringify(manifestCore)));
	return { ...manifestCore, manifest_hash: manifestHash };
}

function fabricSwatchItemKey(item: FabricSwatch) {
	const variant = safeSlug(item.variant ?? "collection");
	const colour = safeSlug(item.colour);
	if (!variant || !colour) throw new Error("Fabric swatch identity cannot produce a stable item key.");
	return `${variant}--${colour}`;
}

function selectFabricSwatches(
	items: FabricSwatch[],
	includeItemKeys: string[] = [],
	excludeItemKeys: string[] = [],
) {
	const keyed = items.map((item) => ({ item, item_key: fabricSwatchItemKey(item) }));
	const available = new Map<string, FabricSwatch>();
	for (const entry of keyed) {
		if (available.has(entry.item_key)) {
			throw new Error(`Multiple fabric swatches produce item key ${entry.item_key}.`);
		}
		available.set(entry.item_key, entry.item);
	}
	const includes = new Set(includeItemKeys);
	const excludes = new Set(excludeItemKeys);
	for (const key of includes) {
		if (!available.has(key)) throw new Error(`Included item key is not in the reviewed manifest: ${key}`);
		if (excludes.has(key)) throw new Error(`Item key cannot be both included and excluded: ${key}`);
	}
	for (const key of excludes) {
		if (!available.has(key)) throw new Error(`Excluded item key is not in the reviewed manifest: ${key}`);
	}
	const selected = keyed.filter(
		(entry) => (!includes.size || includes.has(entry.item_key)) && !excludes.has(entry.item_key),
	);
	if (!selected.length) throw new Error("Item selection removed every fabric swatch.");
	return selected;
}

async function inspectFabricAttachments(items: Array<{ item: FabricSwatch; item_key: string }>) {
	const results: any[] = [];
	for (const { item, item_key } of items) {
		const attachmentSlug = safeSlug(item.filename.replace(/\.[^.]+$/, ""));
		const response = await wpAuthenticatedFetch(
			`media?slug=${encodeURIComponent(attachmentSlug)}&per_page=100&context=edit`,
		);
		const existing = await response.json<any[]>();
		if (existing.length > 1) {
			throw new Error(`Multiple existing attachments have slug ${attachmentSlug}; stopped safely.`);
		}
		results.push({
			item_key,
			colour: item.colour,
			variant: item.variant ?? null,
			status: existing.length === 1 ? "present" : "missing",
			attachment: existing.length === 1 ? mediaMetadata(existing[0]) : null,
		});
	}
	return results;
}

async function findOrCreateMediaFolder(name: string, parent: number) {
	const slug = safeSlug(name);
	const existingResponse = await wpAuthenticatedFetch(
		`media_folder?slug=${encodeURIComponent(slug)}&parent=${parent}&per_page=100&context=edit`,
	);
	const existing = await existingResponse.json<any[]>();
	const exact = existing.find((term) => term.slug === slug && Number(term.parent ?? 0) === parent);
	if (exact) return { term: exact, created: false };
	const createdResponse = await wpAuthenticatedWrite("media_folder", { name, slug, parent });
	return { term: await createdResponse.json<any>(), created: true };
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
const META_REFRESH_SPRING_OFFER_REASON = "PROMOTE 20.5 PERCENT OFFER";
const META_LEAD_AD_LINK = "https://fb.me/";
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

type SearchConsoleDimension = "date" | "page" | "query";

type SearchConsoleQueryRequest = {
	startDate: string;
	endDate: string;
	dimensions?: SearchConsoleDimension[];
	rowLimit?: number;
	startRow?: number;
	type?: "web";
	aggregationType?: "auto";
	dimensionFilterGroups?: Array<{
		groupType: "and";
		filters: Array<{
			dimension: "page" | "query";
			operator: "contains";
			expression: string;
		}>;
	}>;
};

let searchConsoleAccessTokenCache: { token: string; expiresAt: number } | undefined;

function getSearchConsoleConfig() {
	const { serviceAccount } = getGa4Config();
	return { siteUrl: SEARCH_CONSOLE_SITE_URL, serviceAccount };
}

async function getSearchConsoleAccessToken() {
	if (
		searchConsoleAccessTokenCache &&
		searchConsoleAccessTokenCache.expiresAt > Date.now() + 60_000
	) {
		return searchConsoleAccessTokenCache.token;
	}

	const { serviceAccount } = getSearchConsoleConfig();
	const now = Math.floor(Date.now() / 1000);
	const tokenUri = serviceAccount.token_uri ?? "https://oauth2.googleapis.com/token";
	const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const claims = base64UrlEncode(
		JSON.stringify({
			iss: serviceAccount.client_email,
			scope: "https://www.googleapis.com/auth/webmasters.readonly",
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
			`Google Search Console OAuth request failed: ${response.status} ${await response.text()}`,
		);
	}

	const tokenResponse = await response.json<{ access_token: string; expires_in?: number }>();
	searchConsoleAccessTokenCache = {
		token: tokenResponse.access_token,
		expiresAt: Date.now() + (tokenResponse.expires_in ?? 3600) * 1000,
	};
	return tokenResponse.access_token;
}

async function searchConsoleFetch(path = "", init?: RequestInit) {
	const { siteUrl } = getSearchConsoleConfig();
	const accessToken = await getSearchConsoleAccessToken();
	const response = await fetch(
		`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}${path}`,
		{
			...init,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/json",
				...(init?.body ? { "Content-Type": "application/json" } : {}),
				...init?.headers,
			},
		},
	);

	if (!response.ok) {
		throw new Error(
			`Google Search Console API request failed: ${response.status} ${await response.text()}`,
		);
	}

	return response.json<any>();
}

async function searchConsoleQuery(request: SearchConsoleQueryRequest) {
	return searchConsoleFetch("/searchAnalytics/query", {
		method: "POST",
		body: JSON.stringify({
			...request,
			type: "web",
			aggregationType: "auto",
		}),
	});
}

function searchConsoleFilters(queryFilter?: string, pageFilter?: string) {
	const filters: Array<{
		dimension: "page" | "query";
		operator: "contains";
		expression: string;
	}> = [];
	if (queryFilter)
		filters.push({ dimension: "query", operator: "contains", expression: queryFilter });
	if (pageFilter)
		filters.push({ dimension: "page", operator: "contains", expression: pageFilter });
	return filters.length ? [{ groupType: "and" as const, filters }] : undefined;
}

function assertSearchConsoleDateRange(startDate: string, endDate: string) {
	if (startDate > endDate) {
		throw new Error("start_date must be on or before end_date.");
	}
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

async function getZipGripAssetState(requirePaused = true) {
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
		(requirePaused && campaign?.status !== "PAUSED") ||
		campaign?.advertisingChannelType !== "PERFORMANCE_MAX" ||
		String(assetGroup?.id) !== GOOGLE_ADS_ZIPGRIP_ASSET_GROUP_ID ||
		(requirePaused && assetGroup?.status !== "PAUSED")
	) {
		throw new Error(
			requirePaused
				? "Refusing asset access: the locked campaign and asset group are not the expected PAUSED ZipGrip resources."
				: "Refusing post-launch access: the locked campaign or asset group identity is invalid.",
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

function summarizeZipGripPmaxTree(rows: any[]) {
	return rows.map((row) => ({
		campaign_id: String(row.campaign?.id ?? ""),
		campaign_name: row.campaign?.name ?? null,
		campaign_status: row.campaign?.status ?? null,
		asset_group_id: String(row.assetGroup?.id ?? ""),
		asset_group_name: row.assetGroup?.name ?? null,
		asset_group_status: row.assetGroup?.status ?? null,
		filter_id: String(row.assetGroupListingGroupFilter?.id ?? ""),
		resource_name: row.assetGroupListingGroupFilter?.resourceName ?? null,
		parent_resource_name: row.assetGroupListingGroupFilter?.parentListingGroupFilter ?? null,
		type: row.assetGroupListingGroupFilter?.type ?? null,
		listing_source: row.assetGroupListingGroupFilter?.listingSource ?? null,
		case_value: row.assetGroupListingGroupFilter?.caseValue ?? null,
		path: row.assetGroupListingGroupFilter?.path ?? null,
		product_brand: row.assetGroupListingGroupFilter?.caseValue?.productBrand?.value ?? null,
		product_category_id:
			row.assetGroupListingGroupFilter?.caseValue?.productCategory?.categoryId ?? null,
		product_category_level:
			row.assetGroupListingGroupFilter?.caseValue?.productCategory?.level ?? null,
		product_channel:
			row.assetGroupListingGroupFilter?.caseValue?.productChannel?.channel ?? null,
		product_condition:
			row.assetGroupListingGroupFilter?.caseValue?.productCondition?.condition ?? null,
		product_custom_attribute_index:
			row.assetGroupListingGroupFilter?.caseValue?.productCustomAttribute?.index ?? null,
		product_custom_attribute_value:
			row.assetGroupListingGroupFilter?.caseValue?.productCustomAttribute?.value ?? null,
		product_item_id: row.assetGroupListingGroupFilter?.caseValue?.productItemId?.value ?? null,
		product_type_level: row.assetGroupListingGroupFilter?.caseValue?.productType?.level ?? null,
		product_type_value: row.assetGroupListingGroupFilter?.caseValue?.productType?.value ?? null,
		is_root: !row.assetGroupListingGroupFilter?.parentListingGroupFilter,
	}));
}

function summarizeZipGripShoppingTree(rows: any[]) {
	return rows.map((row) => ({
		campaign_id: String(row.campaign?.id ?? ""),
		campaign_name: row.campaign?.name ?? null,
		campaign_status: row.campaign?.status ?? null,
		ad_group_id: String(row.adGroup?.id ?? ""),
		ad_group_name: row.adGroup?.name ?? null,
		ad_group_status: row.adGroup?.status ?? null,
		criterion_id: String(row.adGroupCriterion?.criterionId ?? ""),
		resource_name: row.adGroupCriterion?.resourceName ?? null,
		parent_resource_name: row.adGroupCriterion?.listingGroup?.parentAdGroupCriterion ?? null,
		type: row.adGroupCriterion?.listingGroup?.type ?? null,
		status: row.adGroupCriterion?.status ?? null,
		negative: Boolean(row.adGroupCriterion?.negative),
		cpc_bid_micros: row.adGroupCriterion?.cpcBidMicros ?? null,
		product_item_id:
			row.adGroupCriterion?.listingGroup?.caseValue?.productItemId?.value ?? null,
		is_root: !row.adGroupCriterion?.listingGroup?.parentAdGroupCriterion,
	}));
}

function zipGripLaunchTreeError(message: string, pmaxRows: any[], shoppingRows: any[]) {
	return Object.assign(new Error(message), {
		zipGripLaunchDiagnostics: {
			source_pmax_listing_tree: summarizeZipGripPmaxTree(pmaxRows),
			source_shopping_listing_trees: summarizeZipGripShoppingTree(shoppingRows),
		},
	});
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
			asset_group_listing_group_filter.case_value.product_brand.value,
			asset_group_listing_group_filter.case_value.product_category.category_id,
			asset_group_listing_group_filter.case_value.product_category.level,
			asset_group_listing_group_filter.case_value.product_channel.channel,
			asset_group_listing_group_filter.case_value.product_condition.condition,
			asset_group_listing_group_filter.case_value.product_custom_attribute.index,
			asset_group_listing_group_filter.case_value.product_custom_attribute.value,
			asset_group_listing_group_filter.case_value.product_item_id.value,
			asset_group_listing_group_filter.case_value.product_type.level,
			asset_group_listing_group_filter.case_value.product_type.value,
			asset_group_listing_group_filter.path
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

	const pmaxZipGripRows = sourcePmaxFilters.filter(
		(row) =>
			row.assetGroupListingGroupFilter?.caseValue?.productItemId?.value ===
			GOOGLE_ADS_ZIPGRIP_ITEM_ID,
	);
	if (pmaxZipGripRows.length > 1) {
		throw zipGripLaunchTreeError(
			"Refusing launch: BM Online PMax 1 contains more than one explicit gla_1301 item node.",
			sourcePmaxFilters,
			sourceShoppingCriteria,
		);
	}
	if (pmaxZipGripRows.length === 1) {
		const row = pmaxZipGripRows[0];
		const filter = row.assetGroupListingGroupFilter;
		if (
			filter?.type !== "UNIT_INCLUDED" ||
			!filter.parentListingGroupFilter ||
			!filter.resourceName
		) {
			throw zipGripLaunchTreeError(
				"Refusing launch: the explicit PMax gla_1301 node is not an included child unit.",
				sourcePmaxFilters,
				sourceShoppingCriteria,
			);
		}
		const assetGroupId = String(row.assetGroup?.id ?? "");
		const assetGroup =
			row.assetGroup?.resourceName ??
			`customers/${GOOGLE_ADS_ZIPGRIP_CUSTOMER_ID}/assetGroups/${assetGroupId}`;
		operations.push(
			{ assetGroupListingGroupFilterOperation: { remove: filter.resourceName } },
			{
				assetGroupListingGroupFilterOperation: {
					create: {
						resourceName: `customers/${GOOGLE_ADS_ZIPGRIP_CUSTOMER_ID}/assetGroupListingGroupFilters/${assetGroupId}~${tempId--}`,
						assetGroup,
						parentListingGroupFilter: filter.parentListingGroupFilter,
						type: "UNIT_EXCLUDED",
						listingSource: filter.listingSource ?? "SHOPPING",
						caseValue: {
							productItemId: { value: GOOGLE_ADS_ZIPGRIP_ITEM_ID },
						},
					},
				},
			},
		);
	} else {
		const containingLeaves = sourcePmaxFilters.filter((row) => {
			const filter = row.assetGroupListingGroupFilter;
			return (
				String(row.assetGroup?.id ?? "") === "6591192784" &&
				filter?.type === "UNIT_INCLUDED" &&
				filter?.caseValue?.productType?.level === "LEVEL2" &&
				filter?.caseValue?.productType?.value === "zip sided outdoor blinds" &&
				Boolean(filter.parentListingGroupFilter) &&
				Boolean(filter.resourceName)
			);
		});
		if (containingLeaves.length !== 1) {
			throw zipGripLaunchTreeError(
				`Refusing launch: expected exactly one included Outdoor blinds > zip sided outdoor blinds leaf; found ${containingLeaves.length}.`,
				sourcePmaxFilters,
				sourceShoppingCriteria,
			);
		}
		const row = containingLeaves[0];
		const leaf = row.assetGroupListingGroupFilter;
		const assetGroupId = String(row.assetGroup?.id ?? "");
		const assetGroup =
			row.assetGroup?.resourceName ??
			`customers/${GOOGLE_ADS_ZIPGRIP_CUSTOMER_ID}/assetGroups/${assetGroupId}`;
		const subdivision = `customers/${GOOGLE_ADS_ZIPGRIP_CUSTOMER_ID}/assetGroupListingGroupFilters/${assetGroupId}~${tempId--}`;
		operations.push(
			{ assetGroupListingGroupFilterOperation: { remove: leaf.resourceName } },
			{
				assetGroupListingGroupFilterOperation: {
					create: {
						resourceName: subdivision,
						assetGroup,
						parentListingGroupFilter: leaf.parentListingGroupFilter,
						type: "SUBDIVISION",
						listingSource: leaf.listingSource ?? "SHOPPING",
						caseValue: {
							productType: {
								value: "zip sided outdoor blinds",
								level: "LEVEL2",
							},
						},
					},
				},
			},
			{
				assetGroupListingGroupFilterOperation: {
					create: {
						resourceName: `customers/${GOOGLE_ADS_ZIPGRIP_CUSTOMER_ID}/assetGroupListingGroupFilters/${assetGroupId}~${tempId--}`,
						assetGroup,
						parentListingGroupFilter: subdivision,
						type: "UNIT_EXCLUDED",
						listingSource: leaf.listingSource ?? "SHOPPING",
						caseValue: {
							productItemId: { value: GOOGLE_ADS_ZIPGRIP_ITEM_ID },
						},
					},
				},
			},
			{
				assetGroupListingGroupFilterOperation: {
					create: {
						resourceName: `customers/${GOOGLE_ADS_ZIPGRIP_CUSTOMER_ID}/assetGroupListingGroupFilters/${assetGroupId}~${tempId--}`,
						assetGroup,
						parentListingGroupFilter: subdivision,
						type: "UNIT_INCLUDED",
						listingSource: leaf.listingSource ?? "SHOPPING",
						caseValue: { productItemId: {} },
					},
				},
			},
		);
	}

	for (const [adGroupId, rows] of shoppingByGroup) {
		const matches = rows.filter(
			(row) =>
				row.adGroupCriterion?.listingGroup?.caseValue?.productItemId?.value ===
				GOOGLE_ADS_ZIPGRIP_ITEM_ID,
		);
		if (matches.length !== 1) {
			throw zipGripLaunchTreeError(
				`Refusing launch: source Shopping ad group ${adGroupId} must contain exactly one explicit gla_1301 unit node; found ${matches.length}.`,
				sourcePmaxFilters,
				sourceShoppingCriteria,
			);
		}
		const existingCriterion = matches[0].adGroupCriterion;
		if (
			existingCriterion?.listingGroup?.type !== "UNIT" ||
			!existingCriterion.listingGroup.parentAdGroupCriterion ||
			existingCriterion.negative ||
			!existingCriterion.resourceName
		) {
			throw zipGripLaunchTreeError(
				`Refusing launch: the gla_1301 node in Shopping ad group ${adGroupId} is not an included child unit.`,
				sourcePmaxFilters,
				sourceShoppingCriteria,
			);
		}
		const adGroup =
			matches[0].adGroup?.resourceName ??
			`customers/${GOOGLE_ADS_ZIPGRIP_CUSTOMER_ID}/adGroups/${adGroupId}`;
		operations.push(
			{ adGroupCriterionOperation: { remove: existingCriterion.resourceName } },
			{
				adGroupCriterionOperation: {
					create: {
						resourceName: `customers/${GOOGLE_ADS_ZIPGRIP_CUSTOMER_ID}/adGroupCriteria/${adGroupId}~${tempId--}`,
						adGroup,
						status: "ENABLED",
						negative: true,
						listingGroup: {
							type: "UNIT",
							parentAdGroupCriterion:
								existingCriterion.listingGroup.parentAdGroupCriterion,
							caseValue: {
								productItemId: { value: GOOGLE_ADS_ZIPGRIP_ITEM_ID },
							},
						},
					},
				},
			},
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

type ProductPmaxIdentity = {
	productId: number;
	expectedProductName: string;
	campaignLabel: string;
	campaignName: string;
	assetGroupName: string;
	itemId: string;
	finalUrl: string;
};

function assertProductPmaxGoogleAdsAccount() {
	const { customerId } = getGoogleAdsConfig();
	if (customerId !== GOOGLE_ADS_PRODUCT_PMAX_CUSTOMER_ID) {
		throw new Error(
			`Refusing product PMax access: configured customer ${customerId} is not the Blindmotion customer ${GOOGLE_ADS_PRODUCT_PMAX_CUSTOMER_ID}.`,
		);
	}
}

function gaqlString(value: string) {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function productPmaxCampaignName(campaignLabel: string) {
	return `BM Online PMax — ${campaignLabel}`;
}

function productPmaxAssetGroupName(campaignLabel: string) {
	return `${campaignLabel} product`;
}

async function getProductPmaxIdentity(
	productId: number,
	expectedProductName: string,
	campaignLabel: string,
	requirePublished = true,
): Promise<ProductPmaxIdentity> {
	assertProductPmaxGoogleAdsAccount();
	const response = await wcFetch(`products/${productId}`);
	const product = await response.json<any>();
	if (Number(product?.id) !== productId || product?.name !== expectedProductName) {
		throw new Error(
			`Refusing product PMax access: WooCommerce product ${productId} did not match the expected name.`,
		);
	}
	if (requirePublished && product?.status !== "publish") {
		throw new Error(
			`Refusing product PMax creation: WooCommerce product ${productId} is ${product?.status ?? "unknown"}, not published.`,
		);
	}
	if (!product?.slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(product.slug)) {
		throw new Error("Refusing product PMax access: the product slug is missing or unsafe.");
	}
	const workerEnv = env as unknown as Record<string, string>;
	const site = new URL(workerEnv.WC_SITE);
	const finalUrl = new URL(`/${product.slug}/`, site.origin).toString();
	const campaignName = productPmaxCampaignName(campaignLabel);
	const assetGroupName = productPmaxAssetGroupName(campaignLabel);
	if (campaignName.length > 128 || assetGroupName.length > 128) {
		throw new Error("The derived campaign or asset-group name exceeds Google's limit.");
	}
	return {
		productId,
		expectedProductName,
		campaignLabel,
		campaignName,
		assetGroupName,
		itemId: `gla_${productId}`,
		finalUrl,
	};
}

async function findExistingProductPmaxCampaign(identity: ProductPmaxIdentity) {
	return googleAdsSearch(`
		SELECT campaign.id, campaign.resource_name, campaign.name, campaign.status,
			campaign.advertising_channel_type
		FROM campaign
		WHERE campaign.name = '${gaqlString(identity.campaignName)}'
			AND campaign.status != 'REMOVED'
		LIMIT 2
	`);
}

function productPmaxPlan(identity: ProductPmaxIdentity, dailyBudgetAud: number) {
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
					name: `${identity.campaignName} budget`,
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
					name: identity.campaignName,
					status: "PAUSED",
					advertisingChannelType: "PERFORMANCE_MAX",
					campaignBudget: budgetResource,
					maximizeConversionValue: {},
					shoppingSetting: {
						merchantId: GOOGLE_ADS_PRODUCT_PMAX_MERCHANT_ID,
						feedLabel: GOOGLE_ADS_PRODUCT_PMAX_FEED_LABEL,
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
					name: identity.assetGroupName,
					finalUrls: [identity.finalUrl],
					finalMobileUrls: [identity.finalUrl],
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
					caseValue: { productItemId: { value: identity.itemId } },
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
		identity,
		daily_budget_aud: dailyBudgetAud,
		bidding: "MAXIMIZE_CONVERSION_VALUE_WITHOUT_TARGET_ROAS",
		merchant_id: GOOGLE_ADS_PRODUCT_PMAX_MERCHANT_ID,
		feed_label: GOOGLE_ADS_PRODUCT_PMAX_FEED_LABEL,
		all_other_items: "EXCLUDED",
		final_url_expansion: "OPTED_OUT",
		location: "Australia",
		language: "English",
		mutateOperations,
	};
}

function productPmaxCampaignResource(campaignId: string) {
	return `customers/${GOOGLE_ADS_PRODUCT_PMAX_CUSTOMER_ID}/campaigns/${campaignId}`;
}

function productPmaxAssetGroupResource(assetGroupId: string) {
	return `customers/${GOOGLE_ADS_PRODUCT_PMAX_CUSTOMER_ID}/assetGroups/${assetGroupId}`;
}

function productPmaxAssetResource(assetId: string) {
	return `customers/${GOOGLE_ADS_PRODUCT_PMAX_CUSTOMER_ID}/assets/${assetId}`;
}

async function getProductPmaxAssetState(args: {
	productId: number;
	expectedProductName: string;
	campaignLabel: string;
	campaignId: string;
	assetGroupId: string;
	requirePaused?: boolean;
}) {
	const identity = await getProductPmaxIdentity(
		args.productId,
		args.expectedProductName,
		args.campaignLabel,
		true,
	);
	const groups = await googleAdsSearch(`
		SELECT campaign.id, campaign.resource_name, campaign.name, campaign.status,
			campaign.advertising_channel_type, campaign.brand_guidelines_enabled,
			asset_group.id, asset_group.resource_name, asset_group.name, asset_group.status,
			asset_group.final_urls, asset_group.ad_strength, asset_group.primary_status,
			asset_group.primary_status_reasons
		FROM asset_group
		WHERE campaign.id = ${args.campaignId}
			AND asset_group.id = ${args.assetGroupId}
		LIMIT 2
	`);
	if (groups.length !== 1) {
		throw new Error("The product PMax campaign and asset group were not unique.");
	}
	const campaign = groups[0]?.campaign;
	const assetGroup = groups[0]?.assetGroup;
	const requirePaused = args.requirePaused ?? true;
	if (
		String(campaign?.id) !== args.campaignId ||
		campaign?.name !== identity.campaignName ||
		campaign?.advertisingChannelType !== "PERFORMANCE_MAX" ||
		String(assetGroup?.id) !== args.assetGroupId ||
		assetGroup?.name !== identity.assetGroupName ||
		assetGroup?.finalUrls?.length !== 1 ||
		assetGroup.finalUrls[0] !== identity.finalUrl ||
		(requirePaused && (campaign?.status !== "PAUSED" || assetGroup?.status !== "PAUSED"))
	) {
		throw new Error(
			"Refusing product PMax access: campaign, asset group, landing page or paused state did not match.",
		);
	}
	const listing = await googleAdsSearch(`
		SELECT asset_group_listing_group_filter.resource_name,
			asset_group_listing_group_filter.parent_listing_group_filter,
			asset_group_listing_group_filter.type,
			asset_group_listing_group_filter.case_value.product_item_id.value
		FROM asset_group_listing_group_filter
		WHERE campaign.id = ${args.campaignId}
			AND asset_group.id = ${args.assetGroupId}
	`);
	const included = listing.filter(
		(row) =>
			row.assetGroupListingGroupFilter?.type === "UNIT_INCLUDED" &&
			row.assetGroupListingGroupFilter?.caseValue?.productItemId?.value === identity.itemId,
	);
	const excludedOther = listing.filter(
		(row) =>
			row.assetGroupListingGroupFilter?.type === "UNIT_EXCLUDED" &&
			row.assetGroupListingGroupFilter?.caseValue?.productItemId &&
			!row.assetGroupListingGroupFilter.caseValue.productItemId.value,
	);
	if (included.length !== 1 || excludedOther.length !== 1 || listing.length !== 3) {
		throw new Error(
			"Refusing product PMax access: listing group is not the expected one-product partition.",
		);
	}
	const assetGroupAssets = await googleAdsSearch(`
		SELECT asset_group_asset.resource_name, asset_group_asset.asset_group,
			asset_group_asset.asset, asset_group_asset.field_type,
			asset_group_asset.status, asset_group_asset.source,
			asset_group_asset.primary_status, asset_group_asset.primary_status_reasons,
			asset_group_asset.policy_summary.approval_status,
			asset_group_asset.policy_summary.review_status,
			asset.id, asset.resource_name, asset.name, asset.type,
			asset.text_asset.text, asset.image_asset.full_size.url,
			asset.image_asset.full_size.width_pixels,
			asset.image_asset.full_size.height_pixels, asset.image_asset.file_size,
			asset.youtube_video_asset.youtube_video_id,
			asset.youtube_video_asset.youtube_video_title
		FROM asset_group_asset
		WHERE asset_group.id = ${args.assetGroupId}
			AND asset_group_asset.status != 'REMOVED'
		ORDER BY asset_group_asset.field_type, asset.id
	`);
	const campaignAssets = await googleAdsSearch(`
		SELECT campaign_asset.resource_name, campaign_asset.field_type,
			campaign_asset.status, asset.id, asset.resource_name, asset.name, asset.type,
			asset.text_asset.text, asset.image_asset.full_size.url,
			asset.image_asset.full_size.width_pixels,
			asset.image_asset.full_size.height_pixels, asset.image_asset.file_size
		FROM campaign_asset
		WHERE campaign.id = ${args.campaignId}
			AND campaign_asset.status != 'REMOVED'
	`);
	const counts: Record<string, number> = {};
	for (const row of assetGroupAssets) {
		const type = row.assetGroupAsset?.fieldType;
		if (type) counts[type] = (counts[type] ?? 0) + 1;
	}
	for (const row of campaignAssets) {
		const type = row.campaignAsset?.fieldType;
		if (type) counts[type] = (counts[type] ?? 0) + 1;
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
			const rule = ZIPGRIP_ASSET_REQUIREMENTS[fieldType];
			const count = counts[fieldType] ?? 0;
			return [
				fieldType,
				{
					count,
					minimum: rule.min,
					maximum: rule.max,
					meets_minimum: count >= rule.min,
					missing: Math.max(0, rule.min - count),
				},
			];
		}),
	);
	return {
		identity,
		campaign,
		asset_group: assetGroup,
		listing_group: listing,
		brand_guidelines_enabled: brandGuidelinesEnabled,
		asset_group_assets: assetGroupAssets,
		campaign_brand_assets: campaignAssets,
		counts,
		completeness,
		minimum_complete: Object.values(completeness).every((value: any) => value.meets_minimum),
	};
}

function buildProductPmaxAssetLinkOperation(
	campaignId: string,
	assetGroupId: string,
	assetResource: string,
	fieldType: string,
	brandGuidelinesEnabled: boolean,
) {
	const isBrandAsset = ["BUSINESS_NAME", "LOGO", "LANDSCAPE_LOGO"].includes(fieldType);
	if (brandGuidelinesEnabled && isBrandAsset) {
		return {
			campaignAssetOperation: {
				create: {
					campaign: productPmaxCampaignResource(campaignId),
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
				assetGroup: productPmaxAssetGroupResource(assetGroupId),
				asset: assetResource,
				fieldType,
				status: "ENABLED",
			},
		},
	};
}

function bytesToBase64(bytes: Uint8Array) {
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return btoa(binary);
}

async function loadBlindmotionPmaxImage(sourceUrl: string) {
	const workerEnv = env as unknown as Record<string, string>;
	const site = new URL(workerEnv.WC_SITE);
	const url = new URL(sourceUrl);
	if (
		url.protocol !== "https:" ||
		url.host !== site.host ||
		!url.pathname.startsWith("/wp-content/uploads/") ||
		url.search ||
		url.hash
	) {
		throw new Error(
			"Image source_url must be an exact HTTPS Blindmotion WordPress uploads URL.",
		);
	}
	const response = await fetch(url.toString(), { redirect: "error" });
	if (!response.ok) {
		throw new Error(`Image download failed: ${response.status}.`);
	}
	const contentType = response.headers.get("content-type")?.split(";")[0];
	if (contentType !== "image/jpeg" && contentType !== "image/png") {
		throw new Error("Only JPEG and PNG source images can be uploaded to Google Ads.");
	}
	const mimeType: "image/jpeg" | "image/png" = contentType;
	const bytes = new Uint8Array(await response.arrayBuffer());
	return { bytes, mimeType, imageBase64: bytesToBase64(bytes) };
}

function validatePmaxExistingImage(
	image: any,
	fieldType:
		| "MARKETING_IMAGE"
		| "SQUARE_MARKETING_IMAGE"
		| "PORTRAIT_MARKETING_IMAGE"
		| "LOGO"
		| "LANDSCAPE_LOGO",
) {
	const width = Number(image?.widthPixels ?? 0);
	const height = Number(image?.heightPixels ?? 0);
	const bytes = Number(image?.fileSize ?? 0);
	const rules = {
		MARKETING_IMAGE: { ratio: 1.91, minWidth: 600, minHeight: 314 },
		SQUARE_MARKETING_IMAGE: { ratio: 1, minWidth: 300, minHeight: 300 },
		PORTRAIT_MARKETING_IMAGE: { ratio: 0.8, minWidth: 480, minHeight: 600 },
		LOGO: { ratio: 1, minWidth: 128, minHeight: 128 },
		LANDSCAPE_LOGO: { ratio: 4, minWidth: 512, minHeight: 128 },
	}[fieldType];
	if (
		width < rules.minWidth ||
		height < rules.minHeight ||
		bytes > 5_120_000 ||
		Math.abs(width / height - rules.ratio) > 0.02
	) {
		throw new Error(
			`Existing image does not meet ${fieldType} dimensions, ratio or size requirements.`,
		);
	}
	return { width, height, bytes, aspect_ratio: width / height };
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

function searchConsoleReportResult(
	report: any,
	startDate: string,
	endDate: string,
	dimensions: SearchConsoleDimension[],
) {
	const rows = (report.rows ?? []).map((row: any) => ({
		...Object.fromEntries(
			dimensions.map((dimension, index) => [dimension, row.keys?.[index] ?? ""]),
		),
		clicks: Number(row.clicks ?? 0),
		impressions: Number(row.impressions ?? 0),
		ctr: Number(row.ctr ?? 0),
		position: Number(row.position ?? 0),
	}));

	return {
		site_url: SEARCH_CONSOLE_SITE_URL,
		start_date: startDate,
		end_date: endDate,
		search_type: "web",
		row_count: rows.length,
		rows,
		response_aggregation_type: report.responseAggregationType,
		metadata: report.metadata,
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

function githubBase64Url(bytes: Uint8Array) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function githubUtf8Base64Url(value: string) {
	return githubBase64Url(new TextEncoder().encode(value));
}

function githubDerLength(length: number) {
	if (length < 0x80) return new Uint8Array([length]);
	const bytes: number[] = [];
	for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
	return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function githubDer(tag: number, content: Uint8Array) {
	const length = githubDerLength(content.length);
	const result = new Uint8Array(1 + length.length + content.length);
	result[0] = tag;
	result.set(length, 1);
	result.set(content, 1 + length.length);
	return result;
}

function githubConcat(...parts: Uint8Array[]) {
	const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}

function githubPemToPkcs8(pem: string) {
	const normalized = pem.trim().replace(/\\n/g, "\n");
	const isPkcs1 = normalized.includes("-----BEGIN RSA PRIVATE KEY-----");
	const base64 = normalized
		.replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/g, "")
		.replace(/-----END (?:RSA )?PRIVATE KEY-----/g, "")
		.replace(/\s/g, "");
	if (!base64) throw new Error("GITHUB_APP_PRIVATE_KEY is empty or invalid.");
	const der = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
	if (!isPkcs1) return der;

	const version = new Uint8Array([0x02, 0x01, 0x00]);
	const rsaAlgorithmIdentifier = new Uint8Array([
		0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
	]);
	return githubDer(0x30, githubConcat(version, rsaAlgorithmIdentifier, githubDer(0x04, der)));
}

function getGithubAppConfig() {
	const workerEnv = env as unknown as Record<string, string | undefined>;
	const appId = workerEnv.GITHUB_APP_ID;
	const installationId = workerEnv.GITHUB_INSTALLATION_ID;
	const privateKey = workerEnv.GITHUB_APP_PRIVATE_KEY;
	if (!appId || !installationId || !privateKey) {
		throw new Error(
			"GitHub App is not configured. Set GITHUB_APP_ID, GITHUB_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY in Cloudflare.",
		);
	}
	if (
		appId !== GITHUB_APP_EXPECTED_ID ||
		installationId !== GITHUB_APP_EXPECTED_INSTALLATION_ID
	) {
		throw new Error("GitHub App IDs do not match the locked Blindmotion installation.");
	}
	return { appId, installationId, privateKey };
}

async function createGithubAppJwt() {
	const { appId, privateKey } = getGithubAppConfig();
	const now = Math.floor(Date.now() / 1000);
	const header = githubUtf8Base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = githubUtf8Base64Url(
		JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
	);
	const signingInput = `${header}.${payload}`;
	const key = await crypto.subtle.importKey(
		"pkcs8",
		githubPemToPkcs8(privateKey),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(signingInput),
	);
	return `${signingInput}.${githubBase64Url(new Uint8Array(signature))}`;
}

async function githubApi(
	path: string,
	options: {
		method?: string;
		body?: unknown;
		token: string;
		acceptedStatuses?: number[];
	},
) {
	const response = await fetch(`https://api.github.com${path}`, {
		method: options.method ?? "GET",
		headers: {
			Authorization: `Bearer ${options.token}`,
			Accept: "application/vnd.github+json",
			"Content-Type": "application/json",
			"User-Agent": "Blindmotion-Business-MCP",
			"X-GitHub-Api-Version": "2022-11-28",
		},
		...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
	});
	const responseText = await response.text();
	let data: any = null;
	if (responseText) {
		try {
			data = JSON.parse(responseText);
		} catch {
			data = responseText;
		}
	}
	if (!response.ok && !(options.acceptedStatuses ?? []).includes(response.status)) {
		throw new Error(
			`GitHub API request failed: ${response.status} ${typeof data === "string" ? data : JSON.stringify(data)}`,
		);
	}
	return { status: response.status, data };
}

async function getGithubInstallationToken() {
	const { installationId } = getGithubAppConfig();
	const jwt = await createGithubAppJwt();
	const response = await githubApi(`/app/installations/${installationId}/access_tokens`, {
		method: "POST",
		token: jwt,
		body: {
			repository_ids: [GITHUB_REPO_ID],
			permissions: { contents: "write", pull_requests: "write" },
		},
	});
	if (!response.data?.token) throw new Error("GitHub did not return an installation token.");
	return String(response.data.token);
}

function githubRepoPath(path: string) {
	return `/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}${path}`;
}

async function githubRepoRequest(
	token: string,
	path: string,
	options: { method?: string; body?: unknown; acceptedStatuses?: number[] } = {},
) {
	return githubApi(githubRepoPath(path), { ...options, token });
}

function assertGithubPatchFile(path: string, content: string) {
	if (!GITHUB_PATCHABLE_FILES.has(path)) {
		throw new Error(
			`Path ${path} is not permitted. This tool can change only ${[...GITHUB_PATCHABLE_FILES].join(", ")}.`,
		);
	}
	if (new TextEncoder().encode(content).length > GITHUB_MAX_FILE_BYTES) {
		throw new Error(`${path} exceeds the ${GITHUB_MAX_FILE_BYTES}-byte safety limit.`);
	}
	const privateKeyPattern = new RegExp(
		[
			"-----BEGIN (?:RSA )?",
			"PRIVATE KEY-----",
			"\\s+[A-Za-z0-9+/=\\r\\n]{256,}",
			"-----END (?:RSA )?",
			"PRIVATE KEY-----",
		].join(""),
	);
	if (privateKeyPattern.test(content)) {
		throw new Error(`${path} appears to contain a private key.`);
	}
}

async function getGithubMainState(token: string) {
	const ref = await githubRepoRequest(token, "/git/ref/heads/main");
	const sha = String(ref.data?.object?.sha ?? "");
	if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Could not resolve the current main SHA.");
	const commit = await githubRepoRequest(token, `/git/commits/${sha}`);
	const treeSha = String(commit.data?.tree?.sha ?? "");
	if (!/^[0-9a-f]{40}$/.test(treeSha)) throw new Error("Could not resolve the main tree SHA.");
	return { sha, treeSha };
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

	server.registerTool(
		"get_blindmotion_github_app_status",
		{
			description:
				"Verify the fixed Blindmotion GitHub App installation and report the current main commit. Read-only; never returns credentials or an installation token.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				const token = await getGithubInstallationToken();
				const [repository, main] = await Promise.all([
					githubRepoRequest(token, ""),
					getGithubMainState(token),
				]);
				if (
					Number(repository.data?.id) !== GITHUB_REPO_ID ||
					String(repository.data?.full_name) !== GITHUB_REPO_FULL_NAME
				) {
					throw new Error(
						"GitHub installation token resolved to an unexpected repository.",
					);
				}
				return toolResult({
					configured: true,
					repository: GITHUB_REPO_FULL_NAME,
					repository_id: GITHUB_REPO_ID,
					default_branch: repository.data.default_branch,
					main_sha: main.sha,
					installation_token_exposed: false,
					write_boundary: {
						allowed_files: [...GITHUB_PATCHABLE_FILES],
						draft_pull_requests_only: true,
						direct_main_updates: false,
						merge_tool_available: false,
					},
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_blindmotion_mcp_source_file",
		{
			description:
				"Read one permitted Blindmotion MCP source file from the exact current main commit through the repository-scoped GitHub App. Returns content and blob SHA; cannot read any other path or ref.",
			inputSchema: z.object({
				path: z.enum(["src/index.ts", "README.md"]),
				expected_main_sha: z
					.string()
					.regex(/^[0-9a-f]{40}$/)
					.optional(),
			}),
		},
		async ({ path, expected_main_sha }) => {
			try {
				const token = await getGithubInstallationToken();
				const main = await getGithubMainState(token);
				if (expected_main_sha !== undefined && main.sha !== expected_main_sha) {
					throw new Error(
						`main changed since review. Expected ${expected_main_sha}, current ${main.sha}. Re-read before continuing.`,
					);
				}
				const file = await githubRepoRequest(token, `/contents/${path}?ref=${main.sha}`);
				if (
					file.data?.type !== "file" ||
					typeof file.data?.content !== "string" ||
					file.data?.encoding !== "base64" ||
					!/^[0-9a-f]{40}$/.test(String(file.data?.sha ?? ""))
				) {
					throw new Error("GitHub returned an unexpected source-file response.");
				}
				const content = new TextDecoder().decode(
					decodeBase64(file.data.content.replace(/\n/g, "")),
				);
				return toolResult({
					repository: GITHUB_REPO_FULL_NAME,
					main_sha: main.sha,
					path,
					blob_sha: file.data.sha,
					encoding: "utf-8",
					content,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"create_blindmotion_mcp_draft_pr_guarded",
		{
			description: `Create one atomic draft PR in ${GITHUB_REPO_FULL_NAME} from the exact current main SHA. It can replace only src/index.ts and/or README.md, cannot modify workflows or dependencies, cannot update main, and cannot merge. Requires exact confirmation: ${GITHUB_PATCH_CONFIRMATION}`,
			inputSchema: z.object({
				confirmation: z.string(),
				expected_main_sha: z.string().regex(/^[0-9a-f]{40}$/),
				branch_slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,50}$/),
				commit_message: z.string().trim().min(5).max(120),
				pull_request_title: z.string().trim().min(5).max(120),
				pull_request_body: z.string().max(10_000).default(""),
				files: z
					.array(
						z.object({
							path: z.enum(["src/index.ts", "README.md"]),
							expected_blob_sha: z.string().regex(/^[0-9a-f]{40}$/),
							content: z.string().min(1),
						}),
					)
					.min(1)
					.max(GITHUB_MAX_PATCH_FILES),
			}),
		},
		async ({
			confirmation,
			expected_main_sha,
			branch_slug,
			commit_message,
			pull_request_title,
			pull_request_body,
			files,
		}) => {
			try {
				if (confirmation !== GITHUB_PATCH_CONFIRMATION) {
					throw new Error(
						`Confirmation must exactly equal: ${GITHUB_PATCH_CONFIRMATION}`,
					);
				}
				if (new Set(files.map((file) => file.path)).size !== files.length) {
					throw new Error("Each permitted file may appear only once.");
				}
				for (const file of files) assertGithubPatchFile(file.path, file.content);

				const token = await getGithubInstallationToken();
				const repository = await githubRepoRequest(token, "");
				if (
					Number(repository.data?.id) !== GITHUB_REPO_ID ||
					String(repository.data?.full_name) !== GITHUB_REPO_FULL_NAME
				) {
					throw new Error(
						"GitHub installation token resolved to an unexpected repository.",
					);
				}
				const main = await getGithubMainState(token);
				if (main.sha !== expected_main_sha) {
					throw new Error(
						`main changed since review. Expected ${expected_main_sha}, current ${main.sha}. Re-read and review before retrying.`,
					);
				}

				const branchName = `codex/${branch_slug}-${main.sha.slice(0, 8)}`;
				const existingBranch = await githubRepoRequest(
					token,
					`/git/ref/heads/${encodeURIComponent(branchName)}`,
					{ acceptedStatuses: [404] },
				);
				if (existingBranch.status !== 404) {
					throw new Error(
						`Branch ${branchName} already exists; choose a new branch_slug.`,
					);
				}

				const tree: Array<{ path: string; mode: string; type: string; sha: string }> = [];
				for (const file of files) {
					const current = await githubRepoRequest(
						token,
						`/contents/${file.path}?ref=${main.sha}`,
					);
					if (String(current.data?.sha) !== file.expected_blob_sha) {
						throw new Error(
							`${file.path} changed since review. Expected blob ${file.expected_blob_sha}, current ${String(current.data?.sha)}.`,
						);
					}
					const blob = await githubRepoRequest(token, "/git/blobs", {
						method: "POST",
						body: { content: file.content, encoding: "utf-8" },
					});
					tree.push({
						path: file.path,
						mode: "100644",
						type: "blob",
						sha: blob.data.sha,
					});
				}

				const createdTree = await githubRepoRequest(token, "/git/trees", {
					method: "POST",
					body: { base_tree: main.treeSha, tree },
				});
				const commit = await githubRepoRequest(token, "/git/commits", {
					method: "POST",
					body: {
						message: commit_message,
						tree: createdTree.data.sha,
						parents: [main.sha],
					},
				});
				await githubRepoRequest(token, "/git/refs", {
					method: "POST",
					body: { ref: `refs/heads/${branchName}`, sha: commit.data.sha },
				});
				const pullRequest = await githubRepoRequest(token, "/pulls", {
					method: "POST",
					body: {
						title: pull_request_title,
						body: pull_request_body,
						head: branchName,
						base: "main",
						draft: true,
						maintainer_can_modify: true,
					},
				});
				return toolResult({
					created: true,
					repository: GITHUB_REPO_FULL_NAME,
					base_sha: main.sha,
					branch: branchName,
					commit_sha: commit.data.sha,
					pull_request_number: pullRequest.data.number,
					pull_request_url: pullRequest.data.html_url,
					draft: pullRequest.data.draft,
					changed_files: files.map((file) => file.path),
					merged: false,
					next_step:
						"Review checks and diff in GitHub. Merge remains an external, explicit action.",
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"inspect_blindmotion_mcp_pull_request",
		{
			description: `Inspect one pull request in ${GITHUB_REPO_FULL_NAME}, including its base/head commits and changed-file summary. Read-only and cannot approve or merge.`,
			inputSchema: z.object({ pull_request_number: z.number().int().positive() }),
		},
		async ({ pull_request_number }) => {
			try {
				const token = await getGithubInstallationToken();
				const [pullRequest, changedFiles] = await Promise.all([
					githubRepoRequest(token, `/pulls/${pull_request_number}`),
					githubRepoRequest(token, `/pulls/${pull_request_number}/files?per_page=100`),
				]);
				return toolResult({
					repository: GITHUB_REPO_FULL_NAME,
					pull_request_number,
					url: pullRequest.data.html_url,
					state: pullRequest.data.state,
					draft: pullRequest.data.draft,
					mergeable: pullRequest.data.mergeable,
					mergeable_state: pullRequest.data.mergeable_state,
					base: { ref: pullRequest.data.base?.ref, sha: pullRequest.data.base?.sha },
					head: { ref: pullRequest.data.head?.ref, sha: pullRequest.data.head?.sha },
					files: (changedFiles.data as any[]).map((file) => ({
						path: file.filename,
						status: file.status,
						additions: file.additions,
						deletions: file.deletions,
						permitted_by_repo_agent: GITHUB_PATCHABLE_FILES.has(file.filename),
					})),
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/*
	 * Existing test tools
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

	const fabricSamplePlanSchema = z
		.object({
			source_product_id: z.number().int().positive(),
			expected_source_name: z.string().trim().min(1).max(200),
			expected_source_status: z.enum(["publish", "draft", "private", "pending"]),
			destination_product_id: z.number().int().positive(),
			expected_destination_name: z.string().trim().min(1).max(200),
			source_fabric_selector_field_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
			destination_product_selector_field_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
			destination_colour_template_field_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
			sample_product_label: z.string().trim().min(1).max(100),
		})
		.refine((value) => value.source_product_id !== value.destination_product_id, {
			message: "Source and destination products must differ.",
		});

	async function loadFabricSampleProducts(input: z.infer<typeof fabricSamplePlanSchema>) {
		const [sourceResponse, destinationResponse] = await Promise.all([
			wcFetch(`products/${input.source_product_id}`),
			wcFetch(`products/${input.destination_product_id}`),
		]);
		const [source, destination] = await Promise.all([
			sourceResponse.json<any>(),
			destinationResponse.json<any>(),
		]);
		if (
			source.id !== input.source_product_id ||
			source.name !== input.expected_source_name ||
			source.status !== input.expected_source_status
		) {
			throw new Error("The source product identity or expected status changed.");
		}
		if (
			destination.id !== input.destination_product_id ||
			destination.name !== input.expected_destination_name ||
			destination.status !== "draft" ||
			destination.catalog_visibility !== "hidden"
		) {
			throw new Error(
				"The destination must be the exactly named draft, hidden Fabric Sample copy.",
			);
		}
		return { source, destination };
	}

	server.registerTool(
		"preview_product_fabric_sample_setup",
		{
			description:
				"Build a read-only, deterministic plan for adding one source product's fabric ranges and colour swatches to an explicitly identified draft/hidden Fabric Sample copy. Product IDs, names and WAPF field IDs are parameters; it performs no writes and returns exact hashes required by the guarded apply tool.",
			inputSchema: fabricSamplePlanSchema,
		},
		async (input) => {
			try {
				const { source, destination } = await loadFabricSampleProducts(input);
				const plan = await buildFabricSamplePlan(source, destination, {
					sourceProductId: input.source_product_id,
					destinationProductId: input.destination_product_id,
					sourceFabricSelectorFieldId: input.source_fabric_selector_field_id,
					destinationProductSelectorFieldId: input.destination_product_selector_field_id,
					destinationColourTemplateFieldId: input.destination_colour_template_field_id,
					sampleProductLabel: input.sample_product_label,
				});
				return toolResult({
					read_only: true,
					source: {
						id: source.id,
						name: source.name,
						status: source.status,
						wapf_meta_data_id: plan.sourceWapf.meta.id,
						wapf_sha256: plan.sourceHash,
					},
					destination: {
						id: destination.id,
						name: destination.name,
						status: destination.status,
						catalog_visibility: destination.catalog_visibility,
						wapf_meta_data_id: plan.destinationWapf.meta.id,
						wapf_sha256: plan.destinationHash,
						current_field_count: plan.destinationWapf.group.fields.length,
						planned_field_count: plan.updatedGroup.fields.length,
					},
					plan: {
						plan_sha256: plan.planHash,
						product_choice: {
							label: plan.newProductChoice.label,
							slug: plan.newProductChoice.slug,
							attachment: plan.newProductChoice.attachment,
						},
						fabric_selector: wapfFieldSummary(plan.newSelector, -1),
						colour_fields: plan.newColourFields.map((field, index) =>
							wapfFieldSummary(field, index),
						),
						colour_choice_count: plan.newColourFields.reduce(
							(total, field) => total + field.options.choices.length,
							0,
						),
					},
					write_performed: false,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"apply_product_fabric_sample_setup_guarded",
		{
			description: `Apply one exact preflighted fabric-sample plan to an explicitly identified draft/hidden Fabric Sample copy. Revalidates product identities, source/destination WAPF hashes and the deterministic plan hash; preserves the live sample product, strips pricing from copied choices, verifies the full result and rolls back exactly on failure. Cannot publish. Requires exact confirmation: ${FABRIC_SAMPLE_SETUP_CONFIRMATION}`,
			inputSchema: fabricSamplePlanSchema.extend({
				expected_source_wapf_sha256: z.string().regex(/^[a-f0-9]{64}$/),
				expected_destination_wapf_sha256: z.string().regex(/^[a-f0-9]{64}$/),
				expected_plan_sha256: z.string().regex(/^[a-f0-9]{64}$/),
				confirmation: z.literal(FABRIC_SAMPLE_SETUP_CONFIRMATION),
			}),
		},
		async (input) => {
			let originalValue: unknown;
			let destinationMetaId: number | undefined;
			let writeCompleted = false;
			try {
				const { source, destination } = await loadFabricSampleProducts(input);
				const plan = await buildFabricSamplePlan(source, destination, {
					sourceProductId: input.source_product_id,
					destinationProductId: input.destination_product_id,
					sourceFabricSelectorFieldId: input.source_fabric_selector_field_id,
					destinationProductSelectorFieldId: input.destination_product_selector_field_id,
					destinationColourTemplateFieldId: input.destination_colour_template_field_id,
					sampleProductLabel: input.sample_product_label,
				});
				if (
					plan.sourceHash !== input.expected_source_wapf_sha256 ||
					plan.destinationHash !== input.expected_destination_wapf_sha256 ||
					plan.planHash !== input.expected_plan_sha256
				) {
					throw new Error(
						"The source, destination or planned Fabric Sample configuration changed after preflight.",
					);
				}

				originalValue = plan.destinationWapf.meta.value;
				destinationMetaId = Number(plan.destinationWapf.meta.id);
				if (!Number.isInteger(destinationMetaId) || destinationMetaId <= 0) {
					throw new Error("The destination WAPF metadata ID is invalid.");
				}
				const untouchedState = JSON.stringify({
					name: destination.name,
					slug: destination.slug,
					type: destination.type,
					price: destination.price,
					regular_price: destination.regular_price,
					sale_price: destination.sale_price,
					description: destination.description,
					short_description: destination.short_description,
					images: destination.images,
					categories: destination.categories,
					attributes: destination.attributes,
					sold_individually: destination.sold_individually,
				});

				await wcWrite(`products/${input.destination_product_id}`, {
					status: "draft",
					catalog_visibility: "hidden",
					meta_data: [
						{
							id: destinationMetaId,
							key: "_wapf_fieldgroup",
							value: plan.updatedGroup,
						},
					],
				});
				writeCompleted = true;

				const verificationResponse = await wcFetch(
					`products/${input.destination_product_id}`,
				);
				const verified = await verificationResponse.json<any>();
				const verifiedWapf = singleWapfFieldGroup(verified);
				const verifiedHash = await sha256Hex(
					new TextEncoder().encode(JSON.stringify(verifiedWapf.group)),
				);
				const verifiedUntouchedState = JSON.stringify({
					name: verified.name,
					slug: verified.slug,
					type: verified.type,
					price: verified.price,
					regular_price: verified.regular_price,
					sale_price: verified.sale_price,
					description: verified.description,
					short_description: verified.short_description,
					images: verified.images,
					categories: verified.categories,
					attributes: verified.attributes,
					sold_individually: verified.sold_individually,
				});
				if (
					verified.id !== input.destination_product_id ||
					verified.name !== input.expected_destination_name ||
					verified.status !== "draft" ||
					verified.catalog_visibility !== "hidden" ||
					Number(verifiedWapf.meta.id) !== destinationMetaId ||
					verifiedHash !== plan.planHash ||
					verifiedUntouchedState !== untouchedState
				) {
					throw new Error("Post-write Fabric Sample verification failed.");
				}

				return toolResult({
					updated: true,
					source: { id: source.id, name: source.name, modified: false },
					destination: {
						id: verified.id,
						name: verified.name,
						status: verified.status,
						catalog_visibility: verified.catalog_visibility,
						wapf_meta_data_id: destinationMetaId,
						wapf_sha256: verifiedHash,
					},
					added_product_choice: plan.newProductChoice.label,
					added_fabric_ranges: plan.newSelector.options.choices.map(
						(choice: any) => choice.label,
					),
					added_colour_choice_count: plan.newColourFields.reduce(
						(total, field) => total + field.options.choices.length,
						0,
					),
					pricing_removed: true,
					publication_performed: false,
				});
			} catch (error) {
				if (writeCompleted && destinationMetaId && originalValue !== undefined) {
					try {
						await wcWrite(`products/${input.destination_product_id}`, {
							status: "draft",
							catalog_visibility: "hidden",
							meta_data: [
								{
									id: destinationMetaId,
									key: "_wapf_fieldgroup",
									value: originalValue,
								},
							],
						});
						const rollbackResponse = await wcFetch(
							`products/${input.destination_product_id}`,
						);
						const rolledBack = await rollbackResponse.json<any>();
						const rolledBackWapf = singleWapfFieldGroup(rolledBack);
						const rollbackHash = await sha256Hex(
							new TextEncoder().encode(JSON.stringify(rolledBackWapf.meta.value)),
						);
						if (
							rolledBack.status !== "draft" ||
							rolledBack.catalog_visibility !== "hidden" ||
							rollbackHash !== input.expected_destination_wapf_sha256
						) {
							const rollbackVerificationError = new Error(
								"Exact Fabric Sample rollback verification failed.",
							);
							(rollbackVerificationError as any).cause = error;
							throw rollbackVerificationError;
						}
					} catch (rollbackError) {
						return toolError(
							new Error(
								`${error instanceof Error ? error.message : String(error)} Rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
							),
						);
					}
				}
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"inspect_product_elementor_rendering",
		{
			description:
				"Read-only inspection of explicitly selected Elementor templates for one exactly identified WooCommerce product. Searches only for caller-supplied literal terms and reports matching nodes, ancestor visibility/condition settings, image/background settings and stable template hashes. Performs no writes.",
			inputSchema: z.object({
				product_id: z.number().int().positive(),
				expected_product_name: z.string().trim().min(1).max(200),
				template_ids: z.array(z.number().int().positive()).min(1).max(20),
				search_terms: z.array(z.string().trim().min(2).max(200)).min(1).max(20),
			}),
		},
		async ({ product_id, expected_product_name, template_ids, search_terms }) => {
			try {
				if (new Set(template_ids).size !== template_ids.length) {
					throw new Error("Duplicate Elementor template IDs are not allowed.");
				}
				const normalizedTerms = search_terms.map((term) => term.toLowerCase());
				if (new Set(normalizedTerms).size !== normalizedTerms.length) {
					throw new Error("Duplicate Elementor search terms are not allowed.");
				}
				const productResponse = await wcFetch(`products/${product_id}`);
				const product = await productResponse.json<any>();
				if (product.id !== product_id || product.name !== expected_product_name) {
					throw new Error(
						`Product ${product_id} identity does not match the exact expected name.`,
					);
				}
				const templates = [];
				for (const templateId of template_ids) {
					const response = await wpAuthenticatedFetch(
						`elementor_library/${templateId}?context=edit`,
					);
					const template = await response.json<any>();
					if (template.id !== templateId) {
						throw new Error(`Elementor template ${templateId} identity changed.`);
					}
					const raw = template.meta?.["_elementor_data"];
					const data = parseElementorData(raw);
					if (!data || typeof raw !== "string") {
						throw new Error(`Elementor template ${templateId} data is unavailable or malformed.`);
					}
					templates.push({
						id: template.id,
						title: template.title?.raw ?? template.title?.rendered ?? null,
						status: template.status,
						template_type: template.meta?.["_elementor_template_type"] ?? null,
						display_conditions: template.meta?.["_elementor_conditions"] ?? null,
						elementor_data_length: raw.length,
						elementor_data_sha256: await sha256Hex(new TextEncoder().encode(raw)),
						matches: elementorLiteralSettingMatches(data, search_terms),
					});
				}
				return toolResult({
					read_only: true,
					product: {
						id: product.id,
						name: product.name,
						status: product.status,
						catalog_visibility: product.catalog_visibility,
					},
					search_terms,
					templates,
					write_performed: false,
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

	server.registerTool(
		"preview_fabric_collection_import",
		{
			description:
				"Read a supplier collection URL and return a deterministic, non-writing WordPress media import manifest. Supports linked product-page collections and single-page swatches grouped under headings; supplier, collection and all source URLs are runtime parameters.",
			inputSchema: z.object({
				source_url: z.string().url(),
				supplier: z.string().trim().min(1).max(120),
				collection: z.string().trim().min(1).max(120),
				extraction_strategy: z.enum([
					"linked_product_pages",
					"sectioned_attribute_swatches",
				]),
				max_items: z.number().int().min(1).max(100).default(50),
			}),
		},
		async ({ source_url, supplier, collection, extraction_strategy, max_items }) => {
			try {
				const manifest = await buildFabricCollectionManifest({
					sourceUrl: source_url,
					supplier,
					collection,
					extractionStrategy: extraction_strategy,
					maxItems: max_items,
				});
				return toolResult({
					write_performed: false,
					item_count: manifest.items.length,
					...manifest,
					items: manifest.items.map((item) => ({
						item_key: fabricSwatchItemKey(item),
						...item,
					})),
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"inspect_fabric_collection_media_import",
		{
			description:
				"Rebuild an exact reviewed fabric manifest and report which selected swatch attachments are present or missing in WordPress. Supports the same runtime include/exclude keys as the guarded importer and performs no writes.",
			inputSchema: z.object({
				source_url: z.string().url(),
				supplier: z.string().trim().min(1).max(120),
				collection: z.string().trim().min(1).max(120),
				extraction_strategy: z.enum([
					"linked_product_pages",
					"sectioned_attribute_swatches",
				]),
				max_items: z.number().int().min(1).max(100).default(50),
				expected_manifest_hash: z.string().regex(/^[a-f0-9]{64}$/),
				include_item_keys: z.array(z.string().trim().min(1).max(250)).max(100).default([]),
				exclude_item_keys: z.array(z.string().trim().min(1).max(250)).max(100).default([]),
			}),
		},
		async ({
			source_url,
			supplier,
			collection,
			extraction_strategy,
			max_items,
			expected_manifest_hash,
			include_item_keys,
			exclude_item_keys,
		}) => {
			try {
				const manifest = await buildFabricCollectionManifest({
					sourceUrl: source_url,
					supplier,
					collection,
					extractionStrategy: extraction_strategy,
					maxItems: max_items,
				});
				if (manifest.manifest_hash !== expected_manifest_hash) {
					throw new Error(
						`Supplier manifest changed since preview. Expected ${expected_manifest_hash}, current ${manifest.manifest_hash}. Preview again.`,
					);
				}
				const selected = selectFabricSwatches(
					manifest.items,
					include_item_keys,
					exclude_item_keys,
				);
				const results = await inspectFabricAttachments(selected);
				return toolResult({
					write_performed: false,
					manifest_hash: manifest.manifest_hash,
					manifest_item_count: manifest.items.length,
					selected_item_count: selected.length,
					present_count: results.filter((item) => item.status === "present").length,
					missing_count: results.filter((item) => item.status === "missing").length,
					results,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"import_fabric_collection_media_guarded",
		{
			description: `Rebuild a previously previewed fabric manifest, require its exact hash, apply explicit runtime item selection/exclusion, and upload one resumable batch into a hierarchical WordPress media_folder path. Idempotent; never deletes or overwrites media. Batch size is capped at four to remain within Worker limits. Requires exact confirmation: ${FABRIC_COLLECTION_IMPORT_CONFIRMATION}`,
			inputSchema: z.object({
				source_url: z.string().url(),
				supplier: z.string().trim().min(1).max(120),
				collection: z.string().trim().min(1).max(120),
				extraction_strategy: z.enum([
					"linked_product_pages",
					"sectioned_attribute_swatches",
				]),
				media_taxonomy_root: z.string().trim().min(1).max(120).default("Fabric Collections"),
				max_items: z.number().int().min(1).max(100).default(50),
				expected_manifest_hash: z.string().regex(/^[a-f0-9]{64}$/),
				include_item_keys: z.array(z.string().trim().min(1).max(250)).max(100).default([]),
				exclude_item_keys: z.array(z.string().trim().min(1).max(250)).max(100).default([]),
				batch_offset: z.number().int().min(0).max(99).default(0),
				batch_size: z.number().int().min(1).max(4).default(3),
				confirmation: z.literal(FABRIC_COLLECTION_IMPORT_CONFIRMATION),
			}),
		},
		async ({
			source_url,
			supplier,
			collection,
			extraction_strategy,
			media_taxonomy_root,
			max_items,
			expected_manifest_hash,
			include_item_keys,
			exclude_item_keys,
			batch_offset,
			batch_size,
		}) => {
			try {
				const manifest = await buildFabricCollectionManifest({
					sourceUrl: source_url,
					supplier,
					collection,
					extractionStrategy: extraction_strategy,
					maxItems: max_items,
				});
				if (manifest.manifest_hash !== expected_manifest_hash) {
					throw new Error(
						`Supplier manifest changed since preview. Expected ${expected_manifest_hash}, current ${manifest.manifest_hash}. Preview again; no write performed.`,
					);
				}
				const selected = selectFabricSwatches(
					manifest.items,
					include_item_keys,
					exclude_item_keys,
				);
				if (batch_offset > selected.length) {
					throw new Error(
						`batch_offset ${batch_offset} exceeds selected item count ${selected.length}.`,
					);
				}
				const batch = selected.slice(batch_offset, batch_offset + batch_size);
				if (!batch.length) {
					return toolResult({
						completed: true,
						write_performed: false,
						manifest_hash: manifest.manifest_hash,
						manifest_item_count: manifest.items.length,
						selected_item_count: selected.length,
						batch_offset,
						batch_size,
						batch_item_count: 0,
						next_batch_offset: null,
						remaining_count: 0,
						results: [],
					});
				}

				const root = await findOrCreateMediaFolder(media_taxonomy_root, 0);
				const supplierFolder = await findOrCreateMediaFolder(supplier, Number(root.term.id));
				const collectionFolder = await findOrCreateMediaFolder(
					collection,
					Number(supplierFolder.term.id),
				);
				const variantFolders = new Map<string, { term: any; created: boolean }>();
				const results: any[] = [];

				for (const { item, item_key } of batch) {
					let targetFolder = collectionFolder;
					if (item.variant) {
						if (!variantFolders.has(item.variant)) {
							variantFolders.set(
								item.variant,
								await findOrCreateMediaFolder(item.variant, Number(collectionFolder.term.id)),
							);
						}
						targetFolder = variantFolders.get(item.variant)!;
					}

					const attachmentSlug = safeSlug(item.filename.replace(/\.[^.]+$/, ""));
					const existingResponse = await wpAuthenticatedFetch(
						`media?slug=${encodeURIComponent(attachmentSlug)}&per_page=100&context=edit`,
					);
					const existing = await existingResponse.json<any[]>();
					if (existing.length > 1) {
						throw new Error(`Multiple existing attachments have slug ${attachmentSlug}; stopped safely.`);
					}
					if (existing.length === 1) {
						results.push({
							status: "skipped_existing",
							item_key,
							colour: item.colour,
							variant: item.variant ?? null,
							attachment: mediaMetadata(existing[0]),
						});
						continue;
					}

					const { response: imageResponse, finalUrl } = await fetchPublicResource(
						item.image_url,
						"image/jpeg,image/png,image/webp",
					);
					const declaredLength = Number(imageResponse.headers.get("content-length") ?? 0);
					if (declaredLength > 6_000_000) throw new Error(`${item.title} exceeds the 6 MB image limit.`);
					const mimeType = (imageResponse.headers.get("content-type") ?? "")
						.split(";")[0]
						.trim()
						.toLowerCase();
					if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) {
						throw new Error(`${item.title} returned unsupported MIME type ${mimeType || "unknown"}.`);
					}
					const bytes = new Uint8Array(await imageResponse.arrayBuffer());
					if (!bytes.length || bytes.length > 6_000_000 || !hasExpectedImageSignature(bytes, mimeType)) {
						throw new Error(`${item.title} returned invalid or oversized image bytes.`);
					}
					const uploaded = await wpUploadMedia(item.filename, mimeType, bytes);
					const description = [
						`Supplier: ${supplier}`,
						`Collection: ${collection}`,
						...(item.variant ? [`Variant: ${item.variant}`] : []),
						`Colour: ${item.colour}`,
						`Source page: ${item.source_page_url}`,
						`Source image: ${finalUrl.toString()}`,
					].join("\n");
					const updateResponse = await wpAuthenticatedWrite(`media/${uploaded.id}`, {
						title: item.title,
						alt_text: item.alt_text,
						caption: item.title,
						description,
						media_folder: [Number(targetFolder.term.id)],
					});
					const verified = await updateResponse.json<any>();
					if (
						verified.id !== uploaded.id ||
						!Array.isArray(verified.media_folder) ||
						!verified.media_folder.includes(Number(targetFolder.term.id))
					) {
						throw new Error(`WordPress did not verify metadata/taxonomy assignment for ${item.title}.`);
					}
					results.push({
						status: "imported",
						item_key,
						colour: item.colour,
						variant: item.variant ?? null,
						attachment: mediaMetadata(verified),
					});
				}

				const processedThrough = batch_offset + batch.length;
				const completed = processedThrough >= selected.length;
				return toolResult({
					completed,
					manifest_hash: manifest.manifest_hash,
					manifest_item_count: manifest.items.length,
					selected_item_count: selected.length,
					batch_offset,
					batch_size,
					batch_item_count: batch.length,
					next_batch_offset: completed ? null : processedThrough,
					remaining_count: Math.max(0, selected.length - processedThrough),
					media_taxonomy: "media_folder",
					folder_path: [media_taxonomy_root, supplier, collection],
					folders_created: [
						root,
						supplierFolder,
						collectionFolder,
						...variantFolders.values(),
					].filter((folder) => folder.created).length,
					imported_count: results.filter((item) => item.status === "imported").length,
					skipped_existing_count: results.filter((item) => item.status === "skipped_existing").length,
					results,
					deleted_count: 0,
					overwritten_count: 0,
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
					link_urls: [{ website_url: META_LEAD_AD_LINK }],
					call_to_action_types: [cta_type],
					call_to_actions: [
						{
							type: cta_type,
							value: { lead_gen_form_id: lead_form_id, link: META_LEAD_AD_LINK },
						},
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
				const verifiedVideoLabels = new Set(
					(verifiedCreative.asset_feed_spec?.videos ?? []).flatMap((item: any) =>
						(item.adlabels ?? []).map((label: any) => String(label.name)),
					),
				);
				if (
					verified.status !== "PAUSED" ||
					!verifiedVideoLabels.has("video_feed_4x5") ||
					!verifiedVideoLabels.has("video_vertical_9x16") ||
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
				"Atomically switch a reviewed Spring lead campaign from delivered ads to PAUSED replacement ads using one exact intended form. By default, delivered ads must use incorrect forms. An explicit 20.5%-offer refresh may instead replace ads already using the intended form, but only when the new title, body and description all state 20.5%. Validates ownership, campaign/ad-set identity, form linkage, placement customisation and status; activates replacements, pauses old ads, verifies the final state, and never deletes history.",
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
				refresh_reason: z.literal(META_REFRESH_SPRING_OFFER_REASON).optional(),
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
			refresh_reason,
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
					if (refresh_reason) {
						const offerFields = [
							...(ad.creative?.asset_feed_spec?.titles ?? []),
							...(ad.creative?.asset_feed_spec?.bodies ?? []),
							...(ad.creative?.asset_feed_spec?.descriptions ?? []),
						].map((item: any) => String(item.text ?? ""));
						if (
							offerFields.length < 3 ||
							offerFields.some((text: string) => !text.includes("20.5%"))
						) {
							throw new Error(
								`Replacement ad ${ad.id} does not state 20.5% in its title, body and description.`,
							);
						}
					}
				}
				for (const ad of incorrect) {
					if (ad.status !== "ACTIVE")
						throw new Error(`Incorrect ad ${ad.id} is not ACTIVE.`);
					const deliveredFormIds = collectMetaLeadFormIds(ad.creative);
					if (deliveredFormIds.has(intended_form_id) && !refresh_reason) {
						throw new Error(
							`Incorrect ad ${ad.id} already uses the intended form; refusing to pause it.`,
						);
					}
					if (
						refresh_reason &&
						(deliveredFormIds.size !== 1 || !deliveredFormIds.has(intended_form_id))
					) {
						throw new Error(
							`Offer-refresh source ad ${ad.id} is not linked exclusively to the intended form.`,
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

	/* Reusable guarded product Performance Max tools. Product identity is verified
	 * against live WooCommerce and every campaign is created PAUSED. */
	const productPmaxIdentitySchema = z.object({
		product_id: z.number().int().positive(),
		expected_product_name: z.string().trim().min(3).max(200),
		campaign_label: z
			.string()
			.trim()
			.min(2)
			.max(60)
			.regex(/^[A-Za-z0-9][A-Za-z0-9 &'()-]+$/),
	});
	const productPmaxResourceSchema = productPmaxIdentitySchema.extend({
		campaign_id: z.string().regex(/^[1-9][0-9]*$/),
		asset_group_id: z.string().regex(/^[1-9][0-9]*$/),
	});
	const productPmaxBudgetSchema = z
		.number()
		.min(5)
		.max(50)
		.default(20)
		.describe("Daily campaign budget in AUD, hard-limited to A$5–A$50.");
	const productPmaxImageFieldSchema = z.enum([
		"MARKETING_IMAGE",
		"SQUARE_MARKETING_IMAGE",
		"PORTRAIT_MARKETING_IMAGE",
		"LOGO",
		"LANDSCAPE_LOGO",
	]);
	const productPmaxImageSchema = z
		.object({
			field_type: productPmaxImageFieldSchema,
			name: z.string().trim().min(1).max(82),
			source_url: z.string().url().optional(),
			existing_asset_id: z
				.string()
				.regex(/^[1-9][0-9]*$/)
				.optional(),
		})
		.superRefine((value, context) => {
			if (Boolean(value.source_url) === Boolean(value.existing_asset_id)) {
				context.addIssue({
					code: "custom",
					message: "Provide exactly one of source_url or existing_asset_id.",
				});
			}
		});
	const productPmaxBootstrapSchema = productPmaxResourceSchema
		.extend({
			headlines: z.array(z.string().trim().min(1).max(30)).min(3).max(15),
			long_headlines: z.array(z.string().trim().min(1).max(90)).min(1).max(5),
			descriptions: z.array(z.string().trim().min(1).max(90)).min(2).max(5),
			business_name: z.string().trim().min(1).max(25),
			images: z.array(productPmaxImageSchema).min(3).max(20),
			confirmation: z.literal(GOOGLE_ADS_PRODUCT_PMAX_BOOTSTRAP_CONFIRMATION),
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
						message: `At least one ${fieldType} is required.`,
					});
				}
			}
			const imageKeys = value.images.map(
				(image) =>
					`${image.field_type}\u0000${image.source_url ?? image.existing_asset_id}`,
			);
			if (new Set(imageKeys).size !== imageKeys.length) {
				context.addIssue({
					code: "custom",
					path: ["images"],
					message: "Duplicate image/field-type pairs are not allowed.",
				});
			}
		});

	server.registerTool(
		"preview_google_ads_product_pmax_paused",
		{
			description:
				"Validate a reusable one-product Blindmotion Performance Max campaign plan. Verifies the published WooCommerce product, derives its gla_<product ID> listing item and canonical URL, checks duplicate campaign names and calls Google Ads validateOnly. Never creates resources.",
			inputSchema: productPmaxIdentitySchema.extend({
				daily_budget_aud: productPmaxBudgetSchema,
			}),
		},
		async ({ product_id, expected_product_name, campaign_label, daily_budget_aud }) => {
			try {
				const identity = await getProductPmaxIdentity(
					product_id,
					expected_product_name,
					campaign_label,
				);
				const existing = await findExistingProductPmaxCampaign(identity);
				if (existing.length > 0) {
					return toolResult({
						valid_for_creation: false,
						created: false,
						reason: "A non-removed campaign already uses the derived campaign name.",
						existing_campaigns: existing.map((row) => row.campaign),
					});
				}
				const plan = productPmaxPlan(identity, daily_budget_aud);
				await googleAdsMutate(plan.mutateOperations, true);
				const { mutateOperations: _operations, ...safePlan } = plan;
				return toolResult({
					valid_for_creation: true,
					api_validation_passed: true,
					created: false,
					...safePlan,
					confirmation_required: GOOGLE_ADS_PRODUCT_PMAX_CREATE_CONFIRMATION,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"create_google_ads_product_pmax_paused",
		{
			description:
				"Create a reusable one-product Blindmotion Performance Max campaign, one asset group and a gla_<product ID>-only listing partition. Product identity and publication are verified; campaign and asset group are always PAUSED; final URL expansion is off; the tool cannot activate delivery.",
			inputSchema: productPmaxIdentitySchema.extend({
				daily_budget_aud: productPmaxBudgetSchema,
				confirmation: z.literal(GOOGLE_ADS_PRODUCT_PMAX_CREATE_CONFIRMATION),
			}),
		},
		async ({ product_id, expected_product_name, campaign_label, daily_budget_aud }) => {
			try {
				const identity = await getProductPmaxIdentity(
					product_id,
					expected_product_name,
					campaign_label,
				);
				const existing = await findExistingProductPmaxCampaign(identity);
				if (existing.length > 0) {
					throw new Error("Refusing creation: the derived campaign name already exists.");
				}
				const plan = productPmaxPlan(identity, daily_budget_aud);
				await googleAdsMutate(plan.mutateOperations, true);
				const mutation = await googleAdsMutate(plan.mutateOperations, false);
				const campaigns = await findExistingProductPmaxCampaign(identity);
				if (
					campaigns.length !== 1 ||
					campaigns[0]?.campaign?.status !== "PAUSED" ||
					campaigns[0]?.campaign?.advertisingChannelType !== "PERFORMANCE_MAX"
				) {
					throw new Error(
						"Creation returned, but the unique paused campaign could not be verified.",
					);
				}
				const campaign = campaigns[0].campaign;
				const groups = await googleAdsSearch(`
					SELECT asset_group.id, asset_group.resource_name, asset_group.name,
						asset_group.status, asset_group.final_urls, campaign.id
					FROM asset_group
					WHERE campaign.id = ${campaign.id}
					LIMIT 2
				`);
				if (
					groups.length !== 1 ||
					groups[0]?.assetGroup?.status !== "PAUSED" ||
					groups[0]?.assetGroup?.name !== identity.assetGroupName
				) {
					throw new Error(
						"Campaign was created, but its unique paused asset group failed verification.",
					);
				}
				return toolResult({
					created: true,
					activation_performed: false,
					api_validation_passed_before_creation: true,
					campaign,
					asset_group: groups[0].assetGroup,
					identity,
					daily_budget_aud,
					mutation_response_count: mutation.mutateOperationResponses?.length ?? 0,
					bootstrap_confirmation_required: GOOGLE_ADS_PRODUCT_PMAX_BOOTSTRAP_CONFIRMATION,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"inspect_google_ads_product_pmax_asset_group",
		{
			description:
				"Inspect a parametrically identified one-product Blindmotion PMax campaign and asset group. Revalidates the published WooCommerce product, canonical landing page, gla_<product ID>-only listing partition, resource identities, assets, policy state and completeness. Never mutates Google Ads.",
			inputSchema: productPmaxResourceSchema.extend({
				require_paused: z.boolean().default(true),
			}),
		},
		async ({
			product_id,
			expected_product_name,
			campaign_label,
			campaign_id,
			asset_group_id,
			require_paused,
		}) => {
			try {
				const state = await getProductPmaxAssetState({
					productId: product_id,
					expectedProductName: expected_product_name,
					campaignLabel: campaign_label,
					campaignId: campaign_id,
					assetGroupId: asset_group_id,
					requirePaused: require_paused,
				});
				return toolResult({
					...state,
					created_or_modified: false,
					activation_tool_available: false,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"bootstrap_google_ads_product_pmax_asset_group_guarded",
		{
			description:
				"Atomically create or reuse a complete initial text, Blindmotion-hosted image and brand bundle for one validated PAUSED product PMax asset group. Enforces Google limits, validates image bytes/dimensions, uses validateOnly preflight and cannot activate delivery.",
			inputSchema: productPmaxBootstrapSchema,
		},
		async ({
			product_id,
			expected_product_name,
			campaign_label,
			campaign_id,
			asset_group_id,
			headlines,
			long_headlines,
			descriptions,
			business_name,
			images,
		}) => {
			try {
				const stateArgs = {
					productId: product_id,
					expectedProductName: expected_product_name,
					campaignLabel: campaign_label,
					campaignId: campaign_id,
					assetGroupId: asset_group_id,
				};
				const before = await getProductPmaxAssetState(stateArgs);
				if (before.minimum_complete) {
					throw new Error(
						"Refusing bootstrap: this product asset group already meets minimum requirements.",
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
				for (const [fieldType, count] of Object.entries(requestedCounts)) {
					const rule =
						ZIPGRIP_ASSET_REQUIREMENTS[
							fieldType as keyof typeof ZIPGRIP_ASSET_REQUIREMENTS
						];
					if (!rule || (before.counts[fieldType] ?? 0) + count > rule.max) {
						throw new Error(`${fieldType} would exceed Google's asset limit.`);
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
					if (
						(before.counts[fieldType] ?? 0) + (requestedCounts[fieldType] ?? 0) <
						ZIPGRIP_ASSET_REQUIREMENTS[fieldType].min
					) {
						throw new Error(`${fieldType} would remain below Google's minimum.`);
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
				const assetGroupLinks: any[] = [];
				const campaignLinks: any[] = [];
				const textSummary: any[] = [];
				const imageSummary: any[] = [];
				let textTemp = -11000;
				let imageTemp = -12000;
				for (const item of textAdditions) {
					let assetResource = reusableText.get(item.text);
					const reused = Boolean(assetResource);
					if (!assetResource) {
						const currentId = textTemp--;
						assetResource = productPmaxAssetResource(String(currentId));
						assetOperations.push({
							assetOperation: {
								create: {
									resourceName: assetResource,
									name: `${campaign_label} ${item.fieldType} ${Math.abs(currentId)}`,
									textAsset: { text: item.text },
								},
							},
						});
					}
					const link = buildProductPmaxAssetLinkOperation(
						campaign_id,
						asset_group_id,
						assetResource,
						item.fieldType,
						before.brand_guidelines_enabled,
					);
					(link.campaignAssetOperation ? campaignLinks : assetGroupLinks).push(link);
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
						assetResource = productPmaxAssetResource(image.existing_asset_id);
						const rows = await googleAdsSearch(`
							SELECT asset.id, asset.resource_name, asset.type,
								asset.image_asset.full_size.width_pixels,
								asset.image_asset.full_size.height_pixels,
								asset.image_asset.file_size
							FROM asset
							WHERE asset.id = ${image.existing_asset_id}
							LIMIT 2
						`);
						if (rows.length !== 1 || rows[0]?.asset?.type !== "IMAGE") {
							throw new Error(
								`Existing asset ${image.existing_asset_id} is not a unique image.`,
							);
						}
						if (existingImageLinks.has(`${image.field_type}\u0000${assetResource}`)) {
							throw new Error("An image is already linked with that field type.");
						}
						imageInfo = validatePmaxExistingImage(
							rows[0].asset.imageAsset?.fullSize,
							image.field_type,
						);
					} else {
						const loaded = await loadBlindmotionPmaxImage(image.source_url!);
						imageInfo = validateZipGripImage(
							loaded.bytes,
							loaded.mimeType,
							image.field_type,
						);
						const digest = await sha256Hex(loaded.bytes);
						const currentId = imageTemp--;
						assetResource = productPmaxAssetResource(String(currentId));
						assetOperations.push({
							assetOperation: {
								create: {
									resourceName: assetResource,
									name: `${image.name} ${digest.slice(0, 12)}`,
									imageAsset: { data: loaded.imageBase64 },
								},
							},
						});
					}
					const link = buildProductPmaxAssetLinkOperation(
						campaign_id,
						asset_group_id,
						assetResource,
						image.field_type,
						before.brand_guidelines_enabled,
					);
					(link.campaignAssetOperation ? campaignLinks : assetGroupLinks).push(link);
					imageSummary.push({
						field_type: image.field_type,
						name: image.name,
						source_url: image.source_url ?? null,
						existing_asset_id: image.existing_asset_id ?? null,
						image: imageInfo,
					});
				}
				const operations = [...assetOperations, ...assetGroupLinks, ...campaignLinks];
				await googleAdsMutate(operations, true);
				const mutation = await googleAdsMutate(operations, false);
				const after = await getProductPmaxAssetState(stateArgs);
				if (!after.minimum_complete) {
					throw new Error(
						"Bootstrap returned, but the asset group is not complete. Manual review is required.",
					);
				}
				return toolResult({
					bootstrapped: true,
					activation_performed: false,
					api_validation_passed_before_creation: true,
					text_assets: textSummary,
					image_assets: imageSummary,
					completeness: after.completeness,
					google_ad_strength: after.asset_group?.adStrength,
					mutation_response_count: mutation.mutateOperationResponses?.length ?? 0,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"link_google_ads_product_pmax_youtube_assets_guarded",
		{
			description:
				"Create or reuse YouTube assets and link them only to a parametrically validated PAUSED one-product PMax asset group. Uses validateOnly preflight and cannot activate delivery.",
			inputSchema: productPmaxResourceSchema.extend({
				videos: z
					.array(
						z.object({
							youtube_video_id: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
							name: z.string().trim().min(1).max(82),
						}),
					)
					.min(1)
					.max(15),
				confirmation: z.literal(GOOGLE_ADS_PRODUCT_PMAX_VIDEO_CONFIRMATION),
			}),
		},
		async ({
			product_id,
			expected_product_name,
			campaign_label,
			campaign_id,
			asset_group_id,
			videos,
		}) => {
			try {
				const stateArgs = {
					productId: product_id,
					expectedProductName: expected_product_name,
					campaignLabel: campaign_label,
					campaignId: campaign_id,
					assetGroupId: asset_group_id,
				};
				const before = await getProductPmaxAssetState(stateArgs);
				if (new Set(videos.map((video) => video.youtube_video_id)).size !== videos.length) {
					throw new Error("Duplicate YouTube video IDs are not allowed.");
				}
				const linked = new Set(
					before.asset_group_assets
						.filter((row: any) => row.assetGroupAsset?.fieldType === "YOUTUBE_VIDEO")
						.map((row: any) => row.asset?.youtubeVideoAsset?.youtubeVideoId),
				);
				const additions = videos.filter((video) => !linked.has(video.youtube_video_id));
				if (additions.length === 0) {
					return toolResult({
						created_or_linked: false,
						reason: "Every supplied video is already linked.",
						activation_performed: false,
					});
				}
				if (
					(before.counts.YOUTUBE_VIDEO ?? 0) + additions.length >
					ZIPGRIP_ASSET_REQUIREMENTS.YOUTUBE_VIDEO.max
				) {
					throw new Error("The request would exceed Google's YouTube asset limit.");
				}
				const reusable = await reusableYoutubeAssets();
				const operations: any[] = [];
				const summary: any[] = [];
				let tempId = -13000;
				for (const video of additions) {
					let assetResource = reusable.get(video.youtube_video_id);
					const reused = Boolean(assetResource);
					if (!assetResource) {
						const currentId = tempId--;
						assetResource = productPmaxAssetResource(String(currentId));
						operations.push({
							assetOperation: {
								create: {
									resourceName: assetResource,
									name: `${campaign_label} ${video.name}`,
									youtubeVideoAsset: {
										youtubeVideoId: video.youtube_video_id,
									},
								},
							},
						});
					}
					operations.push(
						buildProductPmaxAssetLinkOperation(
							campaign_id,
							asset_group_id,
							assetResource,
							"YOUTUBE_VIDEO",
							before.brand_guidelines_enabled,
						),
					);
					summary.push({
						youtube_video_id: video.youtube_video_id,
						name: video.name,
						reused_existing_asset: reused,
					});
				}
				await googleAdsMutate(operations, true);
				const mutation = await googleAdsMutate(operations, false);
				const after = await getProductPmaxAssetState(stateArgs);
				return toolResult({
					created_or_linked: true,
					activation_performed: false,
					api_validation_passed_before_creation: true,
					videos: summary,
					google_ad_strength: after.asset_group?.adStrength,
					mutation_response_count: mutation.mutateOperationResponses?.length ?? 0,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/* Guarded Google Ads creation tools. They can only build a PAUSED ZipGrip draft.
	 * Kept for backwards compatibility while callers migrate to the reusable tools. */

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
		"get_google_ads_zipgrip_post_launch_status",
		{
			description:
				"Read-only post-launch inspection of the locked ZipGrip campaign and asset group, including live statuses, asset policy/completeness, dedicated gla_1301 targeting and source-campaign exclusions. Never mutates Google Ads.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				assertZipGripGoogleAdsAccount();
				const state = await getZipGripAssetState(false);
				const dedicatedTree = await googleAdsSearch(`
					SELECT campaign.id, asset_group.id,
						asset_group_listing_group_filter.resource_name,
						asset_group_listing_group_filter.parent_listing_group_filter,
						asset_group_listing_group_filter.type,
						asset_group_listing_group_filter.case_value.product_item_id.value
					FROM asset_group_listing_group_filter
					WHERE campaign.id = ${GOOGLE_ADS_ZIPGRIP_CAMPAIGN_ID}
						AND asset_group.id = ${GOOGLE_ADS_ZIPGRIP_ASSET_GROUP_ID}
				`);
				const sourcePmaxItems = await googleAdsSearch(`
					SELECT campaign.id, asset_group.id,
						asset_group_listing_group_filter.resource_name,
						asset_group_listing_group_filter.parent_listing_group_filter,
						asset_group_listing_group_filter.type,
						asset_group_listing_group_filter.case_value.product_item_id.value
					FROM asset_group_listing_group_filter
					WHERE campaign.id = ${GOOGLE_ADS_ZIPGRIP_SOURCE_PMAX_ID}
						AND asset_group_listing_group_filter.case_value.product_item_id.value =
							'${GOOGLE_ADS_ZIPGRIP_ITEM_ID}'
				`);
				const sourceShoppingItems = await googleAdsSearch(`
					SELECT campaign.id, ad_group.id,
						ad_group_criterion.resource_name,
						ad_group_criterion.negative, ad_group_criterion.status,
						ad_group_criterion.listing_group.type,
						ad_group_criterion.listing_group.parent_ad_group_criterion,
						ad_group_criterion.listing_group.case_value.product_item_id.value
					FROM ad_group_criterion
					WHERE campaign.id IN (${GOOGLE_ADS_ZIPGRIP_SOURCE_SHOPPING_IDS.join(", ")})
						AND ad_group_criterion.type = 'LISTING_GROUP'
						AND ad_group_criterion.status != 'REMOVED'
						AND ad_group_criterion.listing_group.case_value.product_item_id.value =
							'${GOOGLE_ADS_ZIPGRIP_ITEM_ID}'
				`);
				const policyProblems = state.asset_group_assets.filter((row) => {
					const approval = row.assetGroupAsset?.policySummary?.approvalStatus;
					const review = row.assetGroupAsset?.policySummary?.reviewStatus;
					return (
						(approval && approval !== "APPROVED") ||
						(review && !["REVIEWED", "EXEMPT"].includes(review))
					);
				});
				const dedicatedIncluded = dedicatedTree.filter(
					(row) =>
						row.assetGroupListingGroupFilter?.caseValue?.productItemId?.value ===
							GOOGLE_ADS_ZIPGRIP_ITEM_ID &&
						row.assetGroupListingGroupFilter?.type === "UNIT_INCLUDED",
				);
				const pmaxExcluded = sourcePmaxItems.filter(
					(row) => row.assetGroupListingGroupFilter?.type === "UNIT_EXCLUDED",
				);
				const shoppingExcluded = sourceShoppingItems.filter(
					(row) =>
						row.adGroupCriterion?.negative === true &&
						row.adGroupCriterion?.listingGroup?.type === "UNIT",
				);
				return toolResult({
					created_or_modified: false,
					campaign: state.campaign,
					asset_group: state.asset_group,
					minimum_complete: state.minimum_complete,
					counts: state.counts,
					policy_problem_count: policyProblems.length,
					dedicated_gla_1301_included: dedicatedIncluded.length === 1,
					source_pmax_gla_1301_excluded: pmaxExcluded.length === 1,
					source_shopping_gla_1301_excluded:
						shoppingExcluded.length === GOOGLE_ADS_ZIPGRIP_SOURCE_SHOPPING_IDS.length,
					dedicated_tree: dedicatedTree,
					source_pmax_item_nodes: sourcePmaxItems,
					source_shopping_item_nodes: sourceShoppingItems,
					serving_ready:
						state.campaign?.status === "ENABLED" &&
						state.asset_group?.status === "ENABLED" &&
						state.minimum_complete &&
						policyProblems.length === 0 &&
						dedicatedIncluded.length === 1 &&
						pmaxExcluded.length === 1 &&
						shoppingExcluded.length === GOOGLE_ADS_ZIPGRIP_SOURCE_SHOPPING_IDS.length,
					repair_confirmation_required:
						state.campaign?.status === "ENABLED" &&
						state.asset_group?.status === "PAUSED"
							? GOOGLE_ADS_ZIPGRIP_ASSET_GROUP_REPAIR_CONFIRMATION
							: null,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"enable_google_ads_zipgrip_asset_group_guarded",
		{
			description:
				"Enable only the locked ZipGrip asset group after launch when its campaign is already ENABLED but the asset group remains PAUSED. Requires approved complete assets, correct dedicated gla_1301 targeting, verified exclusions in all three source campaigns, exact confirmation and validateOnly. Cannot change campaign status, budget, bidding, targeting or product trees.",
			inputSchema: z.object({
				confirmation: z.literal(GOOGLE_ADS_ZIPGRIP_ASSET_GROUP_REPAIR_CONFIRMATION),
			}),
		},
		async () => {
			try {
				assertZipGripGoogleAdsAccount();
				const state = await getZipGripAssetState(false);
				if (
					state.campaign?.status !== "ENABLED" ||
					state.asset_group?.status !== "PAUSED"
				) {
					throw new Error(
						"Refusing repair: the locked campaign must be ENABLED and its locked asset group must be PAUSED.",
					);
				}
				if (!state.minimum_complete) {
					throw new Error(
						"Refusing repair: the ZipGrip asset group is not creatively complete.",
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
						"Refusing repair: one or more ZipGrip assets is not fully approved.",
					);
				}
				const dedicated = await googleAdsSearch(`
					SELECT asset_group_listing_group_filter.type,
						asset_group_listing_group_filter.case_value.product_item_id.value
					FROM asset_group_listing_group_filter
					WHERE campaign.id = ${GOOGLE_ADS_ZIPGRIP_CAMPAIGN_ID}
						AND asset_group.id = ${GOOGLE_ADS_ZIPGRIP_ASSET_GROUP_ID}
				`);
				const pmaxSource = await googleAdsSearch(`
					SELECT asset_group_listing_group_filter.type,
						asset_group_listing_group_filter.case_value.product_item_id.value
					FROM asset_group_listing_group_filter
					WHERE campaign.id = ${GOOGLE_ADS_ZIPGRIP_SOURCE_PMAX_ID}
						AND asset_group_listing_group_filter.case_value.product_item_id.value =
							'${GOOGLE_ADS_ZIPGRIP_ITEM_ID}'
				`);
				const shoppingSource = await googleAdsSearch(`
					SELECT campaign.id, ad_group_criterion.negative,
						ad_group_criterion.listing_group.type,
						ad_group_criterion.listing_group.case_value.product_item_id.value
					FROM ad_group_criterion
					WHERE campaign.id IN (${GOOGLE_ADS_ZIPGRIP_SOURCE_SHOPPING_IDS.join(", ")})
						AND ad_group_criterion.type = 'LISTING_GROUP'
						AND ad_group_criterion.status != 'REMOVED'
						AND ad_group_criterion.listing_group.case_value.product_item_id.value =
							'${GOOGLE_ADS_ZIPGRIP_ITEM_ID}'
				`);
				const dedicatedOk =
					dedicated.filter(
						(row) =>
							row.assetGroupListingGroupFilter?.caseValue?.productItemId?.value ===
								GOOGLE_ADS_ZIPGRIP_ITEM_ID &&
							row.assetGroupListingGroupFilter?.type === "UNIT_INCLUDED",
					).length === 1;
				const pmaxOk =
					pmaxSource.filter(
						(row) => row.assetGroupListingGroupFilter?.type === "UNIT_EXCLUDED",
					).length === 1;
				const shoppingCampaigns = new Set(
					shoppingSource
						.filter(
							(row) =>
								row.adGroupCriterion?.negative === true &&
								row.adGroupCriterion?.listingGroup?.type === "UNIT",
						)
						.map((row) => String(row.campaign?.id)),
				);
				if (
					!dedicatedOk ||
					!pmaxOk ||
					shoppingCampaigns.size !== GOOGLE_ADS_ZIPGRIP_SOURCE_SHOPPING_IDS.length
				) {
					throw new Error(
						"Refusing repair: ZipGrip targeting or source exclusions are not in the expected post-launch state.",
					);
				}
				const operation = {
					assetGroupOperation: {
						update: {
							resourceName: zipGripAssetGroupResource(),
							status: "ENABLED",
						},
						updateMask: "status",
					},
				};
				await googleAdsMutate([operation], true);
				const mutation = await googleAdsMutate([operation], false);
				const verified = await googleAdsSearch(`
					SELECT campaign.id, campaign.status, asset_group.id, asset_group.status
					FROM asset_group
					WHERE campaign.id = ${GOOGLE_ADS_ZIPGRIP_CAMPAIGN_ID}
						AND asset_group.id = ${GOOGLE_ADS_ZIPGRIP_ASSET_GROUP_ID}
					LIMIT 1
				`);
				if (
					verified.length !== 1 ||
					verified[0]?.campaign?.status !== "ENABLED" ||
					verified[0]?.assetGroup?.status !== "ENABLED"
				) {
					throw new Error("Asset-group repair returned but did not verify as ENABLED.");
				}
				return toolResult({
					repaired: true,
					api_validation_passed_before_mutation: true,
					campaign: verified[0].campaign,
					asset_group: verified[0].assetGroup,
					daily_budget_changed: false,
					campaign_status_changed: false,
					product_trees_changed: false,
					mutation_response_count: mutation.mutateOperationResponses?.length ?? 0,
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
					source_pmax_listing_tree: summarizeZipGripPmaxTree(plan.sourcePmaxFilters),
					source_shopping_listing_trees: summarizeZipGripShoppingTree(
						plan.sourceShoppingCriteria,
					),
					confirmation_required: GOOGLE_ADS_ZIPGRIP_LAUNCH_CONFIRMATION,
				});
			} catch (error) {
				const diagnostics = (
					error as {
						zipGripLaunchDiagnostics?: Record<string, unknown>;
					}
				)?.zipGripLaunchDiagnostics;
				if (diagnostics) {
					return toolResult({
						valid_for_launch: false,
						api_validation_passed: false,
						created_or_modified: false,
						blocker: error instanceof Error ? error.message : "Unknown launch blocker",
						...diagnostics,
					});
				}
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"launch_google_ads_zipgrip_exclusively_guarded",
		{
			description:
				"Atomically exclude gla_1301 from the three locked existing campaign trees. In source PMax, safely subdivides only the exact Outdoor blinds > zip sided outdoor blinds leaf when needed and preserves an included catch-all child; in Shopping, replaces only explicit gla_1301 units. Preserves all unrelated roots, siblings and bids, requires full asset approval, exact confirmation and validateOnly preflight.",
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

	/* Read-only Google Search Console reporting tools */

	const searchConsoleDateSchema = z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO date in YYYY-MM-DD format.");
	const searchConsoleFilterSchema = z.string().trim().min(1).max(500).optional();
	const searchConsoleLimitSchema = z.number().int().min(1).max(1000).default(250);

	
	server.registerTool(
		"get_search_console_queries",
		{
			description:
				"Return Blindmotion organic Google Search queries with clicks, impressions, CTR and average position. Optionally filter to queries containing a phrase.",
			inputSchema: z.object({
				start_date: searchConsoleDateSchema,
				end_date: searchConsoleDateSchema,
				limit: searchConsoleLimitSchema,
				query_filter: searchConsoleFilterSchema,
			}),
		},
		async ({ start_date, end_date, limit, query_filter }) => {
			try {
				assertSearchConsoleDateRange(start_date, end_date);
				const dimensions: SearchConsoleDimension[] = ["query"];
				const report = await searchConsoleQuery({
					startDate: start_date,
					endDate: end_date,
					dimensions,
					rowLimit: limit,
					dimensionFilterGroups: searchConsoleFilters(query_filter, undefined),
				});
				return toolResult(
					searchConsoleReportResult(report, start_date, end_date, dimensions),
				);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_search_console_pages",
		{
			description:
				"Return Blindmotion organic Google Search landing pages with clicks, impressions, CTR and average position. Optionally filter to pages containing a phrase or path.",
			inputSchema: z.object({
				start_date: searchConsoleDateSchema,
				end_date: searchConsoleDateSchema,
				limit: searchConsoleLimitSchema,
				page_filter: searchConsoleFilterSchema,
			}),
		},
		async ({ start_date, end_date, limit, page_filter }) => {
			try {
				assertSearchConsoleDateRange(start_date, end_date);
				const dimensions: SearchConsoleDimension[] = ["page"];
				const report = await searchConsoleQuery({
					startDate: start_date,
					endDate: end_date,
					dimensions,
					rowLimit: limit,
					dimensionFilterGroups: searchConsoleFilters(undefined, page_filter),
				});
				return toolResult(
					searchConsoleReportResult(report, start_date, end_date, dimensions),
				);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_search_console_query_pages",
		{
			description:
				"Return Blindmotion organic Google Search performance by query and landing-page pair, with optional query and page filters.",
			inputSchema: z.object({
				start_date: searchConsoleDateSchema,
				end_date: searchConsoleDateSchema,
				limit: searchConsoleLimitSchema,
				query_filter: searchConsoleFilterSchema,
				page_filter: searchConsoleFilterSchema,
			}),
		},
		async ({ start_date, end_date, limit, query_filter, page_filter }) => {
			try {
				assertSearchConsoleDateRange(start_date, end_date);
				const dimensions: SearchConsoleDimension[] = ["query", "page"];
				const report = await searchConsoleQuery({
					startDate: start_date,
					endDate: end_date,
					dimensions,
					rowLimit: limit,
					dimensionFilterGroups: searchConsoleFilters(query_filter, page_filter),
				});
				return toolResult(
					searchConsoleReportResult(report, start_date, end_date, dimensions),
				);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_search_console_daily_performance",
		{
			description:
				"Return daily Blindmotion organic Google Search clicks, impressions, CTR and average position for an ISO date range.",
			inputSchema: z.object({
				start_date: searchConsoleDateSchema,
				end_date: searchConsoleDateSchema,
			}),
		},
		async ({ start_date, end_date }) => {
			try {
				assertSearchConsoleDateRange(start_date, end_date);
				const dimensions: SearchConsoleDimension[] = ["date"];
				const report = await searchConsoleQuery({
					startDate: start_date,
					endDate: end_date,
					dimensions,
					rowLimit: 5000,
				});
				const result = searchConsoleReportResult(report, start_date, end_date, dimensions);
				result.rows.sort((left: any, right: any) => left.date.localeCompare(right.date));
				return toolResult(result);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/* Read-only Google Analytics 4 reporting tools */

	
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
		"get_ga4_event_performance",
		{
			description:
				"Return read-only Blindmotion GA4 event counts by event name, source/medium and campaign for a date range, with optional exact filters for acquisition and event attribution.",
			inputSchema: z.object({
				start_date: z.string(),
				end_date: z.string(),
				source_medium: z.string().trim().min(1).max(200).optional(),
				campaign_name: z.string().trim().min(1).max(500).optional(),
				event_name: z.string().trim().min(1).max(200).optional(),
				limit: z.number().int().min(1).max(250).default(100),
			}),
		},
		async ({ start_date, end_date, source_medium, campaign_name, event_name, limit }) => {
			try {
				const filters = [
					["sessionSourceMedium", source_medium],
					["sessionCampaignName", campaign_name],
					["eventName", event_name],
				]
					.filter((entry): entry is [string, string] => Boolean(entry[1]))
					.map(([fieldName, value]) => ({
						filter: {
							fieldName,
							stringFilter: { matchType: "EXACT", value, caseSensitive: false },
						},
					}));

				const report = await ga4RunReport({
					dateRanges: [{ startDate: start_date, endDate: end_date }],
					dimensions: [
						{ name: "eventName" },
						{ name: "sessionSourceMedium" },
						{ name: "sessionCampaignName" },
					],
					metrics: [{ name: "eventCount" }, { name: "keyEvents" }],
					...(filters.length
						? { dimensionFilter: { andGroup: { expressions: filters } } }
						: {}),
					limit: String(limit),
					orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
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

	/* Generic, parameter-driven WAPF option inspection and guarded copy. */
	const genericWapfId = z.number().int().positive();
	const genericWapfIndex = z.number().int().min(0);
	const genericWapfHash = z.string().regex(/^[a-f0-9]{64}$/);
	const genericWapfConfirmation = "CONFIRM COPY PRODUCT OPTION FIELDS";

	function genericWapf(product: any) {
		const matches = (product?.meta_data ?? []).filter(
			(meta: any) => String(meta?.key) === "_wapf_fieldgroup",
		);
		if (matches.length !== 1) {
			throw new Error("Expected exactly one WAPF field group on product " + product?.id + "; found " + matches.length + ".");
		}
		const group = parseWapfFieldGroup(matches[0].value);
		if (!group || !Array.isArray(group.fields)) {
			throw new Error("Product " + product?.id + " WAPF field group is not readable.");
		}
		return { meta: matches[0], group };
	}
	async function genericWapfHashOf(value: unknown) {
		return sha256Hex(new TextEncoder().encode(JSON.stringify(value)));
	}
	function genericWapfFieldId(field: any) {
		return String(field?.id ?? field?.key ?? "").trim();
	}
	function genericWapfLabel(field: any) {
		return wapfFieldLabel(field).toLocaleLowerCase().replace(/\s+/g, " ").trim();
	}
	function genericWapfReplace(value: unknown, replacements: Map<string, string>): unknown {
		if (typeof value === "string") {
			let output = value;
			for (const [from, to] of [...replacements.entries()].sort((a, b) => b[0].length - a[0].length)) {
				if (from && from !== to) output = output.split(from).join(to);
			}
			return output;
		}
		if (Array.isArray(value)) return value.map((item) => genericWapfReplace(item, replacements));
		if (value && typeof value === "object") {
			return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(
				([key, child]) => [key, genericWapfReplace(child, replacements)],
			));
		}
		return value;
	}
	function genericWapfIndexes(indexes: number[], count: number, role: string) {
		const unique = [...new Set(indexes)].sort((a, b) => a - b);
		for (const index of unique) {
			if (index >= count) throw new Error(role + " field index " + index + " exceeds " + (count - 1) + ".");
		}
		return unique;
	}

	const wapfImageDeliveryConfirmation = "CONFIRM APPLY WAPF IMAGE DELIVERY OPTIMISATION";
	const wapfImageDeliveryField = z.object({
		field_id: z.string().trim().min(1).max(120),
		expected_field_label: z.string().trim().min(1).max(300),
	});
	const wapfImageDeliveryInput = {
		product_id: genericWapfId,
		expected_product_name: z.string().trim().min(1).max(500),
		expected_meta_data_id: genericWapfId,
		expected_field_group_sha256: genericWapfHash,
		fields: z.array(wapfImageDeliveryField).min(1).max(30),
		target_max_dimension: z.number().int().min(200).max(1600),
		batch_offset: z.number().int().min(0).max(500).default(0),
		batch_size: z.number().int().min(1).max(10).default(10),
	};

	async function buildWapfImageDeliveryPlan(args: {
		product_id: number;
		expected_product_name: string;
		expected_meta_data_id: number;
		expected_field_group_sha256: string;
		fields: Array<{ field_id: string; expected_field_label: string }>;
		target_max_dimension: number;
		batch_offset: number;
		batch_size: number;
	}) {
		const product = await (await wcFetch("products/" + args.product_id)).json<any>();
		if (
			product.id !== args.product_id ||
			product.name !== args.expected_product_name ||
			product.status !== "draft" ||
			product.catalog_visibility !== "hidden"
		) {
			throw new Error("Product identity or draft/hidden state changed; no write performed.");
		}
		const wapf = genericWapf(product);
		const beforeHash = await genericWapfHashOf(wapf.meta.value);
		if (
			wapf.meta.id !== args.expected_meta_data_id ||
			beforeHash !== args.expected_field_group_sha256
		) {
			throw new Error("The WAPF field group changed after inspection; no write performed.");
		}
		const requestedIds = args.fields.map((field) => field.field_id);
		if (new Set(requestedIds).size !== requestedIds.length) {
			throw new Error("Duplicate field IDs in image-delivery request.");
		}
		const references: Array<{
			field_id: string;
			field_label: string;
			choice_slug: string;
			choice_label: string;
			attachment_id: number;
			current_url: string;
		}> = [];
		for (const requested of args.fields) {
			const matches = wapf.group.fields.filter(
				(field: any) => genericWapfFieldId(field) === requested.field_id,
			);
			if (matches.length !== 1) {
				throw new Error("Selected WAPF field is missing or ambiguous: " + requested.field_id);
			}
			const field = matches[0];
			if (
				wapfFieldLabel(field) !== requested.expected_field_label ||
				field.type !== "image-swatch" ||
				!Array.isArray(field.options?.choices)
			) {
				throw new Error("Selected field label, type or choices changed: " + requested.field_id);
			}
			for (const choice of field.options.choices) {
				const attachmentId = Number(choice?.attachment);
				const currentUrl = String(choice?.image ?? "");
				const choiceSlug = String(choice?.slug ?? "");
				const choiceLabel = String(choice?.label ?? "").trim();
				if (
					!Number.isInteger(attachmentId) ||
					attachmentId <= 0 ||
					!/^https:\/\//i.test(currentUrl) ||
					!choiceSlug ||
					!choiceLabel
				) {
					throw new Error("Every selected image-swatch choice needs an attachment, HTTPS image, slug and label.");
				}
				references.push({
					field_id: requested.field_id,
					field_label: requested.expected_field_label,
					choice_slug: choiceSlug,
					choice_label: choiceLabel,
					attachment_id: attachmentId,
					current_url: currentUrl,
				});
			}
		}
		if (args.batch_offset > references.length) {
			throw new Error("Batch offset exceeds the selected image count.");
		}
		const batch = references.slice(args.batch_offset, args.batch_offset + args.batch_size);
		if (!batch.length) {
			const emptyCore = {
				product_id: args.product_id,
				before_field_group_sha256: beforeHash,
				target_max_dimension: args.target_max_dimension,
				batch_offset: args.batch_offset,
				batch_size: args.batch_size,
				selected_image_count: references.length,
				items: [],
			};
			return {
				product,
				wapf,
				beforeHash,
				planCore: emptyCore,
				planHash: await genericWapfHashOf(emptyCore),
			};
		}
		const attachmentIds = [...new Set(batch.map((item) => item.attachment_id))];
		const mediaResponse = await wpAuthenticatedFetch(
			"media?include=" + attachmentIds.join(",") + "&per_page=" + attachmentIds.length + "&context=edit",
		);
		const mediaById = new Map<number, any>(
			(await mediaResponse.json<any[]>()).map((media: any) => [Number(media.id), media]),
		);
		const items = batch.map((reference) => {
			const media = mediaById.get(reference.attachment_id);
			if (!media || !String(media.mime_type ?? "").startsWith("image/")) {
				throw new Error("Selected attachment is missing or is not an image: " + reference.attachment_id);
			}
			const candidates = [
				{
					width: Number(media.media_details?.width ?? 0),
					height: Number(media.media_details?.height ?? 0),
					source_url: String(media.source_url ?? ""),
					file_size_bytes: Number(media.media_details?.filesize ?? 0) || null,
					size_name: "original",
				},
				...Object.entries(media.media_details?.sizes ?? {}).map(([sizeName, value]) => {
					const size = value as any;
					return {
						width: Number(size?.width ?? 0),
						height: Number(size?.height ?? 0),
						source_url: String(size?.source_url ?? ""),
						file_size_bytes: Number(size?.filesize ?? 0) || null,
						size_name: sizeName,
					};
				}),
			]
				.filter(
					(candidate) =>
						candidate.width > 0 &&
						candidate.height > 0 &&
						candidate.width === candidate.height &&
						candidate.width <= args.target_max_dimension &&
						/^https:\/\//i.test(candidate.source_url),
				)
				.sort((a, b) => b.width - a.width);
			if (!candidates.length) {
				throw new Error(
					"No square WordPress size at or below " +
						args.target_max_dimension +
						"px exists for attachment " +
						reference.attachment_id,
				);
			}
			const target = candidates[0];
			const targetAlt = (reference.field_label + " – " + reference.choice_label).slice(0, 500);
			return {
				...reference,
				target_url: target.source_url,
				target_width: target.width,
				target_height: target.height,
				target_size_name: target.size_name,
				target_file_size_bytes: target.file_size_bytes,
				current_alt_text: String(media.alt_text ?? ""),
				target_alt_text: targetAlt,
				url_change_required:
					normaliseImageUrl(reference.current_url) !== normaliseImageUrl(target.source_url),
				alt_change_required: String(media.alt_text ?? "") !== targetAlt,
			};
		});
		const duplicateAttachments = new Map<number, Set<string>>();
		for (const item of items) {
			const alts = duplicateAttachments.get(item.attachment_id) ?? new Set<string>();
			alts.add(item.target_alt_text);
			duplicateAttachments.set(item.attachment_id, alts);
		}
		for (const [attachmentId, alts] of duplicateAttachments) {
			if (alts.size > 1) {
				throw new Error("One attachment has conflicting option-derived alt text: " + attachmentId);
			}
		}
		const planCore = {
			product_id: args.product_id,
			before_field_group_sha256: beforeHash,
			target_max_dimension: args.target_max_dimension,
			batch_offset: args.batch_offset,
			batch_size: args.batch_size,
			selected_image_count: references.length,
			items,
		};
		return {
			product,
			wapf,
			beforeHash,
			planCore,
			planHash: await genericWapfHashOf(planCore),
		};
	}

	server.registerTool(
		"preview_wapf_image_delivery_optimisation",
		{
			description:
				"Build a deterministic, non-writing plan to switch selected image-swatch choices on one exact draft/hidden product to the largest existing square WordPress derivative at or below a caller-selected dimension, while preparing option-derived attachment alt text.",
			inputSchema: z.object(wapfImageDeliveryInput),
		},
		async (args) => {
			try {
				const plan = await buildWapfImageDeliveryPlan(args);
				return toolResult({
					write_performed: false,
					plan_sha256: plan.planHash,
					...plan.planCore,
					batch_item_count: plan.planCore.items.length,
					next_batch_offset:
						args.batch_offset + plan.planCore.items.length >= plan.planCore.selected_image_count
							? null
							: args.batch_offset + plan.planCore.items.length,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"apply_wapf_image_delivery_optimisation_guarded",
		{
			description:
				"Apply one exact previewed WAPF image-delivery batch to a draft/hidden product. Changes only selected choice image URLs to verified existing WordPress square derivatives and their attachment alt text; preserves original attachments, attachment IDs, fields, prices and conditions, verifies the result and rolls back on failure.",
			inputSchema: z.object({
				...wapfImageDeliveryInput,
				expected_plan_sha256: genericWapfHash,
				confirmation: z.literal(wapfImageDeliveryConfirmation),
			}),
		},
		async (args) => {
			try {
				const plan = await buildWapfImageDeliveryPlan(args);
				if (plan.planHash !== args.expected_plan_sha256) {
					throw new Error("The image-delivery plan changed after preview; no write performed.");
				}
				if (!plan.planCore.items.length) {
					return toolResult({
						updated: false,
						completed: true,
						plan_sha256: plan.planHash,
						before_field_group_sha256: plan.beforeHash,
						after_field_group_sha256: plan.beforeHash,
						results: [],
					});
				}
				const updatedGroup = structuredClone(plan.wapf.group);
				for (const item of plan.planCore.items) {
					const field = updatedGroup.fields.find(
						(candidate: any) => genericWapfFieldId(candidate) === item.field_id,
					);
					const choice = field?.options?.choices?.find(
						(candidate: any) => String(candidate?.slug ?? "") === item.choice_slug,
					);
					if (
						!choice ||
						Number(choice.attachment) !== item.attachment_id ||
						normaliseImageUrl(String(choice.image ?? "")) !== normaliseImageUrl(item.current_url)
					) {
						throw new Error("A selected image choice changed while building the update.");
					}
					choice.image = item.target_url;
				}
				const updatedValue =
					typeof plan.wapf.meta.value === "string"
						? JSON.stringify(updatedGroup)
						: updatedGroup;
				const expectedAfterHash = await genericWapfHashOf(updatedValue);
				const changedAlts: Array<{ attachment_id: number; old_alt_text: string }> = [];
				let productWritePerformed = false;
				try {
					if (expectedAfterHash !== plan.beforeHash) {
						await wcWrite("products/" + args.product_id, {
							meta_data: [
								{
									id: plan.wapf.meta.id,
									key: "_wapf_fieldgroup",
									value: updatedValue,
								},
							],
						});
						productWritePerformed = true;
					}
					const uniqueItems = [
						...new Map(
							plan.planCore.items.map((item) => [item.attachment_id, item]),
						).values(),
					];
					for (const item of uniqueItems) {
						if (!item.alt_change_required) continue;
						await wpAuthenticatedWrite("media/" + item.attachment_id, {
							alt_text: item.target_alt_text,
						});
						changedAlts.push({
							attachment_id: item.attachment_id,
							old_alt_text: item.current_alt_text,
						});
					}
					const verified = await (await wcFetch("products/" + args.product_id)).json<any>();
					const verifiedHash = await genericWapfHashOf(genericWapf(verified).meta.value);
					if (
						verified.id !== args.product_id ||
						verified.name !== args.expected_product_name ||
						verified.status !== "draft" ||
						verified.catalog_visibility !== "hidden" ||
						verifiedHash !== expectedAfterHash
					) {
						throw new Error("Post-write WAPF image-delivery verification failed.");
					}
					const attachmentIds = [...new Set(plan.planCore.items.map((item) => item.attachment_id))];
					const mediaResponse = await wpAuthenticatedFetch(
						"media?include=" + attachmentIds.join(",") + "&per_page=" + attachmentIds.length + "&context=edit",
					);
					const verifiedMedia = new Map<number, any>(
						(await mediaResponse.json<any[]>()).map((media: any) => [Number(media.id), media]),
					);
					for (const item of plan.planCore.items) {
						if (String(verifiedMedia.get(item.attachment_id)?.alt_text ?? "") !== item.target_alt_text) {
							throw new Error("Post-write attachment alt-text verification failed.");
						}
					}
					const processedThrough = args.batch_offset + plan.planCore.items.length;
					const completed = processedThrough >= plan.planCore.selected_image_count;
					return toolResult({
						updated: expectedAfterHash !== plan.beforeHash || changedAlts.length > 0,
						completed,
						plan_sha256: plan.planHash,
						before_field_group_sha256: plan.beforeHash,
						after_field_group_sha256: verifiedHash,
						batch_offset: args.batch_offset,
						batch_item_count: plan.planCore.items.length,
						next_batch_offset: completed ? null : processedThrough,
						results: plan.planCore.items.map((item) => ({
							field_id: item.field_id,
							choice_slug: item.choice_slug,
							attachment_id: item.attachment_id,
							target_url: item.target_url,
							target_width: item.target_width,
							target_height: item.target_height,
							alt_text: item.target_alt_text,
						})),
						original_attachments_deleted: false,
					});
				} catch (writeError) {
					const rollbackErrors: string[] = [];
					if (productWritePerformed) {
						try {
							await wcWrite("products/" + args.product_id, {
								meta_data: [
									{
										id: plan.wapf.meta.id,
										key: "_wapf_fieldgroup",
										value: plan.wapf.meta.value,
									},
								],
							});
						} catch (rollbackError) {
							rollbackErrors.push(
								"WAPF rollback: " +
									(rollbackError instanceof Error ? rollbackError.message : String(rollbackError)),
							);
						}
					}
					for (const item of changedAlts.reverse()) {
						try {
							await wpAuthenticatedWrite("media/" + item.attachment_id, {
								alt_text: item.old_alt_text,
							});
						} catch (rollbackError) {
							rollbackErrors.push(
								"Alt-text rollback " +
									item.attachment_id +
									": " +
									(rollbackError instanceof Error ? rollbackError.message : String(rollbackError)),
							);
						}
					}
					if (rollbackErrors.length) {
						throw new Error(
							"Image-delivery update failed and rollback was incomplete: " +
								rollbackErrors.join(" | "),
						);
					}
					throw new Error(
						"Image-delivery update failed; rollback succeeded: " +
							(writeError instanceof Error ? writeError.message : String(writeError)),
					);
				}
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"inspect_wapf_product_option_fields",
		{
			description:
				"Inspect caller-selected WooCommerce products for WAPF option fields. All product IDs and search terms are runtime parameters. Returns matching field summaries, indexes, pricing, choices, conditions and stable group hashes; performs no writes.",
			inputSchema: z.object({
				product_ids: z.array(genericWapfId).min(1).max(10),
				search_terms: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
			}),
		},
		async ({ product_ids, search_terms }) => {
			try {
				const ids = [...new Set(product_ids)];
				const responses = await Promise.all(ids.map((id) => wcFetch("products/" + id)));
				const products = await Promise.all(responses.map((response) => response.json<any>()));
				const terms = search_terms.map((term) => term.toLocaleLowerCase());
				return toolResult({
					read_only: true,
					search_terms,
					products: await Promise.all(products.map(async (product) => {
						const wapf = genericWapf(product);
						return {
							product: { id: product.id, name: product.name, status: product.status, catalog_visibility: product.catalog_visibility },
							meta_data_id: wapf.meta.id,
							field_group_sha256: await genericWapfHashOf(wapf.meta.value),
							field_count: wapf.group.fields.length,
							matching_fields: wapf.group.fields.map((field: any, index: number) => ({ field, index }))
								.filter(({ field }: any) => {
									const searchable = JSON.stringify(field).toLocaleLowerCase();
									return terms.some((term) => searchable.includes(term));
								})
								.map(({ field, index }: any) => wapfFieldSummary(field, index)),
						};
					})),
					write_performed: false,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"copy_wapf_product_option_fields_guarded",
		{
			description:
				"Copy explicitly selected WAPF fields between caller-supplied WooCommerce products, preserving choices, pricing and conditions. Product identities, state hashes, source indexes, target replacement indexes and insertion point are runtime parameters. Maps external field references to unique same-label/type target fields, refuses ambiguity or collisions, changes only _wapf_fieldgroup, verifies and rolls back on failure.",
			inputSchema: z.object({
				source_product_id: genericWapfId,
				source_product_name: z.string().trim().min(1).max(500),
				target_product_id: genericWapfId,
				target_product_name: z.string().trim().min(1).max(500),
				expected_source_field_group_sha256: genericWapfHash,
				expected_target_field_group_sha256: genericWapfHash,
				source_field_indices: z.array(genericWapfIndex).min(1).max(100),
				target_field_indices_to_replace: z.array(genericWapfIndex).max(100),
				insert_at_index: genericWapfIndex,
				confirmation: z.literal(genericWapfConfirmation),
			}),
		},
		async (args) => {
			try {
				if (args.source_product_id === args.target_product_id) throw new Error("Source and target products must differ.");
				const responses = await Promise.all([
					wcFetch("products/" + args.source_product_id),
					wcFetch("products/" + args.target_product_id),
				]);
				const [source, target] = await Promise.all(responses.map((response) => response.json<any>()));
				if (source.id !== args.source_product_id || source.name !== args.source_product_name ||
					target.id !== args.target_product_id || target.name !== args.target_product_name) {
					throw new Error("A caller-supplied product identity no longer matches WooCommerce.");
				}
				const sourceWapf = genericWapf(source);
				const targetWapf = genericWapf(target);
				const [sourceHash, targetHash] = await Promise.all([
					genericWapfHashOf(sourceWapf.meta.value),
					genericWapfHashOf(targetWapf.meta.value),
				]);
				if (sourceHash !== args.expected_source_field_group_sha256 ||
					targetHash !== args.expected_target_field_group_sha256) {
					throw new Error("A WAPF field group changed after inspection; refusing write.");
				}
				const sourceIndexes = genericWapfIndexes(args.source_field_indices, sourceWapf.group.fields.length, "Source");
				const targetIndexes = genericWapfIndexes(args.target_field_indices_to_replace, targetWapf.group.fields.length, "Target");
				const removals = new Set(targetIndexes);
				const remaining = targetWapf.group.fields.filter((_field: any, index: number) => !removals.has(index));
				if (args.insert_at_index > remaining.length) throw new Error("Insertion index exceeds post-removal field count.");
				const selected = sourceIndexes.map((index) => sourceWapf.group.fields[index]);
				const selectedIds = new Set(selected.map(genericWapfFieldId).filter(Boolean));
				const remainingIds = new Set(remaining.map(genericWapfFieldId).filter(Boolean));
				for (const id of selectedIds) {
					if (remainingIds.has(id)) throw new Error("Source field ID " + id + " collides with an unremoved target field.");
				}
				const replacements = new Map<string, string>();
				for (const sourceField of sourceWapf.group.fields) {
					const sourceId = genericWapfFieldId(sourceField);
					if (!sourceId || selectedIds.has(sourceId)) continue;
					const label = genericWapfLabel(sourceField);
					const type = String(sourceField?.type ?? "");
					const candidates = remaining.filter((targetField: any) =>
						label && genericWapfLabel(targetField) === label && String(targetField?.type ?? "") === type,
					);
					if (candidates.length === 1) {
						const targetId = genericWapfFieldId(candidates[0]);
						if (targetId) replacements.set(sourceId, targetId);
					}
				}
				const selectedJson = JSON.stringify(selected);
				const unresolved = sourceWapf.group.fields.map(genericWapfFieldId).filter(
					(id: string) => id && !selectedIds.has(id) && selectedJson.includes(id) && !replacements.has(id),
				);
				if (unresolved.length) {
					throw new Error("Unmapped external source-field references: " + [...new Set(unresolved)].join(", ") + ".");
				}
				const copied = genericWapfReplace(structuredClone(selected), replacements) as any[];
				const updatedGroup = {
					...structuredClone(targetWapf.group),
					fields: [...remaining.slice(0, args.insert_at_index), ...copied, ...remaining.slice(args.insert_at_index)],
				};
				const updatedValue = typeof targetWapf.meta.value === "string" ? JSON.stringify(updatedGroup) : updatedGroup;
				const expectedUpdatedHash = await genericWapfHashOf(updatedValue);
				const originalValue = targetWapf.meta.value;
				try {
					await wcWrite("products/" + args.target_product_id, {
						meta_data: [{ id: targetWapf.meta.id, key: "_wapf_fieldgroup", value: updatedValue }],
					});
					const response = await wcFetch("products/" + args.target_product_id);
					const verified = await response.json<any>();
					const verifiedHash = await genericWapfHashOf(genericWapf(verified).meta.value);
					if (verified.id !== args.target_product_id || verified.name !== args.target_product_name ||
						verifiedHash !== expectedUpdatedHash) throw new Error("Post-write verification failed.");
					return toolResult({
						updated: true,
						source_product: { id: source.id, name: source.name },
						target_product: { id: verified.id, name: verified.name },
						source_field_indices: sourceIndexes,
						removed_target_field_indices: targetIndexes,
						insert_at_index: args.insert_at_index,
						copied_field_count: copied.length,
						external_field_id_mappings: Object.fromEntries(replacements),
						before_field_group_sha256: targetHash,
						after_field_group_sha256: verifiedHash,
						untouched: ["product status", "catalog visibility", "non-WAPF metadata", "images", "descriptions", "categories"],
					});
				} catch (writeError) {
					await wcWrite("products/" + args.target_product_id, {
						meta_data: [{ id: targetWapf.meta.id, key: "_wapf_fieldgroup", value: originalValue }],
					});
					const response = await wcFetch("products/" + args.target_product_id);
					const rolledBack = await response.json<any>();
					if (await genericWapfHashOf(genericWapf(rolledBack).meta.value) !== targetHash) {
						const rollbackError = new Error("WAPF copy and rollback verification both failed.");
						(rollbackError as any).cause = writeError;
						throw rollbackError;
					}
					const rolledBackError = new Error("WAPF copy failed; exact rollback succeeded: " +
						(writeError instanceof Error ? writeError.message : String(writeError)));
					(rolledBackError as any).cause = writeError;
					throw rolledBackError;
				}
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/* Parameter-driven curtain configurator foundation. */
	const curtainConfigKey = z.string().trim().regex(/^[a-z][a-z0-9_]{1,49}$/);
	const curtainChoiceShape = {
		key: curtainConfigKey,
		label: z.string().trim().min(1).max(200),
		price_adjustment_aud: z.number().min(0).max(100000).default(0),
		attachment_id: z.number().int().positive().optional(),
		expected_filename: z.string().trim().min(1).max(300).optional(),
	};
	const curtainChoiceSchema = z.object(curtainChoiceShape);
	const curtainSwatchSchema = z.object({
		label: z.string().trim().min(1).max(200),
		attachment_id: z.number().int().positive(),
		expected_filename: z.string().trim().min(1).max(300),
	});
	const curtainCollectionSchema = z.object({
		key: curtainConfigKey,
		label: z.string().trim().min(1).max(200),
		role: z.enum(["sheer", "blockout"]),
		price_adjustment_aud: z.number().min(0).max(100000).default(0),
		swatches: z.array(curtainSwatchSchema).min(1).max(50),
	});
	const curtainConfigurationSchema = z.object({
		...curtainChoiceShape,
		layers: z.array(z.enum(["sheer", "blockout"])).min(1).max(2),
		fixed_layer_headings: z.object({
			front: z.object({ role: z.enum(["sheer", "blockout"]), heading_key: curtainConfigKey }),
			rear: z.object({ role: z.enum(["sheer", "blockout"]), heading_key: curtainConfigKey }),
		}).optional(),
	});
	const curtainOperationSchema = z.object({
		...curtainChoiceShape,
		motorised: z.boolean(),
	});
	const curtainBuilderBaseSchema = z.object({
		product_id: z.number().int().positive(),
		expected_product_name: z.string().trim().min(1).max(500),
		new_product_name: z.string().trim().min(1).max(500),
		minimum_width_mm: z.number().int().min(100).max(10000),
		maximum_width_mm: z.number().int().min(100).max(10000),
		minimum_drop_mm: z.number().int().min(100).max(10000),
		maximum_drop_mm: z.number().int().min(100).max(10000),
		motor_brand: z.string().trim().min(1).max(100),
		configurations: z.array(curtainConfigurationSchema).min(1).max(10),
		fabric_collections: z.array(curtainCollectionSchema).min(2).max(20),
		heading_options: z.array(curtainChoiceSchema).min(1).max(10),
		stack_direction_options: z.array(curtainChoiceSchema).min(1).max(10),
		mounting_options: z.array(curtainChoiceSchema).min(1).max(10),
		operation_options: z.array(curtainOperationSchema).min(2).max(10),
		motor_power_options: z.array(curtainChoiceSchema).min(1).max(10),
		motor_position_options: z.array(curtainChoiceSchema).min(1).max(10),
		control_options: z.array(curtainChoiceSchema).min(1).max(20),
	});
	const validateCurtainBuilder = (value: z.infer<typeof curtainBuilderBaseSchema>, context: z.RefinementCtx) => {
		if (value.minimum_width_mm >= value.maximum_width_mm) {
			context.addIssue({ code: z.ZodIssueCode.custom, path: ["maximum_width_mm"], message: "Maximum width must exceed minimum width." });
		}
		if (value.minimum_drop_mm >= value.maximum_drop_mm) {
			context.addIssue({ code: z.ZodIssueCode.custom, path: ["maximum_drop_mm"], message: "Maximum drop must exceed minimum drop." });
		}
		const uniqueKeys = (items: Array<{ key: string }>, path: string) => {
			const keys = items.map((item) => item.key);
			if (new Set(keys).size !== keys.length) {
				context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: "Keys must be unique." });
			}
		};
		uniqueKeys(value.configurations, "configurations");
		uniqueKeys(value.fabric_collections, "fabric_collections");
		uniqueKeys(value.heading_options, "heading_options");
		uniqueKeys(value.stack_direction_options, "stack_direction_options");
		uniqueKeys(value.mounting_options, "mounting_options");
		uniqueKeys(value.operation_options, "operation_options");
		uniqueKeys(value.motor_power_options, "motor_power_options");
		uniqueKeys(value.motor_position_options, "motor_position_options");
		uniqueKeys(value.control_options, "control_options");
		if (!value.operation_options.some((option) => option.motorised) || !value.operation_options.some((option) => !option.motorised)) {
			context.addIssue({ code: z.ZodIssueCode.custom, path: ["operation_options"], message: "Operation choices must include both manual and motorised options." });
		}
		const visualSets: Array<[string, Array<{ attachment_id?: number; expected_filename?: string }>]> = [
			["configurations", value.configurations],
			["heading_options", value.heading_options],
			["stack_direction_options", value.stack_direction_options],
			["mounting_options", value.mounting_options],
			["operation_options", value.operation_options],
		];
		for (const [path, items] of visualSets) {
			for (const [index, item] of items.entries()) {
				if ((item.attachment_id == null) !== (item.expected_filename == null)) {
					context.addIssue({ code: z.ZodIssueCode.custom, path: [path, index], message: "Image attachment ID and expected filename must be supplied together." });
				}
			}
			const withImages = items.filter((item) => item.attachment_id != null);
			if (withImages.length > 0 && withImages.length !== items.length) {
				context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: "A visual option set must provide images for every choice or none." });
			}
		}
		for (const role of ["sheer", "blockout"] as const) {
			if (!value.fabric_collections.some((collection) => collection.role === role)) {
				context.addIssue({ code: z.ZodIssueCode.custom, path: ["fabric_collections"], message: `At least one ${role} collection is required.` });
			}
			if (!value.configurations.some((configuration) => configuration.layers.includes(role))) {
				context.addIssue({ code: z.ZodIssueCode.custom, path: ["configurations"], message: `At least one configuration must use the ${role} role.` });
			}
		}
		for (const [index, configuration] of value.configurations.entries()) {
			if (new Set(configuration.layers).size !== configuration.layers.length) {
				context.addIssue({ code: z.ZodIssueCode.custom, path: ["configurations", index], message: "A configuration cannot repeat a fabric role." });
			}
			const fixed = configuration.fixed_layer_headings;
			if (!fixed) continue;
			if (configuration.layers.length !== 2 || fixed.front.role === fixed.rear.role ||
				!configuration.layers.includes(fixed.front.role) || !configuration.layers.includes(fixed.rear.role)) {
				context.addIssue({ code: z.ZodIssueCode.custom, path: ["configurations", index, "fixed_layer_headings"], message: "Fixed front and rear headings require a two-layer configuration with both fabric roles represented once." });
			}
			for (const position of ["front", "rear"] as const) {
				if (!value.heading_options.some((heading) => heading.key === fixed[position].heading_key)) {
					context.addIssue({ code: z.ZodIssueCode.custom, path: ["configurations", index, "fixed_layer_headings", position, "heading_key"], message: "Fixed layer heading must reference a supplied heading option key." });
				}
			}
		}
		const attachmentIds = value.fabric_collections.flatMap((collection) => collection.swatches.map((swatch) => swatch.attachment_id));
		if (new Set(attachmentIds).size !== attachmentIds.length) {
			context.addIssue({ code: z.ZodIssueCode.custom, path: ["fabric_collections"], message: "Each fabric swatch attachment may appear only once." });
		}
	};
	const curtainBuilderSchema = curtainBuilderBaseSchema.superRefine(validateCurtainBuilder);
	const curtainApplySchema = curtainBuilderBaseSchema.extend({
		expected_field_group_sha256: genericWapfHash,
		expected_plan_sha256: genericWapfHash,
		confirmation: z.literal("CONFIRM APPLY CURTAIN PRODUCT CONFIGURATION"),
	}).superRefine(validateCurtainBuilder);

	type CurtainBuilderInput = z.infer<typeof curtainBuilderSchema>;
	type CurtainChoiceInput = z.infer<typeof curtainChoiceSchema>;

	async function curtainStableToken(seed: string, length: number) {
		return (await sha256Hex(new TextEncoder().encode(seed))).slice(0, length);
	}

	function curtainCondition(field: string, values: string[]) {
		return values.map((value) => ({
			rules: [{ condition: "==", value, field, generated: false }],
		}));
	}

	function curtainAndCondition(rules: Array<{ field: string; value: string }>) {
		return [{ rules: rules.map((rule) => ({ condition: "==", ...rule, generated: false })) }];
	}

	async function buildCurtainConfigurationPlan(args: CurtainBuilderInput, suppliedProduct?: any) {
		const product = suppliedProduct ?? await (await wcFetch("products/" + args.product_id)).json<any>();
		if (product.id !== args.product_id || product.name !== args.expected_product_name) {
			throw new Error("The caller-supplied curtain product identity no longer matches WooCommerce.");
		}
		if (product.status !== "draft") throw new Error("Curtain configuration can be built only on a draft product.");
		const wapf = genericWapf(product);
		const beforeHash = await genericWapfHashOf(wapf.meta.value);
		const templates = new Map<string, any>();
		for (const field of wapf.group.fields) {
			if (!templates.has(String(field?.type ?? ""))) templates.set(String(field?.type ?? ""), field);
		}
		for (const requiredType of ["text", "number", "radio", "image-swatch"]) {
			if (!templates.has(requiredType)) throw new Error("Existing WAPF group lacks a reusable " + requiredType + " field template.");
		}

		const visualChoices = [
			...args.configurations,
			...args.heading_options,
			...args.stack_direction_options,
			...args.mounting_options,
			...args.operation_options,
		].filter((choice) => choice.attachment_id != null) as Array<CurtainChoiceInput & { attachment_id: number; expected_filename: string }>;
		const requestedMedia = [
			...args.fabric_collections.flatMap((collection) => collection.swatches),
			...visualChoices,
		];
		const uniqueRequestedMedia = Array.from(new Map(requestedMedia.map((item) => [item.attachment_id, item])).values());
		const mediaById = new Map<number, any>();
		for (let index = 0; index < uniqueRequestedMedia.length; index += 100) {
			const ids = uniqueRequestedMedia.slice(index, index + 100).map((item) => item.attachment_id);
			const response = await wpFetch(`media?include=${ids.join(",")}&per_page=100`);
			for (const media of await response.json<any[]>()) mediaById.set(Number(media.id), media);
		}
		for (const requested of uniqueRequestedMedia) {
			const media = mediaById.get(requested.attachment_id);
			if (!media) throw new Error("WordPress attachment " + requested.attachment_id + " is unavailable.");
			const filename = String(media.media_details?.file ?? media.source_url ?? "").split("/").pop()?.toLocaleLowerCase();
			if (filename !== requested.expected_filename.toLocaleLowerCase()) {
				throw new Error(`Attachment ${requested.attachment_id} filename changed; expected ${requested.expected_filename}, found ${filename ?? "unknown"}.`);
			}
			if (!String(media.mime_type ?? "").startsWith("image/")) throw new Error("A selected curtain attachment is not an image.");
		}

		const fieldId = async (key: string) => curtainStableToken(`curtain-field-v2:${args.product_id}:${key}`, 13);
		const choiceSlug = async (fieldKey: string, key: string) => curtainStableToken(`curtain-choice-v2:${args.product_id}:${fieldKey}:${key}`, 5);
		const templateChoice = (type: string) => {
			const choice = templates.get(type)?.options?.choices?.[0];
			return choice ? structuredClone(choice) : {};
		};
		const visualType = (choices: CurtainChoiceInput[]) => choices.every((choice) => choice.attachment_id != null) ? "image-swatch" : "radio";
		const makeChoices = async (fieldKey: string, choices: CurtainChoiceInput[], type = "radio") => Promise.all(choices.map(async (choice) => {
			const media = choice.attachment_id == null ? null : mediaById.get(choice.attachment_id);
			return {
				...templateChoice(type),
				label: choice.label,
				slug: await choiceSlug(fieldKey, choice.key),
				pricing_type: choice.price_adjustment_aud > 0 ? "fixed" : "none",
				pricing_amount: choice.price_adjustment_aud,
				image: media?.source_url ?? null,
				attachment: choice.attachment_id ?? null,
			};
		}));
		const makeField = async (type: string, key: string, label: string, choices: any[] = [], conditionals: any[] = [], numberLimits?: { min: number; max: number }) => {
			const field = structuredClone(templates.get(type));
			field.id = await fieldId(key);
			field.type = type;
			field.label = label;
			field.required = true;
			field.pricing = { type: "fixed", amount: 0, enabled: false };
			field.conditionals = conditionals;
			delete field.conditions;
			delete field.rules;
			field.options = { ...(field.options ?? {}), choices };
			if (numberLimits) field.options = { ...field.options, min: numberLimits.min, max: numberLimits.max, step: 1 };
			return field;
		};

		const configurationFieldKey = "configuration";
		const configurationFieldId = await fieldId(configurationFieldKey);
		const configurationType = visualType(args.configurations);
		const configurationChoices = await makeChoices(configurationFieldKey, args.configurations, configurationType);
		const configurationSlugs = new Map(args.configurations.map((configuration, index) => [configuration.key, configurationChoices[index].slug]));
		const configurationValuesForRole = (role: "sheer" | "blockout") => args.configurations
			.filter((configuration) => configuration.layers.includes(role))
			.map((configuration) => configurationSlugs.get(configuration.key)!);
		const singleConfigurationValues = args.configurations
			.filter((configuration) => configuration.layers.length === 1)
			.map((configuration) => configurationSlugs.get(configuration.key)!);
		const doubleConfigurationValues = args.configurations
			.filter((configuration) => configuration.layers.length > 1)
			.map((configuration) => configurationSlugs.get(configuration.key)!);

		const operationFieldKey = "operation";
		const operationFieldId = await fieldId(operationFieldKey);
		const operationType = visualType(args.operation_options);
		const operationChoices = await makeChoices(operationFieldKey, args.operation_options, operationType);
		const motorisedOperationValues = args.operation_options
			.map((option, index) => ({ option, slug: operationChoices[index].slug }))
			.filter(({ option }) => option.motorised)
			.map(({ slug }) => slug);

		const fields: any[] = [];
		fields.push(await makeField("text", "location", "Room / Location"));
		fields.push(await makeField(configurationType, configurationFieldKey, "Curtain Configuration", configurationChoices));

		for (const role of ["sheer", "blockout"] as const) {
			const collections = args.fabric_collections.filter((collection) => collection.role === role);
			const collectionFieldKey = role + "_collection";
			const collectionFieldId = await fieldId(collectionFieldKey);
			const collectionChoices = await makeChoices(collectionFieldKey, collections.map((collection) => ({
				key: collection.key,
				label: collection.label,
				price_adjustment_aud: collection.price_adjustment_aud,
			})));
			const collectionSlugs = new Map(collections.map((collection, index) => [collection.key, collectionChoices[index].slug]));
			fields.push(await makeField("radio", collectionFieldKey, role === "sheer" ? "Sheer Fabric Collection" : "Blockout Fabric Collection", collectionChoices, curtainCondition(configurationFieldId, configurationValuesForRole(role))));
			for (const collection of collections) {
				const colourFieldKey = `${role}_${collection.key}_colour`;
				const colourChoices = await Promise.all(collection.swatches.map(async (swatch) => {
					const media = mediaById.get(swatch.attachment_id);
					return {
						...templateChoice("image-swatch"),
						label: swatch.label,
						slug: await choiceSlug(colourFieldKey, String(swatch.attachment_id)),
						pricing_type: "none",
						pricing_amount: 0,
						image: media.source_url,
						attachment: swatch.attachment_id,
					};
				}));
				const conditions = configurationValuesForRole(role).map((configurationValue) => curtainAndCondition([
					{ field: configurationFieldId, value: configurationValue },
					{ field: collectionFieldId, value: collectionSlugs.get(collection.key)! },
				])[0]);
				fields.push(await makeField("image-swatch", colourFieldKey, `${collection.label} Colours`, colourChoices, conditions));
			}
		}

		fields.push(await makeField("number", "width", "Finished Track Width (mm)", [], [], { min: args.minimum_width_mm, max: args.maximum_width_mm }));
		fields.push(await makeField("number", "drop", "Curtain Drop (mm)", [], [], { min: args.minimum_drop_mm, max: args.maximum_drop_mm }));
		const headingType = visualType(args.heading_options);
		const selectableHeadingConfigurations = args.configurations.filter((configuration) => !configuration.fixed_layer_headings);
		if (selectableHeadingConfigurations.length) {
			const conditions = selectableHeadingConfigurations.length === args.configurations.length ? [] :
				curtainCondition(configurationFieldId, selectableHeadingConfigurations.map((configuration) => configurationSlugs.get(configuration.key)!));
			fields.push(await makeField(headingType, "heading", "Heading Style", await makeChoices("heading", args.heading_options, headingType), conditions));
		}
		for (const configuration of args.configurations) {
			const fixed = configuration.fixed_layer_headings;
			if (!fixed) continue;
			const headingLabel = (key: string) => args.heading_options.find((heading) => heading.key === key)!.label;
			const pairedLabel = `Front ${fixed.front.role === "sheer" ? "Sheer" : "Blockout"}: ${headingLabel(fixed.front.heading_key)} / Rear ${fixed.rear.role === "sheer" ? "Sheer" : "Blockout"}: ${headingLabel(fixed.rear.heading_key)}`;
			const key = `fixed_heading_${configuration.key}`;
			fields.push(await makeField("radio", key, "Heading Arrangement", await makeChoices(key, [{
				key: "confirmed_pair", label: pairedLabel, price_adjustment_aud: 0,
			}]), curtainCondition(configurationFieldId, [configurationSlugs.get(configuration.key)!])));
		}
		const mountingType = visualType(args.mounting_options);
		fields.push(await makeField(mountingType, "mounting", "Track Mounting", await makeChoices("mounting", args.mounting_options, mountingType)));
		const stackType = visualType(args.stack_direction_options);
		fields.push(await makeField(stackType, "stack_direction", "Stack Direction", await makeChoices("stack_direction", args.stack_direction_options, stackType)));
		fields.push(await makeField(operationType, operationFieldKey, "Curtain Operation", operationChoices));
		fields.push(await makeField("radio", "motor_power", `${args.motor_brand} Motor Power`, await makeChoices("motor_power", args.motor_power_options), curtainCondition(operationFieldId, motorisedOperationValues)));
		if (singleConfigurationValues.length) {
			const conditions = singleConfigurationValues.flatMap((configurationValue) => motorisedOperationValues.map((operationValue) => curtainAndCondition([
				{ field: configurationFieldId, value: configurationValue },
				{ field: operationFieldId, value: operationValue },
			])[0]));
			fields.push(await makeField("radio", "single_motor_position", "Motor Position (viewed from room)", await makeChoices("single_motor_position", args.motor_position_options), conditions));
		}
		if (doubleConfigurationValues.length) {
			const conditions = doubleConfigurationValues.flatMap((configurationValue) => motorisedOperationValues.map((operationValue) => curtainAndCondition([
				{ field: configurationFieldId, value: configurationValue },
				{ field: operationFieldId, value: operationValue },
			])[0]));
			fields.push(await makeField("radio", "sheer_motor_position", "Sheer Track Motor Position (viewed from room)", await makeChoices("sheer_motor_position", args.motor_position_options), conditions));
			fields.push(await makeField("radio", "blockout_motor_position", "Blockout Track Motor Position (viewed from room)", await makeChoices("blockout_motor_position", args.motor_position_options), conditions));
		}
		fields.push(await makeField("radio", "control", "Curtain Control", await makeChoices("control", args.control_options), curtainCondition(operationFieldId, motorisedOperationValues)));

		const updatedGroup = { ...structuredClone(wapf.group), fields };
		const updatedValue = typeof wapf.meta.value === "string" ? JSON.stringify(updatedGroup) : updatedGroup;
		const afterHash = await genericWapfHashOf(updatedValue);
		const planHash = await genericWapfHashOf({
			product_id: args.product_id,
			expected_product_name: args.expected_product_name,
			new_product_name: args.new_product_name,
			before_field_group_sha256: beforeHash,
			after_field_group_sha256: afterHash,
		});
		return {
			product,
			wapf,
			updatedValue,
			beforeHash,
			afterHash,
			planHash,
			fields,
			mediaById,
		};
	}

	server.registerTool(
		"preview_curtain_product_configuration",
		{
			description:
				"Build a deterministic, non-writing plan to replace one draft product's placeholder WAPF options with a parameter-driven motorised-curtain configurator. Validates product identity, dimensions, configurations, every fabric attachment and all runtime option lists. Pricing is limited to explicit caller-supplied option adjustments; the product remains untouched.",
			inputSchema: curtainBuilderSchema,
		},
		async (args) => {
			try {
				const plan = await buildCurtainConfigurationPlan(args);
				return toolResult({
					write_performed: false,
					product: { id: plan.product.id, name: plan.product.name, status: plan.product.status, catalog_visibility: plan.product.catalog_visibility },
					planned_product: { name: args.new_product_name, status: "draft", catalog_visibility: "hidden" },
					before_field_group_sha256: plan.beforeHash,
					after_field_group_sha256: plan.afterHash,
					plan_sha256: plan.planHash,
					field_count: plan.fields.length,
					fields: plan.fields.map((field) => ({
						id: field.id,
						label: field.label,
						type: field.type,
						choice_count: field.options?.choices?.length ?? 0,
						conditional_group_count: field.conditionals?.length ?? 0,
						pricing_enabled: field.pricing?.enabled === true,
					})),
					collections: args.fabric_collections.map((collection) => ({ key: collection.key, label: collection.label, role: collection.role, swatch_count: collection.swatches.length })),
					swatch_count: args.fabric_collections.reduce((sum, collection) => sum + collection.swatches.length, 0),
					fixed_heading_arrangements: args.configurations.filter((configuration) => configuration.fixed_layer_headings).map((configuration) => ({
						configuration_key: configuration.key,
						front: configuration.fixed_layer_headings!.front,
						rear: configuration.fixed_layer_headings!.rear,
					})),
					pricing_foundation_only: true,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"apply_curtain_product_configuration_guarded",
		{
			description:
				"Apply one exact previewed motorised-curtain WAPF plan to an explicitly identified draft product. Revalidates every runtime parameter, product state, WAPF hash and fabric attachment; replaces only the WAPF field group, product name, draft status and hidden visibility; verifies and rolls back on failure. Cannot publish the product.",
			inputSchema: curtainApplySchema,
		},
		async (args) => {
			try {
				const product = await (await wcFetch("products/" + args.product_id)).json<any>();
				const plan = await buildCurtainConfigurationPlan(args, product);
				if (plan.beforeHash !== args.expected_field_group_sha256 || plan.planHash !== args.expected_plan_sha256) {
					throw new Error("The curtain product or deterministic plan changed after preview; refusing write.");
				}
				const original = {
					name: product.name,
					status: product.status,
					catalog_visibility: product.catalog_visibility,
					wapf_value: plan.wapf.meta.value,
				};
				try {
					await wcWrite("products/" + args.product_id, {
						name: args.new_product_name,
						status: "draft",
						catalog_visibility: "hidden",
						meta_data: [{ id: plan.wapf.meta.id, key: "_wapf_fieldgroup", value: plan.updatedValue }],
					});
					const verified = await (await wcFetch("products/" + args.product_id)).json<any>();
					const verifiedWapf = genericWapf(verified);
					const verifiedHash = await genericWapfHashOf(verifiedWapf.meta.value);
					if (verified.id !== args.product_id || verified.name !== args.new_product_name || verified.status !== "draft" || verified.catalog_visibility !== "hidden" || verifiedHash !== plan.afterHash) {
						throw new Error("Post-write curtain configuration verification failed.");
					}
					return toolResult({
						updated: true,
						product: { id: verified.id, name: verified.name, status: verified.status, catalog_visibility: verified.catalog_visibility },
						before_field_group_sha256: plan.beforeHash,
						after_field_group_sha256: verifiedHash,
						field_count: plan.fields.length,
						swatch_count: args.fabric_collections.reduce((sum, collection) => sum + collection.swatches.length, 0),
						collection_count: args.fabric_collections.length,
						pricing_foundation_only: true,
						untouched: ["slug", "descriptions", "categories", "featured image", "gallery", "non-WAPF metadata", "base price"],
					});
				} catch (writeError) {
					await wcWrite("products/" + args.product_id, {
						name: original.name,
						status: original.status,
						catalog_visibility: original.catalog_visibility,
						meta_data: [{ id: plan.wapf.meta.id, key: "_wapf_fieldgroup", value: original.wapf_value }],
					});
					const rolledBack = await (await wcFetch("products/" + args.product_id)).json<any>();
					const rollbackHash = await genericWapfHashOf(genericWapf(rolledBack).meta.value);
					if (rolledBack.name !== original.name || rolledBack.status !== original.status || rolledBack.catalog_visibility !== original.catalog_visibility || rollbackHash !== plan.beforeHash) {
						throw new Error("Curtain configuration write and exact rollback verification both failed.");
					}
					throw new Error("Curtain configuration write failed; exact rollback succeeded: " + (writeError instanceof Error ? writeError.message : String(writeError)));
				}
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/* Generic guarded WAPF radio-to-image-swatch conversion. Media upload is separate
	 * so a failed product write never has to re-upload the approved images. */
	const wapfVisualConfirmation = "CONFIRM APPLY WAPF IMAGE SWATCHES";
	const wapfVisualFilename = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
	const wapfVisualMime = z.enum(["image/jpeg", "image/png", "image/webp"]);
	const wapfVisualFieldId = z.string().trim().min(1).max(100);
	const wapfVisualChoiceSlug = z.string().trim().min(1).max(100);

	server.registerTool(
		"upload_wapf_choice_visual_guarded",
		{
			description:
				"Upload one approved image for an exact choice of an explicitly identified draft/hidden WooCommerce product. Verifies the unchanged WAPF hash and image digest. Uploads media only; never changes product options or deletes attachments.",
			inputSchema: z.object({
				product_id: genericWapfId,
				expected_product_name: z.string().trim().min(1).max(500),
				expected_field_group_sha256: genericWapfHash,
				field_id: wapfVisualFieldId,
				choice_slug: wapfVisualChoiceSlug,
				filename: wapfVisualFilename,
				mime_type: wapfVisualMime,
				image_base64: z.string().min(4).max(5_000_000),
				expected_image_sha256: genericWapfHash,
				confirmation: z.literal(wapfVisualConfirmation),
			}),
		},
		async (args) => {
			try {
				const product = await (await wcFetch("products/" + args.product_id)).json<any>();
				if (product.id !== args.product_id || product.name !== args.expected_product_name ||
					product.status !== "draft" || product.catalog_visibility !== "hidden") {
					throw new Error("Product identity or draft/hidden state changed; no media uploaded.");
				}
				const wapf = genericWapf(product);
				if (await genericWapfHashOf(wapf.meta.value) !== args.expected_field_group_sha256) {
					throw new Error("The WAPF field group changed after inspection; no media uploaded.");
				}
				const fields = wapf.group.fields.filter((field: any) => genericWapfFieldId(field) === args.field_id);
				if (fields.length !== 1 || fields[0].type !== "radio") throw new Error("Expected exactly one radio field with this ID.");
				const choices = fields[0].options?.choices;
				const matching = Array.isArray(choices) ? choices.filter((choice: any) => String(choice?.slug) === args.choice_slug) : [];
				if (matching.length !== 1 || matching[0]?.image || matching[0]?.attachment) {
					throw new Error("The target choice is missing, ambiguous or already has an image.");
				}
				const extensions: Record<string, string[]> = {
					"image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "image/webp": ["webp"],
				};
				const extension = args.filename.split(".").pop()?.toLowerCase() ?? "";
				if (!extensions[args.mime_type].includes(extension)) throw new Error("Filename extension and MIME type disagree.");
				const bytes = decodeBase64(args.image_base64);
				if (!bytes.length || bytes.length > 3_500_000 || !hasExpectedImageSignature(bytes, args.mime_type) ||
					await sha256Hex(bytes) !== args.expected_image_sha256) {
					throw new Error("Image bytes, type, size or reviewed SHA-256 do not match; no media uploaded.");
				}
				const media = await wpUploadMedia(args.filename, args.mime_type, bytes);
				if (!Number.isInteger(media.id) || media.id < 1 || media.mime_type !== args.mime_type ||
					typeof media.source_url !== "string" || !media.source_url.startsWith("https://")) {
					throw new Error("Upload returned an invalid media attachment; inspect WordPress before retrying.");
				}
				return toolResult({ uploaded: true, product_id: args.product_id, field_id: args.field_id,
					choice_slug: args.choice_slug, attachment_id: media.id,
					filename: String(media.media_details?.file ?? media.source_url).split("/").pop(),
					source_url: media.source_url, image_sha256: args.expected_image_sha256,
					product_modified: false });
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"apply_wapf_image_swatches_guarded",
		{
			description:
				"Convert caller-selected radio fields to image-swatch using verified existing WordPress attachments. Preserves exact field/choice IDs, labels, slugs, conditions, pricing and every unrelated WAPF field. Requires a group hash and confirmation, verifies the write and rolls back on failure; draft/hidden only.",
			inputSchema: z.object({
				product_id: genericWapfId,
				expected_product_name: z.string().trim().min(1).max(500),
				expected_meta_data_id: genericWapfId,
				expected_field_group_sha256: genericWapfHash,
				fields: z.array(z.object({
					field_id: wapfVisualFieldId,
					expected_field_label: z.string().min(1).max(300),
					choices: z.array(z.object({
						choice_slug: wapfVisualChoiceSlug,
						expected_choice_label: z.string().min(1).max(300),
						attachment_id: genericWapfId,
						expected_filename: wapfVisualFilename,
					})).min(1).max(30),
				})).min(1).max(10),
				confirmation: z.literal(wapfVisualConfirmation),
			}),
		},
		async (args) => {
			try {
				const product = await (await wcFetch("products/" + args.product_id)).json<any>();
				if (product.id !== args.product_id || product.name !== args.expected_product_name ||
					product.status !== "draft" || product.catalog_visibility !== "hidden") {
					throw new Error("Product identity or draft/hidden state changed; no write performed.");
				}
				const wapf = genericWapf(product);
				const beforeHash = await genericWapfHashOf(wapf.meta.value);
				if (wapf.meta.id !== args.expected_meta_data_id || beforeHash !== args.expected_field_group_sha256) {
					throw new Error("The WAPF field group changed after inspection; no write performed.");
				}
				const requestedIds = args.fields.map((field) => field.field_id);
				if (new Set(requestedIds).size !== requestedIds.length) throw new Error("Duplicate field IDs in conversion request.");
				const mediaRequests = args.fields.flatMap((field) => field.choices);
				if (new Set(mediaRequests.map((choice) => choice.attachment_id)).size !== mediaRequests.length) {
					throw new Error("Every choice needs its own distinct attachment.");
				}
				const updatedGroup = structuredClone(wapf.group);
				const originalFields = wapf.group.fields;
				for (const requested of args.fields) {
					const indexes = originalFields.map((field: any, index: number) => genericWapfFieldId(field) === requested.field_id ? index : -1).filter((index: number) => index >= 0);
					if (indexes.length !== 1) throw new Error("Target field ID is missing or ambiguous: " + requested.field_id);
					const original = originalFields[indexes[0]];
					if (original.type !== "radio" || wapfFieldLabel(original) !== requested.expected_field_label ||
						!Array.isArray(original.options?.choices) || original.options.choices.length !== requested.choices.length) {
						throw new Error("Target field type, label or choice count changed: " + requested.field_id);
					}
					const expectedSlugs = requested.choices.map((choice) => choice.choice_slug);
					if (new Set(expectedSlugs).size !== expectedSlugs.length) throw new Error("Duplicate choice slug in field " + requested.field_id);
					for (const originalChoice of original.options.choices) {
						const match = requested.choices.find((choice) => choice.choice_slug === String(originalChoice.slug));
						if (!match || originalChoice.label !== match.expected_choice_label || originalChoice.image || originalChoice.attachment) {
							throw new Error("Choice slug/label/image changed in field " + requested.field_id);
						}
					}
				}
				const ids = mediaRequests.map((choice) => choice.attachment_id);
				const mediaResponse = await wpFetch("media?include=" + ids.join(",") + "&per_page=" + ids.length);
				const mediaById = new Map<number, any>((await mediaResponse.json<any[]>()).map((media: any) => [Number(media.id), media]));
				for (const requested of mediaRequests) {
					const media = mediaById.get(requested.attachment_id);
					const filename = String(media?.media_details?.file ?? media?.source_url ?? "").split("/").pop();
					if (!media || !String(media.mime_type ?? "").startsWith("image/") ||
						filename?.toLowerCase() !== requested.expected_filename.toLowerCase() ||
						!String(media.source_url ?? "").startsWith("https://")) {
						throw new Error("Media attachment or filename no longer matches: " + requested.attachment_id);
					}
				}
				for (const requested of args.fields) {
					const index = originalFields.findIndex((field: any) => genericWapfFieldId(field) === requested.field_id);
					const updated = updatedGroup.fields[index];
					updated.type = "image-swatch";
					for (const choice of updated.options.choices) {
						const selected = requested.choices.find((item) => item.choice_slug === String(choice.slug))!;
						choice.image = mediaById.get(selected.attachment_id).source_url;
						choice.attachment = selected.attachment_id;
					}
				}
				const updatedValue = typeof wapf.meta.value === "string" ? JSON.stringify(updatedGroup) : updatedGroup;
				const expectedAfterHash = await genericWapfHashOf(updatedValue);
				try {
					await wcWrite("products/" + args.product_id, {
						meta_data: [{ id: wapf.meta.id, key: "_wapf_fieldgroup", value: updatedValue }],
					});
					const verified = await (await wcFetch("products/" + args.product_id)).json<any>();
					const verifiedHash = await genericWapfHashOf(genericWapf(verified).meta.value);
					if (verified.id !== args.product_id || verified.name !== args.expected_product_name ||
						verified.status !== "draft" || verified.catalog_visibility !== "hidden" || verifiedHash !== expectedAfterHash) {
						throw new Error("Post-write WAPF image-swatch verification failed.");
					}
					return toolResult({ updated: true, product_id: args.product_id, converted_field_ids: requestedIds,
						converted_choice_count: mediaRequests.length, before_field_group_sha256: beforeHash,
						after_field_group_sha256: verifiedHash,
						untouched: ["choice slugs", "choice labels", "pricing", "conditions", "unselected WAPF fields", "non-WAPF product data"] });
				} catch (writeError) {
					await wcWrite("products/" + args.product_id, {
						meta_data: [{ id: wapf.meta.id, key: "_wapf_fieldgroup", value: wapf.meta.value }],
					});
					const rolledBack = await (await wcFetch("products/" + args.product_id)).json<any>();
					if (await genericWapfHashOf(genericWapf(rolledBack).meta.value) !== beforeHash) {
						throw new Error("WAPF image-swatch write and exact rollback verification both failed.");
					}
					throw new Error("WAPF image-swatch write failed; exact rollback succeeded: " +
						(writeError instanceof Error ? writeError.message : String(writeError)));
				}
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/* Generic, deterministic WAPF field removal/replacement. This is intentionally
	 * parameter-driven: product, fields, choices, prices, conditions and media are
	 * all supplied at runtime. Remote media is content-hash locked and any product
	 * write is verified with an exact rollback. */
	const wapfPatchConfirmation = "CONFIRM APPLY WAPF FIELD RECONFIGURATION";
	const wapfPatchPricingAmount = z.union([
		z.number().finite().min(-1000000).max(1000000),
		z.string().trim().min(1).max(500),
	]);
	const wapfPatchExistingImage = z.object({
		kind: z.literal("existing_attachment"),
		attachment_id: genericWapfId,
		expected_filename: z.string().trim().min(1).max(300),
	});
	const wapfPatchRemoteImage = z.object({
		kind: z.literal("remote_image"),
		source_url: z.string().url(),
		expected_sha256: genericWapfHash,
		filename: wapfVisualFilename,
	});
	const wapfPatchImage = z.discriminatedUnion("kind", [wapfPatchExistingImage, wapfPatchRemoteImage]);
	const wapfPatchChoice = z.object({
		label: z.string().trim().min(1).max(300),
		slug: wapfVisualChoiceSlug,
		pricing_type: z.enum(["none", "fixed", "fx"]),
		pricing_amount: wapfPatchPricingAmount,
		image: wapfPatchImage,
	});
	const wapfPatchConditionRule = z.object({
		field_id: wapfVisualFieldId,
		choice_slug: wapfVisualChoiceSlug,
	});
	const wapfPatchReplacement = z.object({
		field_id: wapfVisualFieldId,
		expected_label: z.string().trim().min(1).max(300),
		expected_type: z.string().trim().min(1).max(100),
		new_label: z.string().trim().min(1).max(300),
		new_type: z.enum(["radio", "image-swatch"]),
		choices: z.array(wapfPatchChoice).min(1).max(30),
		condition_groups: z.array(z.array(wapfPatchConditionRule).min(1).max(10)).max(30),
	});
	const wapfPatchRemoval = z.object({
		field_id: wapfVisualFieldId,
		expected_label: z.string().trim().min(1).max(300),
	});
	const wapfPatchBase = z.object({
		product_id: genericWapfId,
		expected_product_name: z.string().trim().min(1).max(500),
		expected_meta_data_id: genericWapfId,
		expected_field_group_sha256: genericWapfHash,
		remove_fields: z.array(wapfPatchRemoval).max(50),
		replace_fields: z.array(wapfPatchReplacement).min(1).max(30),
	});
	type WapfPatchInput = z.infer<typeof wapfPatchBase>;
	type WapfPatchImage = z.infer<typeof wapfPatchImage>;

	function wapfPatchImageKey(image: WapfPatchImage) {
		return image.kind === "existing_attachment"
			? `attachment:${image.attachment_id}:${image.expected_filename.toLocaleLowerCase()}`
			: `remote:${image.expected_sha256}:${image.filename.toLocaleLowerCase()}:${image.source_url}`;
	}

	async function loadWapfPatchMedia(images: WapfPatchImage[], uploadRemote: boolean) {
		const unique = Array.from(new Map(images.map((image) => [wapfPatchImageKey(image), image])).values());
		const resolved = new Map<string, { attachment: number | null; source_url: string; filename: string; mime_type: string }>();
		for (const image of unique) {
			if (image.kind === "existing_attachment") {
				const media = await (await wpFetch(`media/${image.attachment_id}`)).json<any>();
				const filename = String(media?.media_details?.file ?? media?.source_url ?? "").split("/").pop();
				if (media?.id !== image.attachment_id || !String(media?.mime_type ?? "").startsWith("image/") ||
					filename?.toLocaleLowerCase() !== image.expected_filename.toLocaleLowerCase() ||
					!String(media?.source_url ?? "").startsWith("https://")) {
					throw new Error("Existing image attachment no longer matches: " + image.attachment_id + ".");
				}
				resolved.set(wapfPatchImageKey(image), { attachment: image.attachment_id, source_url: media.source_url,
					filename: filename!, mime_type: media.mime_type });
				continue;
			}
			const { response, finalUrl } = await fetchPublicResource(image.source_url, "image/jpeg,image/png,image/webp");
			const mimeType = String(response.headers.get("content-type") ?? "").split(";")[0].trim().toLocaleLowerCase();
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType) || !bytes.length ||
				bytes.length > 6_000_000 || !hasExpectedImageSignature(bytes, mimeType) ||
				await sha256Hex(bytes) !== image.expected_sha256) {
				throw new Error("Remote image bytes, type, size or SHA-256 changed: " + image.source_url + ".");
			}
			const extension = image.filename.split(".").pop()?.toLocaleLowerCase() ?? "";
			const allowedExtensions: Record<string, string[]> = {
				"image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "image/webp": ["webp"],
			};
			if (!allowedExtensions[mimeType]?.includes(extension)) throw new Error("Remote image filename and MIME type disagree.");
			let attachment: number | null = null;
			let sourceUrl = finalUrl.toString();
			let filename = image.filename;
			if (uploadRemote) {
				const slug = safeSlug(image.filename.replace(/\.[^.]+$/, ""));
				const candidates = await (await wpAuthenticatedFetch(`media?slug=${encodeURIComponent(slug)}&per_page=100&context=edit`)).json<any[]>();
				if (candidates.length > 1) throw new Error("Multiple WordPress attachments use slug " + slug + ".");
				if (candidates.length === 1) {
					const candidate = candidates[0];
					const existingUrl = String(candidate.source_url ?? "");
					const loaded = await fetchPublicResource(existingUrl, "image/jpeg,image/png,image/webp");
					const existingBytes = new Uint8Array(await loaded.response.arrayBuffer());
					if (await sha256Hex(existingBytes) !== image.expected_sha256) {
						throw new Error("Existing WordPress attachment slug has different bytes: " + slug + ".");
					}
					attachment = Number(candidate.id);
					sourceUrl = existingUrl;
					filename = String(candidate.media_details?.file ?? existingUrl).split("/").pop() ?? "";
				} else {
					const uploaded = await wpUploadMedia(image.filename, mimeType, bytes);
					attachment = Number(uploaded.id);
					sourceUrl = String(uploaded.source_url ?? "");
					filename = String(uploaded.media_details?.file ?? sourceUrl).split("/").pop() ?? "";
				}
				if (!Number.isInteger(attachment) || attachment! < 1 || !sourceUrl.startsWith("https://")) {
					throw new Error("WordPress did not return a valid imported image attachment.");
				}
			}
			resolved.set(wapfPatchImageKey(image), { attachment, source_url: sourceUrl, filename, mime_type: mimeType });
		}
		return resolved;
	}

	async function buildWapfPatchPlan(args: WapfPatchInput, uploadRemote = false, suppliedProduct?: any) {
		const product = suppliedProduct ?? await (await wcFetch("products/" + args.product_id)).json<any>();
		if (product.id !== args.product_id || product.name !== args.expected_product_name ||
			product.status !== "draft" || product.catalog_visibility !== "hidden") {
			throw new Error("Product identity or draft/hidden state changed; refusing WAPF patch.");
		}
		const wapf = genericWapf(product);
		const beforeHash = await genericWapfHashOf(wapf.meta.value);
		if (wapf.meta.id !== args.expected_meta_data_id || beforeHash !== args.expected_field_group_sha256) {
			throw new Error("The WAPF field group changed after inspection; refusing WAPF patch.");
		}
		const removeIds = args.remove_fields.map((field) => field.field_id);
		const replaceIds = args.replace_fields.map((field) => field.field_id);
		if (new Set([...removeIds, ...replaceIds]).size !== removeIds.length + replaceIds.length) {
			throw new Error("Removed and replaced field IDs must be unique and disjoint.");
		}
		for (const requested of [...args.remove_fields, ...args.replace_fields]) {
			const matches = wapf.group.fields.filter((field: any) => genericWapfFieldId(field) === requested.field_id);
			if (matches.length !== 1 || wapfFieldLabel(matches[0]) !== requested.expected_label) {
				throw new Error("Field identity changed or is ambiguous: " + requested.field_id + ".");
			}
			if ("expected_type" in requested && String(matches[0]?.type ?? "") !== requested.expected_type) {
				throw new Error("Field type changed: " + requested.field_id + ".");
			}
		}
		for (const replacement of args.replace_fields) {
			const slugs = replacement.choices.map((choice) => choice.slug);
			if (new Set(slugs).size !== slugs.length) throw new Error("Replacement choice slugs must be unique in " + replacement.field_id + ".");
			for (const choice of replacement.choices) {
				if (choice.pricing_type === "none" && String(choice.pricing_amount) !== "0") {
					throw new Error("A non-priced choice must have pricing_amount 0.");
				}
			}
		}
		const media = await loadWapfPatchMedia(args.replace_fields.flatMap((field) => field.choices.map((choice) => choice.image)), uploadRemote);
		const replacements = new Map(args.replace_fields.map((field) => [field.field_id, field]));
		const updatedFields = wapf.group.fields.filter((field: any) => !removeIds.includes(genericWapfFieldId(field))).map((field: any) => {
			const replacement = replacements.get(genericWapfFieldId(field));
			if (!replacement) return structuredClone(field);
			const updated = structuredClone(field);
			const template = structuredClone(field?.options?.choices?.[0] ?? {});
			updated.label = replacement.new_label;
			updated.type = replacement.new_type;
			updated.options = { ...(updated.options ?? {}), choices: replacement.choices.map((choice) => {
				const selected = media.get(wapfPatchImageKey(choice.image))!;
				return { ...structuredClone(template), label: choice.label, slug: choice.slug,
					pricing_type: choice.pricing_type, pricing_amount: choice.pricing_amount,
					image: selected.source_url, attachment: selected.attachment };
			}) };
			updated.conditionals = replacement.condition_groups.map((group) => ({ rules: group.map((rule) => ({
				condition: "==", value: rule.choice_slug, field: rule.field_id, generated: false,
			})) }));
			delete updated.conditions;
			delete updated.rules;
			return updated;
		});
		const serialized = JSON.stringify(updatedFields);
		for (const removedId of removeIds) {
			if (serialized.includes(removedId)) throw new Error("A remaining field still references removed field " + removedId + ".");
		}
		const fieldsById = new Map<string, any>(updatedFields.map((field: any) => [genericWapfFieldId(field), field]));
		for (const field of updatedFields) {
			for (const group of field?.conditionals ?? []) {
				for (const rule of group?.rules ?? []) {
					const source = fieldsById.get(String(rule?.field ?? ""));
					const sourceSlugs = new Set((source?.options?.choices ?? []).map((choice: any) => String(choice?.slug ?? "")));
					if (!source || !sourceSlugs.has(String(rule?.value ?? ""))) {
						throw new Error("A remaining conditional rule has an orphaned field or choice reference.");
					}
				}
			}
		}
		const updatedGroup = { ...structuredClone(wapf.group), fields: updatedFields };
		const updatedValue = typeof wapf.meta.value === "string" ? JSON.stringify(updatedGroup) : updatedGroup;
		const afterHash = uploadRemote ? await genericWapfHashOf(updatedValue) : null;
		const planHash = await genericWapfHashOf({ product_id: args.product_id, product_name: args.expected_product_name,
			before_field_group_sha256: beforeHash, remove_fields: args.remove_fields, replace_fields: args.replace_fields });
		return { product, wapf, beforeHash, afterHash, planHash, updatedFields, updatedValue };
	}

	server.registerTool(
		"preview_wapf_field_reconfiguration",
		{
			description: "Preview a parameter-driven WAPF field reconfiguration on one exact draft/hidden product. Validates field identities, complete replacement choices, prices, conditions, existing media and hash-locked remote images; detects orphaned references and performs no writes.",
			inputSchema: wapfPatchBase,
		},
		async (args) => {
			try {
				const plan = await buildWapfPatchPlan(args);
				return toolResult({ write_performed: false,
					product: { id: plan.product.id, name: plan.product.name, status: plan.product.status, catalog_visibility: plan.product.catalog_visibility },
					before_field_group_sha256: plan.beforeHash, plan_sha256: plan.planHash,
					removed_fields: args.remove_fields, replaced_fields: args.replace_fields.map((field) => ({
						field_id: field.field_id, old_label: field.expected_label, new_label: field.new_label,
						new_type: field.new_type, choice_count: field.choices.length, condition_group_count: field.condition_groups.length,
						choices: field.choices.map((choice) => ({ label: choice.label, slug: choice.slug,
							pricing_type: choice.pricing_type, pricing_amount: choice.pricing_amount, image: choice.image })),
					})),
					resulting_field_count: plan.updatedFields.length,
				});
			} catch (error) { return toolError(error); }
		},
	);

	server.registerTool(
		"apply_wapf_field_reconfiguration_guarded",
		{
			description: "Apply one exact previewed, parameter-driven WAPF field reconfiguration to a draft/hidden product. Revalidates the product hash, fields, prices, conditions and hash-locked media; uploads missing remote images, changes only the WAPF field group, verifies the exact result and rolls back on failure. Cannot publish.",
			inputSchema: wapfPatchBase.extend({ expected_plan_sha256: genericWapfHash,
				confirmation: z.literal(wapfPatchConfirmation) }),
		},
		async (args) => {
			try {
				const product = await (await wcFetch("products/" + args.product_id)).json<any>();
				const preview = await buildWapfPatchPlan(args, false, product);
				if (preview.planHash !== args.expected_plan_sha256) throw new Error("The deterministic WAPF plan changed after preview; refusing write.");
				const plan = await buildWapfPatchPlan(args, true, product);
				if (plan.planHash !== args.expected_plan_sha256 || !plan.afterHash) throw new Error("The applied WAPF plan changed while resolving media; refusing write.");
				try {
					await wcWrite("products/" + args.product_id, { meta_data: [{ id: plan.wapf.meta.id, key: "_wapf_fieldgroup", value: plan.updatedValue }] });
					const verified = await (await wcFetch("products/" + args.product_id)).json<any>();
					const verifiedHash = await genericWapfHashOf(genericWapf(verified).meta.value);
					if (verified.id !== args.product_id || verified.name !== args.expected_product_name || verified.status !== "draft" ||
						verified.catalog_visibility !== "hidden" || verifiedHash !== plan.afterHash) {
						throw new Error("Post-write WAPF field reconfiguration verification failed.");
					}
					return toolResult({ updated: true, product_id: verified.id,
						removed_field_ids: args.remove_fields.map((field) => field.field_id),
						replaced_field_ids: args.replace_fields.map((field) => field.field_id),
						before_field_group_sha256: plan.beforeHash, after_field_group_sha256: verifiedHash,
						field_count: plan.updatedFields.length,
						untouched: ["product identity", "draft/hidden state", "unselected WAPF fields", "non-WAPF product data"],
					});
				} catch (writeError) {
					await wcWrite("products/" + args.product_id, { meta_data: [{ id: plan.wapf.meta.id, key: "_wapf_fieldgroup", value: plan.wapf.meta.value }] });
					const rolledBack = await (await wcFetch("products/" + args.product_id)).json<any>();
					if (await genericWapfHashOf(genericWapf(rolledBack).meta.value) !== plan.beforeHash) {
						throw new Error("WAPF field reconfiguration and exact rollback verification both failed.");
					}
					throw new Error("WAPF field reconfiguration failed; exact rollback succeeded: " +
						(writeError instanceof Error ? writeError.message : String(writeError)));
				}
			} catch (error) { return toolError(error); }
		},
	);

	const wapfPricingGridConfirmation = "CONFIRM APPLY WAPF PRICING GRID";
	const pricingAxis = z.array(z.number().int().positive()).min(2).max(50);
	const pricingMatrix = z.array(z.array(z.number().nonnegative()).min(2).max(50)).min(2).max(50);
	const wapfPricingGridBase = z.object({
		product_id: z.number().int().positive(),
		expected_product_name: z.string().min(1),
		expected_meta_data_id: z.number().int().positive(),
		expected_field_group_sha256: genericWapfHash,
		expected_regular_price: z.number().nonnegative(),
		new_regular_price: z.number().nonnegative(),
		width_field_id: z.string().min(1),
		expected_width_field_label: z.string().min(1),
		drop_field_id: z.string().min(1),
		expected_drop_field_label: z.string().min(1),
		width_breakpoints: pricingAxis,
		drop_breakpoints: pricingAxis,
		base_price_grid: pricingMatrix,
		fabric_selector_field_id: z.string().min(1),
		expected_fabric_selector_label: z.string().min(1),
		fabric_groups: z.array(z.object({
			choice_slug: z.string().min(1),
			expected_choice_label: z.string().min(1),
			surcharge_grid: pricingMatrix,
		})).min(1).max(50),
		option_surcharges: z.array(z.object({
			field_id: z.string().min(1),
			expected_field_label: z.string().min(1),
			choice_slug: z.string().min(1),
			expected_choice_label: z.string().min(1),
			drop_breakpoints: pricingAxis,
			values: z.array(z.number().nonnegative()).min(2).max(50),
		})).max(20).default([]),
	});

	function pricingNumber(value: number) {
		if (!Number.isFinite(value) || value < 0) throw new Error("Pricing values must be finite and non-negative.");
		return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
	}

	function validatePricingAxis(values: number[], label: string) {
		for (let index = 1; index < values.length; index += 1) {
			if (values[index] <= values[index - 1]) throw new Error(label + " must be strictly ascending.");
		}
	}

	function oneDimensionalPricingFormula(fieldId: string, breakpoints: number[], values: number[]) {
		if (breakpoints.length !== values.length) throw new Error("One-dimensional surcharge values do not match their breakpoints.");
		let formula = pricingNumber(values[values.length - 1]);
		for (let index = values.length - 2; index >= 0; index -= 1) {
			formula = "if([field." + fieldId + "] <= " + breakpoints[index] + ";" +
				pricingNumber(values[index]) + ";" + formula + ")";
		}
		return formula;
	}

	function twoDimensionalPricingFormula(
		widthFieldId: string,
		dropFieldId: string,
		widths: number[],
		drops: number[],
		grid: number[][],
	) {
		if (grid.length !== widths.length || grid.some((row) => row.length !== drops.length)) {
			throw new Error("Pricing matrix dimensions do not match the width and drop axes.");
		}
		const widthFormulas = grid.map((row) => oneDimensionalPricingFormula(dropFieldId, drops, row));
		let formula = widthFormulas[widthFormulas.length - 1];
		for (let index = widthFormulas.length - 2; index >= 0; index -= 1) {
			formula = "if([field." + widthFieldId + "] <= " + widths[index] + ";" +
				widthFormulas[index] + ";" + formula + ")";
		}
		return formula;
	}

	async function buildWapfPricingGridPlan(args: z.infer<typeof wapfPricingGridBase>, productOverride?: any) {
		validatePricingAxis(args.width_breakpoints, "Width breakpoints");
		validatePricingAxis(args.drop_breakpoints, "Drop breakpoints");
		const product = productOverride ?? await (await wcFetch("products/" + args.product_id)).json<any>();
		if (product.id !== args.product_id || product.name !== args.expected_product_name) {
			throw new Error("WooCommerce product identity does not match the requested pricing target.");
		}
		if (product.status !== "draft" || product.catalog_visibility !== "hidden") {
			throw new Error("Pricing-grid writes are restricted to draft/hidden products.");
		}
		if (Number(product.regular_price) !== args.expected_regular_price) {
			throw new Error("The current regular price changed after review.");
		}
		const wapf = genericWapf(product);
		if (wapf.meta.id !== args.expected_meta_data_id) throw new Error("WAPF metadata identity changed.");
		const beforeHash = await genericWapfHashOf(wapf.meta.value);
		if (beforeHash !== args.expected_field_group_sha256) throw new Error("WAPF field group changed after review.");
		const updatedGroup = structuredClone(wapf.group);
		const fields = updatedGroup.fields as any[];
		const exactField = (id: string, label: string) => {
			const matches = fields.filter((field) => String(field.id) === id);
			if (matches.length !== 1 || String(matches[0].label) !== label) {
				throw new Error("Expected WAPF field identity not found: " + label + ".");
			}
			return matches[0];
		};
		const widthField = exactField(args.width_field_id, args.expected_width_field_label);
		const dropField = exactField(args.drop_field_id, args.expected_drop_field_label);
		if (widthField.type !== "number" || dropField.type !== "number") {
			throw new Error("Width and drop pricing fields must both be number fields.");
		}
		const baseFormula = twoDimensionalPricingFormula(
			args.width_field_id, args.drop_field_id, args.width_breakpoints, args.drop_breakpoints, args.base_price_grid,
		) + "-[price]";
		dropField.pricing = { enabled: true, type: "fx", amount: baseFormula };
		const fabricField = exactField(args.fabric_selector_field_id, args.expected_fabric_selector_label);
		const fabricChoices = fabricField.options?.choices;
		if (!Array.isArray(fabricChoices)) throw new Error("Fabric selector choices are missing.");
		const seenFabricSlugs = new Set<string>();
		for (const mapping of args.fabric_groups) {
			if (seenFabricSlugs.has(mapping.choice_slug)) throw new Error("Duplicate fabric choice slug in pricing plan.");
			seenFabricSlugs.add(mapping.choice_slug);
			const matches = fabricChoices.filter((choice: any) => String(choice.slug) === mapping.choice_slug);
			if (matches.length !== 1 || String(matches[0].label) !== mapping.expected_choice_label) {
				throw new Error("Expected fabric choice identity not found: " + mapping.expected_choice_label + ".");
			}
			const formula = twoDimensionalPricingFormula(
				args.width_field_id, args.drop_field_id, args.width_breakpoints, args.drop_breakpoints, mapping.surcharge_grid,
			);
			matches[0].pricing_type = "fx";
			matches[0].pricing_amount = formula + "*[qty]";
		}
		if (seenFabricSlugs.size !== fabricChoices.length) {
			throw new Error("The pricing plan must explicitly cover every fabric selector choice.");
		}
		for (const surcharge of args.option_surcharges) {
			validatePricingAxis(surcharge.drop_breakpoints, surcharge.expected_field_label + " drop breakpoints");
			const field = exactField(surcharge.field_id, surcharge.expected_field_label);
			const choices = field.options?.choices;
			if (!Array.isArray(choices)) throw new Error("Option surcharge field choices are missing.");
			const matches = choices.filter((choice: any) => String(choice.slug) === surcharge.choice_slug);
			if (matches.length !== 1 || String(matches[0].label) !== surcharge.expected_choice_label) {
				throw new Error("Expected surcharge choice identity not found: " + surcharge.expected_choice_label + ".");
			}
			matches[0].pricing_type = "fx";
			matches[0].pricing_amount = oneDimensionalPricingFormula(
				args.drop_field_id, surcharge.drop_breakpoints, surcharge.values,
			);
		}
		const updatedValue = typeof wapf.meta.value === "string" ? JSON.stringify(updatedGroup) : updatedGroup;
		const afterHash = await genericWapfHashOf(updatedValue);
		const planHash = await genericWapfHashOf({
			product_id: args.product_id,
			product_name: args.expected_product_name,
			before_field_group_sha256: beforeHash,
			expected_regular_price: args.expected_regular_price,
			new_regular_price: args.new_regular_price,
			width_field_id: args.width_field_id,
			drop_field_id: args.drop_field_id,
			width_breakpoints: args.width_breakpoints,
			drop_breakpoints: args.drop_breakpoints,
			base_price_grid: args.base_price_grid,
			fabric_selector_field_id: args.fabric_selector_field_id,
			fabric_groups: args.fabric_groups,
			option_surcharges: args.option_surcharges,
		});
		return { product, wapf, beforeHash, afterHash, planHash, updatedValue, baseFormula };
	}

	// Keep the legacy plan implementation available for source compatibility, but do not register its superseded tools.
	void wapfPricingGridConfirmation;
	void buildWapfPricingGridPlan;

	const wapfStorageKeyPattern = /(?:blindmotion-mcp|wapf|advanced_product_fields|acf.*option|lookup.*table|global.*price)/i;

	async function authenticatedWpRest(path: string) {
		const workerEnv = env as unknown as Record<string, string>;
		const response = await fetch(workerEnv.WC_SITE + "/wp-json/" + path.replace(/^\/+/, ""), {
			headers: { Authorization: getWpWriteAuthHeader(), Accept: "application/json" },
		});
		if (!response.ok) {
			throw new Error("Authenticated WordPress REST inspection failed: " + response.status + " " + await response.text());
		}
		return response.json<any>();
	}

	server.registerTool(
		"inspect_wapf_pricing_storage",
		{
			description: "Read-only discovery of WAPF storage plus exact runtime-selected lookup-table and ACF Global Price details through the dedicated authenticated Blindmotion bridge. Fails closed on mismatched selections, unrelated values or any write indication.",
			inputSchema: z.object({
				include_matching_setting_values: z.boolean().default(true),
				lookup_names: z
					.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/))
					.max(10)
					.default([]),
				acf_field_group_id: z.number().int().positive().optional(),
				expected_acf_field_group_title: z.string().trim().min(1).max(200).optional(),
			}),
		},
		async ({
			include_matching_setting_values,
			lookup_names,
			acf_field_group_id,
			expected_acf_field_group_title,
		}) => {
			try {
				if (new Set(lookup_names).size !== lookup_names.length) {
					throw new Error("Duplicate WAPF lookup names are not allowed.");
				}
				if ((acf_field_group_id === undefined) !== (expected_acf_field_group_title === undefined)) {
					throw new Error("ACF field-group ID and exact title must be supplied together.");
				}
				const detailRequested =
					lookup_names.length > 0 || acf_field_group_id !== undefined;
				const detailQuery = new URLSearchParams({
					lookup_names: lookup_names.join(","),
					acf_field_group_id: String(acf_field_group_id ?? 0),
					expected_acf_field_group_title: expected_acf_field_group_title ?? "",
				});
				const [root, types, settings, plugins, pricingStorage, pricingDetails] = await Promise.all([
					authenticatedWpRest(""),
					authenticatedWpRest("wp/v2/types?context=edit"),
					authenticatedWpRest("wp/v2/settings?context=edit"),
					authenticatedWpRest("wp/v2/plugins?context=edit&search=blindmotion"),
					authenticatedWpRest(
						"blindmotion-mcp/v1/wapf-pricing-storage?include_value_shapes=" +
							(include_matching_setting_values ? "true" : "false"),
					),
					detailRequested
						? authenticatedWpRest(
								"blindmotion-mcp/v1/wapf-pricing-details?" + detailQuery.toString(),
							)
						: Promise.resolve(null),
				]);
				if (
					pricingStorage?.read_only !== true ||
					pricingStorage?.raw_values_returned !== false ||
					pricingStorage?.write_performed !== false
				) {
					throw new Error("WAPF pricing bridge did not prove its read-only, no-raw-values contract.");
				}
				if (detailRequested) {
					const returnedLookupNames = Object.keys(pricingDetails?.lookups ?? {});
					if (
						pricingDetails?.read_only !== true ||
						pricingDetails?.unrelated_values_returned !== false ||
						pricingDetails?.write_performed !== false ||
						JSON.stringify(pricingDetails?.requested_lookup_names) !==
							JSON.stringify(lookup_names) ||
						JSON.stringify(returnedLookupNames) !== JSON.stringify(lookup_names) ||
						(acf_field_group_id !== undefined &&
							(pricingDetails?.acf_field_group?.id !== acf_field_group_id ||
								pricingDetails?.acf_field_group?.title !== expected_acf_field_group_title))
					) {
						throw new Error("WAPF pricing details failed exact selection or read-only verification.");
					}
				}
				const routes = Object.keys(root?.routes ?? {}).filter((key) => wapfStorageKeyPattern.test(key));
				const namespaces = (root?.namespaces ?? []).filter((key: unknown) => wapfStorageKeyPattern.test(String(key)));
				const matchingTypes = Object.fromEntries(
					Object.entries(types ?? {}).filter(([key, value]) =>
						wapfStorageKeyPattern.test(key + " " + JSON.stringify(value))),
				);
				const matchingSettings = Object.fromEntries(
					Object.entries(settings ?? {})
						.filter(([key]) => wapfStorageKeyPattern.test(key))
						.map(([key, value]) => [key, include_matching_setting_values ? value : "[redacted]"]),
				);
				return toolResult({
					read_only: true,
					namespaces,
					routes,
					post_types: matchingTypes,
					settings: matchingSettings,
					pricing_storage: pricingStorage,
					pricing_details: pricingDetails,
					plugins: (Array.isArray(plugins) ? plugins : [])
						.filter((plugin: any) =>
							/blindmotion/i.test(String(plugin?.plugin ?? "") + " " + String(plugin?.name ?? "")),
						)
						.map((plugin: any) => ({
							plugin: plugin?.plugin ?? null,
							name: plugin?.name ?? null,
							version: plugin?.version ?? null,
							status: plugin?.status ?? null,
						})),
					write_performed: false,
				});
			} catch (error) { return toolError(error); }
		},
	);

	const wapfPricingStorageHash = z.string().regex(/^[a-f0-9]{64}$/);
	const wapfPricingStorageAxis = z.array(z.number().positive().finite()).min(1).max(50);
	const wapfPricingStorageMatrix = z.array(
		z.array(z.number().min(-100000).max(100000).finite()).min(1).max(50),
	).min(1).max(50);
	const wapfPricingStorageMigration = z.object({
		expected_lookup_option_sha256: wapfPricingStorageHash,
		lookups: z.array(z.object({
			name: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
			expected_existing_sha256: wapfPricingStorageHash.optional(),
			width_breakpoints: wapfPricingStorageAxis,
			drop_breakpoints: wapfPricingStorageAxis,
			values: wapfPricingStorageMatrix,
		})).min(1).max(10),
		acf_field_group_id: z.number().int().positive(),
		expected_acf_field_group_title: z.string().min(1).max(200),
		expected_acf_field_group_post_name: z.string().min(1).max(200),
		global_prices: z.array(z.object({
			name: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
			label: z.string().min(1).max(200),
			value: z.number().min(0).max(100000).finite(),
			expected_existing_field_key: z.string().min(1).max(200).optional(),
			expected_existing_value_sha256: wapfPricingStorageHash.optional(),
		})).min(1).max(20),
	});

	server.registerTool(
		"preview_wapf_pricing_storage_migration",
		{
			description: "Preview a parameter-driven WAPF lookup-table and ACF Global Price migration through the dedicated WordPress bridge. Hash-locks the complete existing lookup option and any selected existing records; performs no writes.",
			inputSchema: wapfPricingStorageMigration,
		},
		async (args) => {
			try {
				const response = await wpMcpWrite("wapf-pricing-migration-preview", args);
				const result = await response.json<any>();
				if (
					result?.preview_only !== true ||
					result?.write_performed !== false ||
					result?.plugin?.slug !== "blindmotion-wapf-pricing-bridge" ||
					result?.plugin?.version !== "0.3.0" ||
					typeof result?.plan_sha256 !== "string"
				) {
					throw new Error("WAPF pricing bridge returned an invalid migration preview.");
				}
				return toolResult(result);
			} catch (error) { return toolError(error); }
		},
	);

	server.registerTool(
		"apply_wapf_pricing_storage_migration_guarded",
		{
			description: "Apply one exact previewed WAPF lookup-table and ACF Global Price migration through the dedicated WordPress bridge. Revalidates all hashes, verifies every write and restores lookup/global-price state on failure.",
			inputSchema: wapfPricingStorageMigration.extend({
				expected_plan_sha256: wapfPricingStorageHash,
				confirmation: z.literal("CONFIRM APPLY WAPF PRICING STORAGE"),
			}),
		},
		async (args) => {
			try {
				const response = await wpMcpWrite("wapf-pricing-migration-apply", args);
				const result = await response.json<any>();
				if (
					result?.applied !== true ||
					result?.verified !== true ||
					result?.write_performed !== true ||
					result?.rollback_performed !== false ||
					result?.plugin?.slug !== "blindmotion-wapf-pricing-bridge" ||
					result?.plugin?.version !== "0.3.0" ||
					result?.plan_sha256 !== args.expected_plan_sha256
				) {
					throw new Error("WAPF pricing bridge returned an invalid migration-apply result.");
				}
				return toolResult(result);
			} catch (error) { return toolError(error); }
		},
	);


	/* Generic, hash-locked migration from generated WAPF pricing formulas to lookup/ACF references. */
	const wapfPricingReferenceName = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
	const wapfPricingReferenceMigrationBase = z.object({
		product_id: genericWapfId,
		expected_product_name: z.string().trim().min(1).max(500),
		expected_meta_data_id: genericWapfId,
		expected_field_group_sha256: genericWapfHash,
		expected_regular_price: z.number().nonnegative().finite(),
		width_field_id: z.string().min(1),
		expected_width_field_label: z.string().min(1),
		drop_field_id: z.string().min(1),
		expected_drop_field_label: z.string().min(1),
		width_breakpoints: pricingAxis,
		drop_breakpoints: pricingAxis,
		base_price_grid: pricingMatrix,
		base_lookup: z.object({
			name: wapfPricingReferenceName,
			expected_sha256: genericWapfHash,
		}),
		fit_field_id: z.string().min(1),
		expected_fit_field_label: z.string().min(1),
		face_fit_choice_slug: z.string().min(1),
		expected_face_fit_choice_label: z.string().min(1),
		face_fit_values: z.array(z.number().nonnegative().finite()).min(2).max(50),
		face_fit_lookup: z.object({
			name: wapfPricingReferenceName,
			expected_sha256: genericWapfHash,
			width_breakpoint: z.number().positive().finite(),
		}),
		acf_field_group_id: genericWapfId,
		expected_acf_field_group_title: z.string().min(1).max(200),
		expected_acf_field_group_post_name: z.string().min(1).max(200),
		expected_lookup_option_sha256: genericWapfHash,
		global_prices: z.array(z.object({
			name: wapfPricingReferenceName,
			expected_field_key: z.string().min(1).max(200),
			expected_value_sha256: genericWapfHash,
			expected_value: z.number().nonnegative().finite(),
		})).min(1).max(20),
		fabric_selector_field_id: z.string().min(1),
		expected_fabric_selector_label: z.string().min(1),
		fabric_groups: z.array(z.object({
			choice_slug: z.string().min(1),
			expected_choice_label: z.string().min(1),
			global_price_name: wapfPricingReferenceName,
			surcharge_grid: pricingMatrix,
		})).min(1).max(50),
		waste_multiplier: z.number().positive().finite(),
		gst_multiplier: z.number().positive().finite(),
		discount_multiplier: z.number().positive().max(1).finite(),
		post_discount_gross_margin: z.number().min(0).max(0.99).finite(),
		rounding_increment: z.number().positive().finite(),
	});

	function pricingReferenceLookupValue(widths: number[], drops: number[], values: number[][]) {
		return Object.fromEntries(widths.map((width, widthIndex) => [
			String(width),
			Object.fromEntries(drops.map((drop, dropIndex) => [
				String(drop),
				values[widthIndex][dropIndex],
			])),
		]));
	}

	async function buildWapfPricingReferencePlan(
		args: z.infer<typeof wapfPricingReferenceMigrationBase>,
		productOverride?: any,
	) {
		validatePricingAxis(args.width_breakpoints, "Width breakpoints");
		validatePricingAxis(args.drop_breakpoints, "Drop breakpoints");
		if (
			args.base_price_grid.length !== args.width_breakpoints.length ||
			args.base_price_grid.some((row) => row.length !== args.drop_breakpoints.length) ||
			args.face_fit_values.length !== args.drop_breakpoints.length
		) {
			throw new Error("Pricing-reference parity matrices do not match their axes.");
		}
		const product = productOverride ?? await (await wcFetch("products/" + args.product_id)).json<any>();
		if (product.id !== args.product_id || product.name !== args.expected_product_name) {
			throw new Error("WooCommerce product identity does not match the pricing-reference target.");
		}
		if (product.status !== "draft" || product.catalog_visibility !== "hidden") {
			throw new Error("Pricing-reference writes are restricted to draft/hidden products.");
		}
		if (Number(product.regular_price) !== args.expected_regular_price) {
			throw new Error("The product regular price changed after review.");
		}
		const wapf = genericWapf(product);
		if (wapf.meta.id !== args.expected_meta_data_id) throw new Error("WAPF metadata identity changed.");
		const beforeHash = await genericWapfHashOf(wapf.meta.value);
		if (beforeHash !== args.expected_field_group_sha256) {
			throw new Error("WAPF field group changed after review.");
		}

		const lookupNames = [args.base_lookup.name, args.face_fit_lookup.name];
		if (new Set(lookupNames).size !== lookupNames.length) {
			throw new Error("Base and Face Fit lookup names must differ.");
		}
		const globalPriceNames = args.global_prices.map((item) => item.name);
		if (new Set(globalPriceNames).size !== globalPriceNames.length) {
			throw new Error("Duplicate Global Price names are not allowed.");
		}
		const detailQuery = new URLSearchParams({
			lookup_names: lookupNames.join(","),
			acf_field_group_id: String(args.acf_field_group_id),
			expected_acf_field_group_title: args.expected_acf_field_group_title,
		});
		const [storage, details] = await Promise.all([
			authenticatedWpRest("blindmotion-mcp/v1/wapf-pricing-storage?include_value_shapes=false"),
			authenticatedWpRest("blindmotion-mcp/v1/wapf-pricing-details?" + detailQuery.toString()),
		]);
		if (
			storage?.read_only !== true || storage?.write_performed !== false ||
			details?.read_only !== true || details?.write_performed !== false ||
			details?.unrelated_values_returned !== false ||
			details?.plugin?.slug !== "blindmotion-wapf-pricing-bridge" ||
			details?.plugin?.version !== "0.3.0"
		) {
			throw new Error("WAPF pricing storage did not satisfy the read-only verification contract.");
		}
		const lookupOption = (storage?.options ?? []).find(
			(option: any) => String(option?.option_name) === "wapf_imported_tables",
		);
		if (lookupOption?.value_sha256 !== args.expected_lookup_option_sha256) {
			throw new Error("The complete WAPF lookup storage changed after review.");
		}
		if (
			details?.acf_field_group?.id !== args.acf_field_group_id ||
			details?.acf_field_group?.title !== args.expected_acf_field_group_title ||
			details?.acf_field_group?.post_name !== args.expected_acf_field_group_post_name
		) {
			throw new Error("The ACF Global Prices group identity changed after review.");
		}
		const expectedLookups = [
			{
				spec: args.base_lookup,
				value: pricingReferenceLookupValue(
					args.width_breakpoints, args.drop_breakpoints, args.base_price_grid,
				),
			},
			{
				spec: args.face_fit_lookup,
				value: pricingReferenceLookupValue(
					[args.face_fit_lookup.width_breakpoint],
					args.drop_breakpoints,
					[args.face_fit_values],
				),
			},
		];
		for (const expected of expectedLookups) {
			const actual = details?.lookups?.[expected.spec.name];
			if (
				actual?.value_sha256 !== expected.spec.expected_sha256 ||
				JSON.stringify(actual?.value) !== JSON.stringify(expected.value)
			) {
				throw new Error("Lookup table content or hash changed: " + expected.spec.name + ".");
			}
		}
		const globalPriceByName = new Map<string, z.infer<typeof wapfPricingReferenceMigrationBase>["global_prices"][number]>();
		for (const expected of args.global_prices) {
			const matches = (details?.acf_field_group?.fields ?? []).filter(
				(field: any) => String(field?.name) === expected.name,
			);
			if (
				matches.length !== 1 ||
				String(matches[0]?.key) !== expected.expected_field_key ||
				matches[0]?.value_sha256 !== expected.expected_value_sha256 ||
				Number(matches[0]?.value) !== expected.expected_value
			) {
				throw new Error("Global Price content or identity changed: " + expected.name + ".");
			}
			globalPriceByName.set(expected.name, expected);
		}

		const updatedGroup = structuredClone(wapf.group);
		const fields = updatedGroup.fields as any[];
		const exactField = (id: string, label: string) => {
			const matches = fields.filter((field) => String(field?.id) === id);
			if (matches.length !== 1 || String(matches[0]?.label) !== label) {
				throw new Error("Expected WAPF field identity not found: " + label + ".");
			}
			return matches[0];
		};
		const widthField = exactField(args.width_field_id, args.expected_width_field_label);
		const dropField = exactField(args.drop_field_id, args.expected_drop_field_label);
		if (widthField.type !== "number" || dropField.type !== "number") {
			throw new Error("Width and drop pricing fields must both be number fields.");
		}
		const legacyBaseFormula = twoDimensionalPricingFormula(
			args.width_field_id,
			args.drop_field_id,
			args.width_breakpoints,
			args.drop_breakpoints,
			args.base_price_grid,
		) + "-[price]";
		if (
			dropField?.pricing?.enabled !== true ||
			dropField?.pricing?.type !== "fx" ||
			String(dropField?.pricing?.amount) !== legacyBaseFormula
		) {
			throw new Error("The current generated base-price formula no longer matches the parity grid.");
		}
		dropField.pricing = {
			enabled: true,
			type: "fx",
			amount: "lookuptable(" + args.base_lookup.name + ";" +
				args.width_field_id + ";" + args.drop_field_id + ")-[price]",
		};

		const fabricField = exactField(
			args.fabric_selector_field_id, args.expected_fabric_selector_label,
		);
		const fabricChoices = fabricField?.options?.choices;
		if (!Array.isArray(fabricChoices)) throw new Error("Fabric selector choices are missing.");
		const seenFabricSlugs = new Set<string>();
		for (const mapping of args.fabric_groups) {
			if (seenFabricSlugs.has(mapping.choice_slug)) {
				throw new Error("Duplicate fabric choice slug in pricing-reference plan.");
			}
			seenFabricSlugs.add(mapping.choice_slug);
			if (
				mapping.surcharge_grid.length !== args.width_breakpoints.length ||
				mapping.surcharge_grid.some((row) => row.length !== args.drop_breakpoints.length)
			) {
				throw new Error("Fabric surcharge parity matrix dimensions are invalid.");
			}
			const matches = fabricChoices.filter(
				(choice: any) => String(choice?.slug) === mapping.choice_slug,
			);
			if (matches.length !== 1 || String(matches[0]?.label) !== mapping.expected_choice_label) {
				throw new Error("Expected fabric choice identity not found: " + mapping.expected_choice_label + ".");
			}
			const globalPrice = globalPriceByName.get(mapping.global_price_name);
			if (!globalPrice) {
				throw new Error("Fabric choice references an unverified Global Price.");
			}
			const legacyFormula = twoDimensionalPricingFormula(
				args.width_field_id,
				args.drop_field_id,
				args.width_breakpoints,
				args.drop_breakpoints,
				mapping.surcharge_grid,
			) + "*[qty]";
			if (
				matches[0]?.pricing_type !== "fx" ||
				String(matches[0]?.pricing_amount) !== legacyFormula
			) {
				throw new Error("Current generated fabric formula changed: " + mapping.expected_choice_label + ".");
			}
			for (let widthIndex = 0; widthIndex < args.width_breakpoints.length; widthIndex += 1) {
				for (let dropIndex = 0; dropIndex < args.drop_breakpoints.length; dropIndex += 1) {
					const raw =
						(args.width_breakpoints[widthIndex] / 1000) *
						(args.drop_breakpoints[dropIndex] / 1000) *
						globalPrice.expected_value *
						args.waste_multiplier *
						args.gst_multiplier /
						((1 - args.post_discount_gross_margin) * args.discount_multiplier);
					const calculated = Math.ceil(raw / args.rounding_increment) * args.rounding_increment;
					if (Math.abs(calculated - mapping.surcharge_grid[widthIndex][dropIndex]) > 0.000001) {
						throw new Error(
							"Fabric Global Price formula failed parity at " +
							args.width_breakpoints[widthIndex] + "x" +
							args.drop_breakpoints[dropIndex] + " for " +
							mapping.expected_choice_label + ".",
						);
					}
				}
			}
			matches[0].pricing_type = "fx";
			matches[0].pricing_amount =
				"ceil((([field." + args.width_field_id + "]/1000)*([field." +
				args.drop_field_id + "]/1000)*acf_option(" + globalPrice.name + ")*" +
				pricingNumber(args.waste_multiplier) + "*" + pricingNumber(args.gst_multiplier) +
				"/((1-" + pricingNumber(args.post_discount_gross_margin) + ")*" +
				pricingNumber(args.discount_multiplier) + ")))/" +
				pricingNumber(args.rounding_increment) + ")*" +
				pricingNumber(args.rounding_increment) + "*[qty]";
		}
		if (seenFabricSlugs.size !== fabricChoices.length) {
			throw new Error("The pricing-reference plan must cover every fabric selector choice.");
		}

		const fitField = exactField(args.fit_field_id, args.expected_fit_field_label);
		const fitChoices = fitField?.options?.choices;
		if (!Array.isArray(fitChoices)) throw new Error("Fit Type choices are missing.");
		const faceMatches = fitChoices.filter(
			(choice: any) => String(choice?.slug) === args.face_fit_choice_slug,
		);
		if (
			faceMatches.length !== 1 ||
			String(faceMatches[0]?.label) !== args.expected_face_fit_choice_label
		) {
			throw new Error("Expected Face Fit choice identity not found.");
		}
		const legacyFaceFormula = oneDimensionalPricingFormula(
			args.drop_field_id, args.drop_breakpoints, args.face_fit_values,
		);
		if (
			faceMatches[0]?.pricing_type !== "fx" ||
			String(faceMatches[0]?.pricing_amount) !== legacyFaceFormula
		) {
			throw new Error("The current generated Face Fit formula no longer matches its parity grid.");
		}
		faceMatches[0].pricing_type = "fx";
		faceMatches[0].pricing_amount =
			"lookuptable(" + args.face_fit_lookup.name + ";" +
			args.width_field_id + ";" + args.drop_field_id + ")";

		const updatedValue =
			typeof wapf.meta.value === "string" ? JSON.stringify(updatedGroup) : updatedGroup;
		const afterHash = await genericWapfHashOf(updatedValue);
		const planHash = await genericWapfHashOf({
			...args,
			before_field_group_sha256: beforeHash,
			after_field_group_sha256: afterHash,
		});
		return { product, wapf, beforeHash, afterHash, planHash, updatedValue };
	}

	server.registerTool(
		"preview_wapf_pricing_reference_migration",
		{
			description: "Preview replacing generated WAPF base, fabric and Face Fit formulas with verified lookup-table and ACF Global Price references. Verifies exact storage identities and full matrix parity; performs no writes.",
			inputSchema: wapfPricingReferenceMigrationBase,
		},
		async (args) => {
			try {
				const plan = await buildWapfPricingReferencePlan(args);
				return toolResult({
					preview_only: true,
					write_performed: false,
					product: {
						id: plan.product.id,
						name: plan.product.name,
						status: plan.product.status,
						catalog_visibility: plan.product.catalog_visibility,
					},
					before_field_group_sha256: plan.beforeHash,
					after_field_group_sha256: plan.afterHash,
					plan_sha256: plan.planHash,
					parity: {
						base_cells: args.width_breakpoints.length * args.drop_breakpoints.length,
						fabric_cells: args.fabric_groups.length *
							args.width_breakpoints.length * args.drop_breakpoints.length,
						face_fit_cells: args.face_fit_values.length,
						mismatches: 0,
					},
					untouched: [
						"regular price",
						"product identity",
						"draft/hidden state",
						"field and choice identities",
						"images",
						"conditions",
						"non-pricing product data",
					],
				});
			} catch (error) { return toolError(error); }
		},
	);

	server.registerTool(
		"apply_wapf_pricing_reference_migration_guarded",
		{
			description: "Apply one exact parity-tested migration from generated WAPF pricing formulas to verified lookup-table and ACF Global Price references on a draft/hidden product. Changes only the selected pricing formulas, verifies the final hash and rolls back exactly on failure.",
			inputSchema: wapfPricingReferenceMigrationBase.extend({
				expected_plan_sha256: genericWapfHash,
				confirmation: z.literal("CONFIRM APPLY WAPF PRICING REFERENCES"),
			}),
		},
		async (args) => {
			try {
				const product = await (await wcFetch("products/" + args.product_id)).json<any>();
				const pricingArgs = wapfPricingReferenceMigrationBase.parse(args);
				const plan = await buildWapfPricingReferencePlan(pricingArgs, product);
				if (plan.planHash !== args.expected_plan_sha256) {
					throw new Error("The deterministic pricing-reference plan changed after preview; refusing write.");
				}
				try {
					await wcWrite("products/" + args.product_id, {
						meta_data: [{
							id: plan.wapf.meta.id,
							key: "_wapf_fieldgroup",
							value: plan.updatedValue,
						}],
					});
					const verified = await (await wcFetch("products/" + args.product_id)).json<any>();
					const verifiedWapf = genericWapf(verified);
					const verifiedHash = await genericWapfHashOf(verifiedWapf.meta.value);
					if (
						verified.id !== args.product_id ||
						verified.name !== args.expected_product_name ||
						verified.status !== "draft" ||
						verified.catalog_visibility !== "hidden" ||
						Number(verified.regular_price) !== args.expected_regular_price ||
						verifiedHash !== plan.afterHash
					) {
						throw new Error("Post-write pricing-reference verification failed.");
					}
					return toolResult({
						updated: true,
						verified: true,
						rollback_performed: false,
						product: {
							id: verified.id,
							name: verified.name,
							status: verified.status,
							catalog_visibility: verified.catalog_visibility,
						},
						regular_price: verified.regular_price,
						before_field_group_sha256: plan.beforeHash,
						after_field_group_sha256: verifiedHash,
						plan_sha256: plan.planHash,
						parity: {
							base_cells: args.width_breakpoints.length * args.drop_breakpoints.length,
							fabric_cells: args.fabric_groups.length *
								args.width_breakpoints.length * args.drop_breakpoints.length,
							face_fit_cells: args.face_fit_values.length,
							mismatches: 0,
						},
					});
				} catch (writeError) {
					await wcWrite("products/" + args.product_id, {
						meta_data: [{
							id: plan.wapf.meta.id,
							key: "_wapf_fieldgroup",
							value: plan.wapf.meta.value,
						}],
					});
					const rolledBack = await (await wcFetch("products/" + args.product_id)).json<any>();
					const rolledBackHash = await genericWapfHashOf(genericWapf(rolledBack).meta.value);
					if (rolledBackHash !== plan.beforeHash) {
						throw new Error("Pricing-reference update and exact rollback verification both failed.");
					}
					throw new Error(
						"Pricing-reference update failed; exact rollback succeeded: " +
						(writeError instanceof Error ? writeError.message : String(writeError)),
					);
				}
			} catch (error) { return toolError(error); }
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
