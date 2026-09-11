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
const TOTALBLOCK_PRODUCT_ID = 9413;
const TOTALBLOCK_PRODUCT_NAME = "Blindmotion TotalBlock Cassette Blind";
const TOTALBLOCK_PRODUCT_SLUG = "totalblock-cassette-blinds";
const TOTALBLOCK_PRODUCT_CATEGORY_ID = 74;
const TOTALBLOCK_PRODUCT_CONFIRMATION = "CONFIRM APPLY TOTALBLOCK PRODUCT CONTENT";
const TOTALBLOCK_FABRIC_SOURCE_ID = 4788;
const TOTALBLOCK_FABRIC_SOURCE_NAME = "Premium Roller Blinds";
const TOTALBLOCK_VIBE_PRICING_SOURCE_ID = 3839;
const TOTALBLOCK_VIBE_PRICING_SOURCE_NAME = "Everyday Roller Blinds";
const TOTALBLOCK_FABRIC_WRITE_CONFIRMATION = "CONFIRM INSTALL TOTALBLOCK BLOCKOUT FABRICS";
const TOTALBLOCK_FABRIC_TARGET_META_ID = 191905;
const TOTALBLOCK_FABRIC_SOURCE_META_ID = 130508;
const TOTALBLOCK_VIBE_SOURCE_META_ID = 35347;
const TOTALBLOCK_FABRIC_TARGET_HASH =
	"5dc1f08038b72c69ef90d678b01656e4cc21991fdcec600440c0e432679af45d";
const TOTALBLOCK_FABRIC_SOURCE_HASH =
	"0d98e18fe77f70b180f2d288180bdd3d630b6fe7c1b908d09612fcc5ca8f6912";
const TOTALBLOCK_VIBE_SOURCE_HASH =
	"000f7ac1a42c6193be39703cf19177dc0cb1e7c44c5b7af13195833a0ab94175";
const TOTALBLOCK_DUO_BLOCK_CONFIRMATION = "CONFIRM ADD DUO BLOCK TO TOTALBLOCK";
const TOTALBLOCK_SANCTUARY_CONFIRMATION = "CONFIRM ADD SANCTUARY TO TOTALBLOCK";
const TOTALBLOCK_FEATURED_IMAGE_CONFIRMATION = "CONFIRM REPLACE TOTALBLOCK FEATURED IMAGE";
const TOTALBLOCK_EXPECTED_FEATURED_IMAGE_ID = 6704;
const TOTALBLOCK_FEATURED_IMAGE_BACKUP_KEY = "_blindmotion_mcp_totalblock_featured_backups";
const TOTALBLOCK_GALLERY_CONFIRMATION = "CONFIRM REPLACE TOTALBLOCK GALLERY IMAGES";
const TOTALBLOCK_EXPECTED_CURRENT_IMAGE_IDS = [9417, 6715, 6820, 6821, 7292] as const;
const TOTALBLOCK_GALLERY_BACKUP_KEY = "_blindmotion_mcp_totalblock_gallery_backups";
const TOTALBLOCK_ELEMENTOR_ZIPGRIP_PATTERNS = [
	/zip guided blinds/i,
	/zipgrip/i,
	/outdoor space/i,
	/mesh fabric in 94%/i,
	/available up to 6400mm wide/i,
] as const;
const TOTALBLOCK_FABRIC_INSTALLED_HASH =
	"56baa1454189de29feda97493fc59405f76de11111c686379262c7458a8bed52";
const TOTALBLOCK_DUO_BLOCK_INSTALLED_HASH =
	"6dac64e0b458af244027410655e4fdc6dcf8e48e741810a408393cd9db60c741";
const TOTALBLOCK_SEO_TITLE = "Total Blockout Cassette Blinds with Side Channels | Blindmotion";
const TOTALBLOCK_SEO_DESCRIPTION =
	"Made-to-measure TotalBlock cassette blinds with side channels and a bottom seal, designed to dramatically reduce the light gaps around ordinary roller blinds.";
const TOTALBLOCK_SHORT_DESCRIPTION = `<p><strong>When an ordinary blockout blind isn’t dark enough.</strong></p>
<p>TotalBlock is a made-to-measure blockout cassette blind with side channels and a bottom seal. The enclosed system dramatically reduces the light gaps normally found around conventional roller blinds for a darker, more comfortable room.</p>`;
const TOTALBLOCK_DESCRIPTION = `<h2>Blockout fabric is only part of the answer</h2>
<p>A conventional blockout roller blind uses light-blocking fabric, but light can still enter around the top, sides and bottom of the blind. Blindmotion TotalBlock addresses those gaps with a complete cassette roller blind system.</p>
<p>The fabric rolls neatly into an enclosed head cassette. Side channels guide and contain the fabric edges, while the bottom seal helps close the remaining gap at the sill. The result is dramatically better room darkening than an ordinary blockout roller blind.</p>

<h2>Designed for rooms where darkness matters</h2>
<p>TotalBlock cassette blinds are particularly well suited to:</p>
<ul>
	<li>Bedrooms and nurseries</li>
	<li>Media rooms and home cinemas</li>
	<li>Shift workers and daytime sleepers</li>
	<li>Streetlights, early sunrise and other unwanted outside light</li>
	<li>Anyone frustrated by light leaking around standard roller blinds</li>
</ul>

<h2>How the TotalBlock system reduces light gaps</h2>
<ul>
	<li><strong>Enclosed cassette:</strong> houses the roller and reduces light entering above the blind.</li>
	<li><strong>Side channels:</strong> contain the fabric edges and reduce the bright strips commonly visible beside a roller blind.</li>
	<li><strong>Bottom seal:</strong> helps reduce light beneath the lowered blind.</li>
	<li><strong>Made-to-measure construction:</strong> manufactured to suit the dimensions of your window opening.</li>
</ul>

<h2>TotalBlock compared with an ordinary blockout roller blind</h2>
<p>Both products use blockout fabric. The important difference is what happens around that fabric. A normal roller blind leaves operating clearances around its edges. TotalBlock surrounds the blind with a cassette, side channels and a bottom seal to control those common sources of light leakage.</p>

<h2>A complete blockout cassette blind system</h2>
<p>TotalBlock combines practical room-darkening performance with the clean appearance of a purpose-built cassette blind. It is a strong choice when a standard blockout blind is not dark enough, without resorting to bulky layers of additional window coverings.</p>
<p><small>TotalBlock is designed to dramatically reduce incoming light. The final result depends on the window, opening, installation and surrounding sources of light; absolute darkness cannot be guaranteed in every room.</small></p>`;

function normalizeTotalBlockHtml(value: unknown) {
	return String(value ?? "")
		.replace(/\r\n?/g, "\n")
		.replace(/[\t ]+\n/g, "\n")
		.replace(/>\s+</g, "><")
		.trim();
}

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

function wapfFabricCandidates(group: Record<string, any>) {
	const fields = Array.isArray(group.fields) ? group.fields : [];
	return fields
		.map((field: any, index: number) => ({ field, index, label: wapfFieldLabel(field) }))
		.filter(({ field, label }) => {
			const choiceLabels = Array.isArray(field?.options?.choices)
				? field.options.choices
						.slice(0, 10)
						.map((choice: any) =>
							String(choice?.label ?? choice?.name ?? choice?.value ?? ""),
						)
						.join(" ")
				: "";
			return /fabric|blockout|blackout/i.test(`${label} ${choiceLabels}`);
		})
		.map(({ field, index, label }) => ({
			index,
			id: field?.id ?? field?.key ?? null,
			label,
			type: field?.type ?? null,
			required: field?.required ?? field?.options?.required ?? null,
			field_keys: Object.keys(field ?? {}).sort(),
			option_keys: Object.keys(field?.options ?? {}).sort(),
			choice_count: Array.isArray(field?.options?.choices) ? field.options.choices.length : 0,
			choices: Array.isArray(field?.options?.choices)
				? field.options.choices.map((choice: any, choiceIndex: number) => ({
						index: choiceIndex,
						id: choice?.id ?? choice?.key ?? null,
						label: choice?.label ?? choice?.name ?? null,
						value: choice?.value ?? null,
						slug: choice?.slug ?? null,
						price: choice?.price ?? choice?.pricing ?? null,
						pricing_type: choice?.pricing_type ?? null,
						pricing_amount: choice?.pricing_amount ?? null,
						image: choice?.image ?? null,
						attachment: choice?.attachment ?? null,
						keys: Object.keys(choice ?? {}).sort(),
					}))
				: [],
			condition_data: field?.conditionals ?? field?.conditions ?? field?.rules ?? null,
		}));
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

function wapfPricingContext(group: Record<string, any>) {
	const fields = Array.isArray(group.fields) ? group.fields : [];
	return fields
		.map((field: any, index: number) => ({ field, index }))
		.filter(({ field }) => {
			const choices = Array.isArray(field?.options?.choices) ? field.options.choices : [];
			return (
				field?.pricing?.enabled === true ||
				choices.some(
					(choice: any) =>
						String(choice?.pricing_type ?? "none") !== "none" ||
						!["", "0"].includes(String(choice?.pricing_amount ?? "")),
				)
			);
		})
		.map(({ field, index }) => wapfFieldSummary(field, index));
}

function wapfFabricPricingDefinitions(group: Record<string, any>) {
	const matches: Array<{ path: string; value: unknown }> = [];
	function visit(value: unknown, path: string, depth: number) {
		if (depth > 5 || value == null) return;
		if (Array.isArray(value)) {
			value.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
			return;
		}
		if (typeof value !== "object") return;
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			if (path === "group" && key === "fields") continue;
			const childPath = `${path}.${key}`;
			const serialized = JSON.stringify(child);
			if (
				/fabric|blockout|vibe|lookup/i.test(`${key} ${serialized}`) &&
				(serialized.length <= 4000 || depth >= 2)
			) {
				matches.push({ path: childPath, value: child });
				continue;
			}
			visit(child, childPath, depth + 1);
		}
	}
	visit(group, "group", 0);
	return matches.slice(0, 100);
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

const OUTDOOR_SEO_TARGETS = {
	outdoor_blinds: {
		kind: "product",
		productId: 1615,
		slug: "outdoor-blinds",
		path: "/outdoor-blinds/",
	},
	straight_drop: {
		kind: "product",
		productId: 111,
		slug: "straightdrop-outdoor-blinds",
		path: "/straightdrop-outdoor-blinds/",
	},
	zip_sided: {
		kind: "product",
		productId: 1301,
		slug: "zipsided-outdoor-blinds",
		path: "/zipsided-outdoor-blinds/",
	},
} as const;

type OutdoorSeoTargetKey = keyof typeof OUTDOOR_SEO_TARGETS;

const OUTDOOR_SEO_ELEMENTOR_TEMPLATE_IDS = [425, 557, 885, 1640, 1691, 1990] as const;

const OUTDOOR_SEO_FIX_CONFIRMATION = "CONFIRM APPLY OUTDOOR SEO FIXES";
const OUTDOOR_SEO_EXPECTED_TEMPLATE_HASHES = {
	557: "55130c1ac5dd9e8479dbd8f717aa4cf6bac33aa9894a80aa1204c6ad3c6bd6b4",
	1640: "f10529504a7c829c56abc2f88feb8890230a16de017bc9abc80f3fad28aa208b",
	1691: "27d7819e3c99cf1ce32aaeadee85adf073b26dcb968ce2d5669b7d16ca6176dd",
} as const;
const OUTDOOR_SEO_EXPECTED_PRODUCT_HASHES = {
	111: "aacc6af3c037b2d8990720b039ab8ef5680ead7711fe0ea0dd2924c509689ee1",
	1301: "42bd7e018ed8914dfba674b5a90b13ce20f690799ed3b47a2d68ddd54b6bfd03",
	1615: "071a010da90ed51e5e37498b99b085dc70993f440d92eb611d85a8389f8638b3",
} as const;

type OutdoorSeoElementorTemplateId = (typeof OUTDOOR_SEO_ELEMENTOR_TEMPLATE_IDS)[number];

const OUTDOOR_SEO_SUSPICIOUS_PATTERNS = [
	{ label: "placeholder_text", pattern: /scelerisque eleifend|lorem ipsum/gi },
	{ label: "unfinished_way_to_buy", pattern: /way\s+to\s+buy\s*\?\?/gi },
	{ label: "irrelevant_gift_voucher", pattern: /gift\s+voucher/gi },
	{ label: "incorrect_indoor_everyday_blind", pattern: /indoor\s+everyday\s+roller\s+blind/gi },
	{ label: "incorrect_indoor_premium_blind", pattern: /indoor\s+premium\s+roller\s+blind/gi },
] as const;

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

function getHtmlAttribute(tag: string, name: string) {
	for (const match of tag.matchAll(/([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
		if (match[1].toLowerCase() === name.toLowerCase()) {
			return match[2] ?? match[3] ?? match[4] ?? "";
		}
	}
	return undefined;
}

function extractHtmlSeo(html: string) {
	const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
	const descriptionTag = (html.match(/<meta\b[^>]*>/gi) ?? []).find(
		(tag) => getHtmlAttribute(tag, "name")?.toLowerCase() === "description",
	);
	const canonicalTag = (html.match(/<link\b[^>]*>/gi) ?? []).find((tag) =>
		getHtmlAttribute(tag, "rel")?.toLowerCase().split(/\s+/).includes("canonical"),
	);
	return {
		title: title ? htmlToPlainText(title) : null,
		description: descriptionTag
			? decodeBasicHtmlEntities(getHtmlAttribute(descriptionTag, "content") ?? "").trim()
			: null,
		canonical: canonicalTag ? (getHtmlAttribute(canonicalTag, "href") ?? null) : null,
	};
}

function extractHtmlHeadings(html: string) {
	const headings = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((match) => ({
		level: Number(match[1]),
		text: htmlToPlainText(match[2]),
	}));
	const counts = new Map<string, { text: string; count: number; levels: Set<number> }>();
	for (const heading of headings) {
		if (!heading.text) continue;
		const key = heading.text.toLowerCase();
		const current = counts.get(key) ?? {
			text: heading.text,
			count: 0,
			levels: new Set<number>(),
		};
		current.count += 1;
		current.levels.add(heading.level);
		counts.set(key, current);
	}
	return {
		total: headings.length,
		h1_count: headings.filter((heading) => heading.level === 1).length,
		headings: headings.slice(0, 100),
		duplicates: [...counts.values()]
			.filter((heading) => heading.count > 1)
			.map((heading) => ({
				text: heading.text,
				count: heading.count,
				levels: [...heading.levels].sort(),
			})),
	};
}

function suspiciousContentMatches(value: string) {
	return OUTDOOR_SEO_SUSPICIOUS_PATTERNS.map(({ label, pattern }) => ({
		label,
		count: [...value.matchAll(new RegExp(pattern.source, pattern.flags))].length,
	})).filter((match) => match.count > 0);
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

function totalBlockElementorMatches(nodes: any[]) {
	const matches: any[] = [];
	function visit(node: any, ancestors: string[] = []) {
		if (!node || typeof node !== "object") return;
		const settings = node.settings && typeof node.settings === "object" ? node.settings : {};
		const matchedSettings = Object.entries(settings)
			.filter((entry): entry is [string, string] => typeof entry[1] === "string")
			.filter(([, value]) =>
				TOTALBLOCK_ELEMENTOR_ZIPGRIP_PATTERNS.some((pattern) => pattern.test(value)),
			)
			.map(([key, value]) => ({
				key,
				plain_text: htmlToPlainText(value).slice(0, 4000),
				sha256_input_length: value.length,
			}));
		const imageSettings = Object.fromEntries(
			Object.entries(settings).filter(
				([key, value]) =>
					/(?:background|image)/i.test(key) &&
					(value === null || ["string", "number", "object"].includes(typeof value)),
			),
		);
		if (matchedSettings.length > 0) {
			matches.push({
				id: node.id ?? null,
				el_type: node.elType ?? null,
				widget_type: node.widgetType ?? null,
				ancestor_ids: ancestors,
				matched_settings: matchedSettings,
				image_settings: imageSettings,
			});
		}
		for (const child of Array.isArray(node.elements) ? node.elements : []) {
			visit(child, [...ancestors, String(node.id ?? "")]);
		}
	}
	for (const node of nodes) visit(node);
	return matches;
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

function elementorWidgetInventory(nodes: any[]) {
	const widgets: any[] = [];
	function visit(node: any, ancestors: any[] = []) {
		if (!node || typeof node !== "object") return;
		const settings = node.settings && typeof node.settings === "object" ? node.settings : {};
		if (node.elType === "widget") {
			const stringSettings = Object.entries(settings)
				.filter((entry): entry is [string, string] => typeof entry[1] === "string")
				.map(([key, value]) => ({ key, value }));
			const searchable = stringSettings.map(({ value }) => value).join("\n");
			const suspiciousMatches = suspiciousContentMatches(searchable);
			const headingTag =
				stringSettings.find(({ key }) =>
					/^(?:header_size|html_tag|title_tag|tag)$/.test(key),
				)?.value ?? null;
			const contentSettings = Object.fromEntries(
				stringSettings
					.filter(
						({ key, value }) =>
							suspiciousContentMatches(value).length > 0 ||
							/^(?:title|title_text|description|description_text|editor|header_size|html_tag)$/.test(
								key,
							),
					)
					.map(({ key, value }) => [key, value.slice(0, 2000)]),
			);
			const responsiveSettings = Object.fromEntries(
				Object.entries(settings).filter(([key]) =>
					/(?:hide_|hidden|visibility|responsive|display)/i.test(key),
				),
			);
			if (
				suspiciousMatches.length > 0 ||
				headingTag !== null ||
				/product-title|heading|text-editor|template/i.test(String(node.widgetType))
			) {
				widgets.push({
					id: node.id ?? null,
					widget_type: node.widgetType ?? null,
					ancestor_path: ancestors.map((ancestor) => ({
						id: ancestor.id ?? null,
						el_type: ancestor.elType ?? null,
						settings: Object.fromEntries(
							Object.entries(
								ancestor.settings && typeof ancestor.settings === "object"
									? ancestor.settings
									: {},
							).filter(([key]) =>
								/(?:dce_|visibility|hide_|display|css_classes|condition)/i.test(
									key,
								),
							),
						),
					})),
					heading_tag: headingTag,
					content_settings: contentSettings,
					text_preview: htmlToPlainText(searchable).slice(0, 800),
					suspicious_matches: suspiciousMatches,
					responsive_settings: responsiveSettings,
				});
			}
		}
		for (const child of Array.isArray(node.elements) ? node.elements : []) {
			visit(child, [...ancestors, node]);
		}
	}
	for (const node of nodes) visit(node);
	return widgets.slice(0, 250);
}

async function inspectOutdoorSeoElementorTemplate(templateId: OutdoorSeoElementorTemplateId) {
	const response = await wpAuthenticatedFetch(`elementor_library/${templateId}?context=edit`);
	const template = await response.json<any>();
	if (template.id !== templateId || template.status !== "publish") {
		throw new Error(`Locked Elementor template identity mismatch for ${templateId}.`);
	}
	const meta = template.meta && typeof template.meta === "object" ? template.meta : {};
	const elementorDataValue = meta["_elementor_data"];
	const elementorData = parseElementorData(elementorDataValue);
	const serialized =
		typeof elementorDataValue === "string"
			? elementorDataValue
			: JSON.stringify(elementorDataValue ?? null);
	const elementorDataSha256 = await sha256Hex(new TextEncoder().encode(serialized));
	return {
		id: template.id,
		title: template.title?.raw ?? template.title?.rendered ?? "",
		slug: template.slug,
		status: template.status,
		link: template.link,
		template_type: meta["_elementor_template_type"] ?? null,
		display_conditions: meta["_elementor_conditions"] ?? null,
		meta_keys: Object.keys(meta)
			.filter((key) => /elementor/i.test(key))
			.sort(),
		elementor_data_available: elementorData !== null,
		elementor_data_length: serialized.length,
		elementor_data_sha256: elementorDataSha256,
		suspicious_matches: suspiciousContentMatches(serialized),
		widgets: elementorData ? elementorWidgetInventory(elementorData) : [],
	};
}

function mutateElementorWidgetSetting(
	nodes: any[],
	widgetId: string,
	setting: string,
	expectedValue: string,
	newValue: string,
) {
	let matches = 0;
	function visit(node: any) {
		if (!node || typeof node !== "object") return;
		if (node.id === widgetId) {
			matches += 1;
			if (node.elType !== "widget" || node.settings?.[setting] !== expectedValue) {
				throw new Error(`Unexpected Elementor widget state for ${widgetId}.${setting}.`);
			}
			node.settings[setting] = newValue;
		}
		for (const child of Array.isArray(node.elements) ? node.elements : []) visit(child);
	}
	for (const node of nodes) visit(node);
	if (matches !== 1)
		throw new Error(`Expected exactly one Elementor widget ${widgetId}; found ${matches}.`);
}

function removeElementorElement(nodes: any[], elementId: string) {
	let matches = 0;
	function visit(elements: any[]) {
		for (let index = elements.length - 1; index >= 0; index -= 1) {
			const element = elements[index];
			if (element?.id === elementId) {
				if (
					element.elType !== "section" ||
					element.settings?.hide_desktop !== "hidden-desktop" ||
					element.settings?.hide_tablet !== "hidden-tablet" ||
					element.settings?.hide_mobile !== "hidden-mobile"
				) {
					throw new Error(
						`Refusing to remove visible or unexpected Elementor element ${elementId}.`,
					);
				}
				elements.splice(index, 1);
				matches += 1;
				continue;
			}
			if (Array.isArray(element?.elements)) visit(element.elements);
		}
	}
	visit(nodes);
	if (matches !== 1)
		throw new Error(
			`Expected exactly one hidden Elementor element ${elementId}; found ${matches}.`,
		);
}

function productMetaUpdate(product: any, key: string, expectedValue: string, value: string) {
	const matches = (product.meta_data ?? []).filter((meta: any) => meta.key === key);
	if (matches.length > 1 || String(matches[0]?.value ?? "") !== expectedValue) {
		throw new Error(`Unexpected product ${product.id} metadata state for ${key}.`);
	}
	return matches.length === 1 ? { id: matches[0].id, key, value } : { key, value };
}

async function getLockedElementorTemplateForUpdate(templateId: 557 | 1640 | 1691) {
	const response = await wpAuthenticatedFetch(`elementor_library/${templateId}?context=edit`);
	const template = await response.json<any>();
	if (template.id !== templateId || template.status !== "publish") {
		throw new Error(`Locked Elementor template identity mismatch for ${templateId}.`);
	}
	const raw = template.meta?.["_elementor_data"];
	const data = parseElementorData(raw);
	if (!data || typeof raw !== "string") {
		throw new Error(`Elementor data is unavailable for locked template ${templateId}.`);
	}
	const hash = await sha256Hex(new TextEncoder().encode(raw));
	if (hash !== OUTDOOR_SEO_EXPECTED_TEMPLATE_HASHES[templateId]) {
		throw new Error(`Template ${templateId} changed after review; refusing the SEO update.`);
	}
	return { template, raw, data };
}

async function applyOutdoorSeoFixes() {
	const templateIds = [557, 1640, 1691] as const;
	const productIds = [1615, 111, 1301] as const;
	const [template557, template1640, template1691, product1615, product111, product1301] =
		await Promise.all([
			getLockedElementorTemplateForUpdate(557),
			getLockedElementorTemplateForUpdate(1640),
			getLockedElementorTemplateForUpdate(1691),
			wcFetch("products/1615").then((response) => response.json<any>()),
			wcFetch("products/111").then((response) => response.json<any>()),
			wcFetch("products/1301").then((response) => response.json<any>()),
		]);
	const products = [product1615, product111, product1301];
	for (const product of products) {
		const target = Object.values(OUTDOOR_SEO_TARGETS).find(
			(candidate) => candidate.productId === product.id,
		);
		if (
			!target ||
			product.status !== "publish" ||
			product.slug !== target.slug ||
			product.permalink !== new URL(target.path, (env as any).WC_SITE).toString()
		) {
			throw new Error(`Locked product identity mismatch for ${product.id}.`);
		}
		const stored = `${product.short_description ?? ""}\n${product.description ?? ""}`;
		const hash = await sha256Hex(new TextEncoder().encode(stored));
		if (hash !== OUTDOOR_SEO_EXPECTED_PRODUCT_HASHES[product.id as 111 | 1301 | 1615]) {
			throw new Error(`Product ${product.id} changed after review; refusing the SEO update.`);
		}
	}

	removeElementorElement(template557.data, "a706128");
	removeElementorElement(template557.data, "7c67552");
	const widgetChanges557: Array<[string, string, string, string]> = [
		["6e4e86a", "title_text", "Feature 1", "Made to Measure"],
		[
			"6e4e86a",
			"description_text",
			"Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
			"Built to your measurements for a clean, accurate fit.",
		],
		["cbfb487", "title_text", "Feature 1", "Australian Made"],
		[
			"cbfb487",
			"description_text",
			"Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
			"Manufactured in Sydney with carefully selected components.",
		],
		["72a727a", "title_text", "Feature 1", "Simple Online Ordering"],
		[
			"72a727a",
			"description_text",
			"Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
			"Choose your options, enter your sizes and see your price online.",
		],
		["c2d0215", "title_text", "Feature 1", "Helpful Support"],
		[
			"c2d0215",
			"description_text",
			"Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
			"Get practical measuring and installation guidance when you need it.",
		],
		[
			"f8a6e76",
			"description_text",
			"Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
			"Made-to-measure quality, ordered online.",
		],
		[
			"365824d",
			"editor",
			"Aenean sed adipiscing diam donec adipiscing tristique. Scelerisque eleifend donec pretium vulputate sapien.",
			"Explore made-to-measure blinds designed for a clean fit, dependable operation and straightforward DIY installation.",
		],
		[
			"6a2f18b",
			"editor",
			"Aenean sed adipiscing diam donec adipiscing tristique. Scelerisque eleifend donec pretium vulputate sapien.",
			"Made-to-measure blinds with practical options, reliable components and clear support from order to installation.",
		],
		["7796e5f", "title_text", "This is the heading", "Made to Measure"],
		[
			"7796e5f",
			"description_text",
			"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Ut elit tellus, luctus nec ullamcorper mattis, pulvinar dapibus leo.",
			"Manufactured to your measurements for a precise, professional result.",
		],
		["167feb8", "title_text", "This is the heading", "Reliable Components"],
		[
			"167feb8",
			"description_text",
			"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Ut elit tellus, luctus nec ullamcorper mattis, pulvinar dapibus leo.",
			"Quality mechanisms and fabrics selected for dependable everyday operation.",
		],
		["97491d9", "title_text", "This is the heading", "Manual or Motorised"],
		[
			"97491d9",
			"description_text",
			"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Ut elit tellus, luctus nec ullamcorper mattis, pulvinar dapibus leo.",
			"Choose a practical manual control or convenient motorisation.",
		],
		["ae71a5f", "title_text", "This is the heading", "DIY Support"],
		[
			"ae71a5f",
			"description_text",
			"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Ut elit tellus, luctus nec ullamcorper mattis, pulvinar dapibus leo.",
			"Clear measuring and installation guidance is available when you need it.",
		],
		[
			"71ecc75e",
			"editor",
			"Aenean sed adipiscing diam donec adipiscing tristique. Scelerisque eleifend donec pretium vulputate sapien. Aenean sed adipiscing diam donec adipiscing tristique.",
			"Made-to-measure blinds designed for a clean fit, practical operation and lasting performance.",
		],
		[
			"6ee12791",
			"description_text",
			"Lorem ipsum dolor sit amet,consectetur adipisicing elit, sed",
			"Clean, practical designs suited to Australian homes and outdoor spaces.",
		],
		[
			"30e3412b",
			"description_text",
			"Lorem ipsum dolor sit amet,consectetur adipisicing elit, sed",
			"Components and fabrics selected for reliable everyday performance.",
		],
		[
			"1bfd6403",
			"description_text",
			"Lorem ipsum dolor sit amet,consectetur adipisicing elit, sed",
			"Robust mechanisms and quality materials designed for years of use.",
		],
		[
			"592237b6",
			"description_text",
			"Lorem ipsum dolor sit amet,consectetur adipisicing elit, sed",
			"Choose colours and finishes that work naturally with your space.",
		],
		[
			"43aafc86",
			"editor",
			"Aenean sed adipiscing diam donec adipiscing tristique. \nScelerisque eleifend donec pretium vulputate sapien.",
			"Made-to-measure blinds designed for shade, privacy and comfortable everyday living.",
		],
		[
			"b55a68a",
			"editor",
			"Aenean sed adipiscing diam donec adipiscing tristique. \nScelerisque eleifend donec pretium vulputate sapien.",
			"Enter your measurements and select your preferred options to see your made-to-measure price.",
		],
	];
	for (const change of widgetChanges557)
		mutateElementorWidgetSetting(template557.data, ...change);

	mutateElementorWidgetSetting(
		template1640.data,
		"f72fde8",
		"description",
		"Lorem ipsum dolor sit amet consectetur adipiscing elit dolor",
		"",
	);
	const widgetChanges1691: Array<[string, string, string, string]> = [
		[
			"16da5d2",
			"description_text",
			"Scelerisque eleifend donec pretium vulputate sapien.",
			"Free delivery on orders over $399.",
		],
		["bbe55f7", "title_text", "Way To Buy??", "Easy Online Ordering"],
		[
			"bbe55f7",
			"description_text",
			"Scelerisque eleifend donec pretium vulputate sapien.",
			"Choose your options, enter your measurements and see your price online.",
		],
		["efa92fa", "title_text", "Shipping & Returns", "Delivery & Support"],
		[
			"efa92fa",
			"description_text",
			"Scelerisque eleifend donec pretium vulputate sapien.",
			"Made-to-measure blinds delivered Australia-wide, with help available when you need it.",
		],
		["85234d5", "title_text", "Gift Voucher", "Made to Measure"],
		[
			"85234d5",
			"description_text",
			"Scelerisque eleifend donec pretium vulputate sapien.",
			"Manufactured to your measurements for a precise, professional result.",
		],
	];
	for (const change of widgetChanges1691)
		mutateElementorWidgetSetting(template1691.data, ...change);

	const nextTemplateData = new Map<number, string>([
		[557, JSON.stringify(template557.data)],
		[1640, JSON.stringify(template1640.data)],
		[1691, JSON.stringify(template1691.data)],
	]);
	for (const [templateId, raw] of nextTemplateData) {
		if (suspiciousContentMatches(raw).length > 0) {
			throw new Error(
				`Template ${templateId} still contains known suspicious content after preflight.`,
			);
		}
	}

	const productUpdates = [
		{
			product: product1615,
			short_description:
				"<p>Made-to-measure outdoor blinds manufactured in Sydney for DIY installation across Australia.</p>",
			description:
				"<h2>DIY Outdoor Blinds, Made to Measure</h2><p>Choose from Straight Drop, Cable Guide and ZipGrip zip-guided outdoor blinds, manufactured in Sydney to your measurements.</p><p>Order DIY blinds for delivery Australia-wide, with manual and motorised options available. Professional measuring and installation are also available across Greater Sydney.</p>",
			title: "DIY Outdoor Blinds Online | Made to Measure | Blindmotion",
			metadesc:
				"Shop Australian-made outdoor blinds online, including Straight Drop, Cable Guide and ZipGrip options. DIY delivery Australia-wide and Sydney installation.",
		},
		{
			product: product111,
			short_description:
				"<p>A simple, durable outdoor blind with crank or motorised control, made to measure in Sydney.</p>",
			description:
				"<h2>Straight Drop Outdoor Blinds</h2><p>A practical, good-looking outdoor blind made with durable galvanised and stainless-steel components. Straight Drop blinds can span wide openings and are available in outdoor mesh or clear PVC.</p><h2>Motorised Outdoor Blinds</h2><p>Choose convenient motorisation or a straightforward manual crank control to suit your outdoor area.</p><h2>Outdoor Blinds in Sydney</h2><p>Blindmotion manufactures these blinds in Sydney. Order DIY for delivery Australia-wide, or ask about professional measuring and installation across Greater Sydney.</p>",
			title: "Straight Drop Outdoor Blinds | DIY From $229 | Blindmotion",
			metadesc:
				"Australian-made Straight Drop outdoor blinds from $229. Custom sizes, manual or motorised controls, DIY delivery Australia-wide and Sydney installation.",
			previousMetadesc:
				"A heavy duty, traditional outdoor blind able to span up to 6 metres and drop 3 metres. Made with heavy duty galvanised and stainless steel parts.",
		},
		{
			product: product1301,
			short_description:
				"<p>ZipGrip side-retention outdoor blinds, made to measure with manual or motorised control.</p>",
			description:
				"<h2>ZipGrip Zip-Guided Outdoor Blinds</h2><p>ZipGrip uses a side-retention system to hold the fabric neatly within its guides, creating a clean and practical enclosure for patios, pergolas and alfresco areas.</p><p>Choose outdoor mesh or clear PVC, manual or motorised control, and colours to suit your space. Each blind is made to measure in Sydney and can be ordered for DIY delivery Australia-wide.</p>",
			title: "Zip Track Outdoor Blinds | ZipGrip From $399 | Blindmotion",
			metadesc:
				"Shop ZipGrip zip-guided outdoor blinds from $399. Made to measure in Sydney with manual or motorised controls and DIY delivery Australia-wide.",
		},
	] as const;
	const templateBackups = new Map<number, string>([
		[557, template557.raw],
		[1640, template1640.raw],
		[1691, template1691.raw],
	]);
	const appliedTemplates: number[] = [];
	const appliedProducts: any[] = [];
	try {
		for (const templateId of templateIds) {
			const expectedRaw = nextTemplateData.get(templateId)!;
			await wpAuthenticatedWrite(`elementor_library/${templateId}`, {
				meta: { _elementor_data: expectedRaw },
			});
			appliedTemplates.push(templateId);
			const verificationResponse = await wpAuthenticatedFetch(
				`elementor_library/${templateId}?context=edit`,
			);
			const verification = await verificationResponse.json<any>();
			if (verification.meta?.["_elementor_data"] !== expectedRaw) {
				throw new Error(`Template ${templateId} did not verify after the WordPress write.`);
			}
		}
		for (const update of productUpdates) {
			const titleMeta = productMetaUpdate(
				update.product,
				"_yoast_wpseo_title",
				"",
				update.title,
			);
			const descriptionMeta = productMetaUpdate(
				update.product,
				"_yoast_wpseo_metadesc",
				"previousMetadesc" in update ? update.previousMetadesc : "",
				update.metadesc,
			);
			const writeResponse = await wcWrite(`products/${update.product.id}`, {
				short_description: update.short_description,
				description: update.description,
				meta_data: [titleMeta, descriptionMeta],
			});
			const writtenProduct = await writeResponse.json<any>();
			appliedProducts.push({ update, writtenProduct });
			if (
				writtenProduct.short_description !== update.short_description ||
				writtenProduct.description !== update.description ||
				!writtenProduct.meta_data?.some(
					(meta: any) => meta.key === "_yoast_wpseo_title" && meta.value === update.title,
				) ||
				!writtenProduct.meta_data?.some(
					(meta: any) =>
						meta.key === "_yoast_wpseo_metadesc" && meta.value === update.metadesc,
				)
			) {
				throw new Error(
					`Product ${update.product.id} did not verify after the WooCommerce write.`,
				);
			}
		}
	} catch (error) {
		const rollbackErrors: string[] = [];
		for (const applied of appliedProducts.reverse()) {
			try {
				const { update, writtenProduct } = applied;
				const writtenTitle = writtenProduct.meta_data?.find(
					(meta: any) => meta.key === "_yoast_wpseo_title",
				);
				const writtenDescription = writtenProduct.meta_data?.find(
					(meta: any) => meta.key === "_yoast_wpseo_metadesc",
				);
				if (!writtenTitle?.id || !writtenDescription?.id) {
					const missingMetadataError = new Error(
						"Updated Yoast metadata IDs are unavailable for rollback.",
					);
					(missingMetadataError as Error & { cause?: unknown }).cause = error;
					throw missingMetadataError;
				}
				await wcWrite(`products/${update.product.id}`, {
					short_description: update.product.short_description,
					description: update.product.description,
					meta_data: [
						{ id: writtenTitle.id, key: "_yoast_wpseo_title", value: "" },
						{
							id: writtenDescription.id,
							key: "_yoast_wpseo_metadesc",
							value: "previousMetadesc" in update ? update.previousMetadesc : "",
						},
					],
				});
			} catch (rollbackError) {
				rollbackErrors.push(
					`product ${applied.update.product.id}: ${String(rollbackError)}`,
				);
			}
		}
		for (const templateId of appliedTemplates.reverse()) {
			try {
				await wpAuthenticatedWrite(`elementor_library/${templateId}`, {
					meta: { _elementor_data: templateBackups.get(templateId) },
				});
			} catch (rollbackError) {
				rollbackErrors.push(`template ${templateId}: ${String(rollbackError)}`);
			}
		}
		const wrappedError = new Error(
			`${error instanceof Error ? error.message : String(error)} Rollback errors: ${rollbackErrors.length ? rollbackErrors.join("; ") : "none"}.`,
		);
		(wrappedError as Error & { cause?: unknown }).cause = error;
		throw wrappedError;
	}
	return {
		updated: true,
		templates_updated: templateIds,
		products_updated: productIds,
		removed_hidden_sections: ["a706128", "7c67552"],
		rollback_errors: [],
	};
}

function outdoorSeoMetaInventory(metaData: any[]) {
	return (metaData ?? [])
		.filter((meta: any) =>
			/(elementor|yoast|rank_math|page_template|wp_page_template)/i.test(String(meta.key)),
		)
		.map((meta: any) => {
			const serialized =
				typeof meta.value === "string" ? meta.value : JSON.stringify(meta.value ?? null);
			return {
				id: meta.id ?? null,
				key: String(meta.key),
				value_type: Array.isArray(meta.value) ? "array" : typeof meta.value,
				value_length: serialized.length,
				value: /(title|description|metadesc)$/i.test(String(meta.key))
					? serialized.slice(0, 500)
					: undefined,
				suspicious_matches: suspiciousContentMatches(serialized),
			};
		});
}

async function inspectOutdoorSeoTarget(targetKey: OutdoorSeoTargetKey) {
	const target = OUTDOOR_SEO_TARGETS[targetKey];
	const workerEnv = env as unknown as Record<string, string>;
	const publicUrl = new URL(target.path, workerEnv.WC_SITE).toString();
	const publicResponse = await fetch(publicUrl, { headers: { Accept: "text/html" } });
	if (!publicResponse.ok) {
		throw new Error(`Public page fetch failed: ${publicResponse.status} ${publicUrl}`);
	}
	const publicHtml = await publicResponse.text();
	let record: any;
	let storedContent: string;
	let metaInventory: ReturnType<typeof outdoorSeoMetaInventory> = [];

	if (target.kind === "product") {
		const productResponse = await wcFetch(`products/${target.productId}`);
		const product = await productResponse.json<any>();
		if (product.slug !== target.slug || product.permalink !== publicUrl) {
			throw new Error(`Locked product identity mismatch for ${targetKey}.`);
		}
		storedContent = `${product.short_description ?? ""}\n${product.description ?? ""}`;
		metaInventory = outdoorSeoMetaInventory(product.meta_data ?? []);
		record = {
			kind: "product",
			id: product.id,
			name: product.name,
			slug: product.slug,
			status: product.status,
			permalink: product.permalink,
			short_description_html_length: String(product.short_description ?? "").length,
			description_html_length: String(product.description ?? "").length,
			short_description_html: String(product.short_description ?? ""),
			description_html: String(product.description ?? ""),
			meta_record_count: product.meta_data?.length ?? 0,
		};
	} else {
		const pageResponse = await wpAuthenticatedFetch(
			`pages?slug=${encodeURIComponent(target.slug)}&context=edit&per_page=2`,
		);
		const pages = await pageResponse.json<any[]>();
		if (pages.length !== 1 || pages[0].link !== publicUrl) {
			throw new Error(`Locked page identity mismatch for ${targetKey}.`);
		}
		const page = pages[0];
		storedContent = page.content?.raw ?? page.content?.rendered ?? "";
		const pageMeta = Object.entries(page.meta ?? {}).map(([key, value]) => ({ key, value }));
		metaInventory = outdoorSeoMetaInventory(pageMeta);
		record = {
			kind: "page",
			id: page.id,
			title: page.title?.raw ?? page.title?.rendered ?? "",
			slug: page.slug,
			status: page.status,
			permalink: page.link,
			content_html_length: storedContent.length,
			meta_record_count: pageMeta.length,
		};
	}

	const storedSuspicious = suspiciousContentMatches(storedContent);
	const renderedSuspicious = suspiciousContentMatches(publicHtml);
	const storedContentSha256 = await sha256Hex(new TextEncoder().encode(storedContent));
	return {
		target: targetKey,
		record,
		seo: extractHtmlSeo(publicHtml),
		rendered_html_length: publicHtml.length,
		rendered_text_length: htmlToPlainText(publicHtml).length,
		stored_text_length: htmlToPlainText(storedContent).length,
		stored_content_sha256: storedContentSha256,
		stored_text_preview: htmlToPlainText(storedContent).slice(0, 1200),
		headings: extractHtmlHeadings(publicHtml),
		suspicious_content: { stored: storedSuspicious, rendered: renderedSuspicious },
		meta_inventory: metaInventory,
		location_inference:
			renderedSuspicious.length > 0 &&
			storedSuspicious.length === 0 &&
			metaInventory.every((meta) => meta.suspicious_matches.length === 0)
				? "Suspicious text appears in rendered HTML but not exposed stored content; a shared theme/Elementor template is likely."
				: null,
	};
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
const META_CLONE_WINTER_FORM_CONFIRMATION = "CONFIRM CLONE WINTER FORM FOR SPRING";
const META_ARCHIVE_DRAFT_ADS_CONFIRMATION = "CONFIRM ARCHIVE PAUSED META DRAFT ADS";
const META_REPAIR_SPRING_ADS_CONFIRMATION = "CONFIRM REPAIR ACTIVE SPRING META ADS";
const META_REFRESH_SPRING_OFFER_REASON = "PROMOTE 20.5 PERCENT OFFER";
const META_LEAD_AD_LINK = "https://fb.me/";
const META_MAX_CREATION_DAILY_BUDGET_AUD = 500;
const META_SPRING_REPAIR_CAMPAIGN_ID = "52674105076400";
const META_SPRING_REPAIR_CAMPAIGN_NAME = "META | Leads | Beat The Spring Rush | Sydney | Sep 2026";
const META_SPRING_REPAIR_PAGE_ID = "1383784325241628";
const META_WINTER_FORM_ID = "870161355942701";
const META_WINTER_FORM_NAME = "Outdoor Blinds Winter Sale Quote Form (v1)";
const META_SIMPLIFIED_SPRING_FORM_ID = "1915237879884343";
const META_SIMPLIFIED_SPRING_FORM_NAME =
	"Outdoor Blinds | Beat the Spring Rush | Quote Form | Sep 2026";
const META_CORRECTED_SPRING_FORM_NAME =
	"Outdoor Blinds | Spring Sale 20.5% Off | Full Quote Form | Sep 2026";
const META_CORRECTED_SPRING_FORM_HEADLINE =
	"Save 20.5% on Outdoor Blinds — Get Your Free Measure & Quote";

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

function normalizeMetaLeadFormQuestions(questions: unknown) {
	if (!Array.isArray(questions)) {
		throw new Error("Instant Form questions were not returned as an array.");
	}
	return questions.map((question: any) => {
		const normalized: Record<string, unknown> = {
			type: String(question.type ?? ""),
			key: String(question.key ?? ""),
		};
		if (question.label !== undefined) normalized.label = String(question.label);
		if (Array.isArray(question.options)) {
			normalized.options = question.options.map((option: any) => ({
				key: String(option.key ?? ""),
				value: String(option.value ?? ""),
			}));
		}
		return normalized;
	});
}

function assertWinterOutdoorLeadQuestionSchema(questions: Array<Record<string, unknown>>) {
	const expectedKeys = [
		"full_name",
		"phone",
		"email",
		"post_code",
		"what_type_of_area_are_you_looking_to_cover?",
		"approximately_how_many_blinds_do_you_need?",
		"when_would_you_like_them_installed?",
	].sort();
	const actualKeys = questions.map((question) => String(question.key)).sort();
	if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
		throw new Error(
			"Refusing clone: source form does not contain the exact seven-field Winter outdoor schema.",
		);
	}
	for (const question of questions) {
		if (!question.type || !question.key) {
			throw new Error("Refusing clone: a source question is missing its type or key.");
		}
		if (
			question.type === "CUSTOM" &&
			(!question.label || !Array.isArray(question.options) || question.options.length < 2)
		) {
			throw new Error(
				`Refusing clone: custom question ${String(question.key)} is incomplete.`,
			);
		}
	}
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

function utcDateDaysAgo(days: number) {
	const date = new Date();
	date.setUTCDate(date.getUTCDate() - days);
	return date.toISOString().slice(0, 10);
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
		"inspect_outdoor_seo_pages",
		{
			description:
				"Read-only inspection of the three locked Blindmotion outdoor-blinds URLs. Compares stored WordPress/WooCommerce content with rendered HTML, SEO metadata, headings, duplicate headings, Elementor/SEO-plugin metadata inventory and known template-content defects.",
			inputSchema: z.object({
				target: z.enum(["outdoor_blinds", "straight_drop", "zip_sided"]).optional(),
			}),
		},
		async ({ target }) => {
			try {
				const targets = target
					? [target]
					: (Object.keys(OUTDOOR_SEO_TARGETS) as OutdoorSeoTargetKey[]);
				const inspections = [];
				for (const targetKey of targets) {
					inspections.push(await inspectOutdoorSeoTarget(targetKey));
				}
				return toolResult({
					read_only: true,
					locked_target_count: Object.keys(OUTDOOR_SEO_TARGETS).length,
					inspection_count: inspections.length,
					inspections,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"inspect_outdoor_seo_elementor_templates",
		{
			description:
				"Read-only inspection of the fixed Elementor templates rendered by Blindmotion's outdoor product pages. Reports identities, display conditions, relevant widgets, responsive visibility, heading tags and known template-content defects.",
			inputSchema: z.object({
				template_id: z
					.union(OUTDOOR_SEO_ELEMENTOR_TEMPLATE_IDS.map((id) => z.literal(id)))
					.optional(),
			}),
		},
		async ({ template_id }) => {
			try {
				const templateIds = template_id
					? [template_id]
					: [...OUTDOOR_SEO_ELEMENTOR_TEMPLATE_IDS];
				const templates = [];
				for (const templateId of templateIds) {
					templates.push(await inspectOutdoorSeoElementorTemplate(templateId));
				}
				return toolResult({
					read_only: true,
					locked_template_count: OUTDOOR_SEO_ELEMENTOR_TEMPLATE_IDS.length,
					inspection_count: templates.length,
					templates,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"apply_outdoor_seo_fixes_guarded",
		{
			description:
				"Apply the fixed, reviewed Blindmotion outdoor SEO cleanup. Exact product and Elementor hashes, identities and source values must match; removes only two all-device-hidden sections, replaces known placeholder copy, updates three locked product descriptions/Yoast snippets, verifies preflight and attempts rollback on failure.",
			inputSchema: z.object({
				confirmation: z.literal(OUTDOOR_SEO_FIX_CONFIRMATION),
			}),
		},
		async () => {
			try {
				return toolResult(await applyOutdoorSeoFixes());
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
		"inspect_totalblock_elementor_content",
		{
			description:
				"Read-only inspection of product-level Elementor data on locked draft TotalBlock product 9413. Reports only widgets/settings containing inherited ZipGrip or outdoor-blind content, associated image settings and stable hashes. Performs no writes and does not inspect shared templates.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				const [wcResponse, wpResponse] = await Promise.all([
					wcFetch(`products/${TOTALBLOCK_PRODUCT_ID}`),
					wpAuthenticatedFetch(`product/${TOTALBLOCK_PRODUCT_ID}?context=edit`),
				]);
				const product = await wcResponse.json<any>();
				const wpProduct = await wpResponse.json<any>();
				if (
					product.id !== TOTALBLOCK_PRODUCT_ID ||
					product.name !== TOTALBLOCK_PRODUCT_NAME ||
					product.status !== "draft" ||
					product.catalog_visibility !== "hidden"
				) {
					throw new Error(
						"Locked TotalBlock product identity or draft/hidden state changed; refusing inspection.",
					);
				}
				if (wpProduct.id !== TOTALBLOCK_PRODUCT_ID || wpProduct.status !== "draft") {
					throw new Error(
						"Authenticated WordPress TotalBlock identity or draft state changed; refusing inspection.",
					);
				}
				const raw = wpProduct.meta?.["_elementor_data"];
				const data = parseElementorData(raw);
				if (!data || typeof raw !== "string") {
					throw new Error(
						"TotalBlock product-level Elementor data is unavailable or malformed.",
					);
				}
				return toolResult({
					product: {
						id: product.id,
						name: product.name,
						status: product.status,
						catalog_visibility: product.catalog_visibility,
					},
					elementor_data_length: raw.length,
					elementor_data_sha256: await sha256Hex(new TextEncoder().encode(raw)),
					inherited_content_matches: totalBlockElementorMatches(data),
					write_performed: false,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"apply_totalblock_product_content_guarded",
		{
			description:
				"Apply the fixed, reviewed TotalBlock identity, internal-blind category, product copy and Yoast SEO fields only to locked product 9413. Requires the exact cloned draft identity and SEO source state, forces DRAFT/hidden status, does not change prices, images, attributes, product options or other metadata, and cannot publish the product.",
			inputSchema: z.object({
				product_id: z.literal(TOTALBLOCK_PRODUCT_ID),
				expected_name: z.literal(TOTALBLOCK_PRODUCT_NAME),
				confirmation: z.literal(TOTALBLOCK_PRODUCT_CONFIRMATION),
			}),
		},
		async () => {
			try {
				const [targetResponse, sourceResponse, categoryResponse, slugResponse] =
					await Promise.all([
						wcFetch(`products/${TOTALBLOCK_PRODUCT_ID}`),
						wcFetch("products/1301"),
						wcFetch(`products/categories/${TOTALBLOCK_PRODUCT_CATEGORY_ID}`),
						wcFetch("products", {
							slug: TOTALBLOCK_PRODUCT_SLUG,
							status: "any",
							per_page: 100,
						}),
					]);
				const target = await targetResponse.json<any>();
				const source = await sourceResponse.json<any>();
				const category = await categoryResponse.json<any>();
				const slugMatches = await slugResponse.json<any[]>();

				if (
					target.id !== TOTALBLOCK_PRODUCT_ID ||
					target.name !== TOTALBLOCK_PRODUCT_NAME ||
					target.status !== "draft" ||
					target.catalog_visibility !== "hidden"
				) {
					throw new Error(
						"Locked TotalBlock product identity or draft/hidden state changed; refusing the content update.",
					);
				}
				if (
					![
						"",
						"blindmotion-totalblock-cassette-blind",
						TOTALBLOCK_PRODUCT_SLUG,
					].includes(target.slug)
				) {
					throw new Error(
						`Unexpected current slug on locked TotalBlock product: ${target.slug}.`,
					);
				}
				if (source.id !== 1301 || source.name !== "Zip Sided Outdoor Blinds") {
					throw new Error(
						"Source product 1301 identity changed; refusing the content update.",
					);
				}
				if (
					category.id !== TOTALBLOCK_PRODUCT_CATEGORY_ID ||
					category.name !== "Blinds [Geo]"
				) {
					throw new Error("Locked internal-blinds category 74 identity changed.");
				}
				const slugConflict = slugMatches.find(
					(product) => product.id !== TOTALBLOCK_PRODUCT_ID,
				);
				if (slugConflict) {
					throw new Error(
						`Slug ${TOTALBLOCK_PRODUCT_SLUG} is already used by product ${slugConflict.id}.`,
					);
				}

				const sourceMeta = new Map<string, string>(
					(source.meta_data ?? []).map((meta: any) => [
						String(meta.key),
						String(meta.value ?? ""),
					]),
				);
				const seoUpdates = [
					["_yoast_wpseo_title", TOTALBLOCK_SEO_TITLE],
					["_yoast_wpseo_metadesc", TOTALBLOCK_SEO_DESCRIPTION],
					["_yoast_wpseo_focuskw", "blockout blinds with side tracks"],
				] as const;
				const metaData = seoUpdates.map(([key, value]) => {
					const currentMatches = (target.meta_data ?? []).filter(
						(meta: any) => meta.key === key,
					);
					if (currentMatches.length > 1) {
						throw new Error(
							`Unexpected product ${target.id} metadata state for ${key}.`,
						);
					}
					const currentValue = String(currentMatches[0]?.value ?? "");
					const expectedSourceValue = sourceMeta.get(key) ?? "";
					if (currentValue !== expectedSourceValue && currentValue !== value) {
						throw new Error(
							`Unexpected product ${target.id} metadata state for ${key}.`,
						);
					}
					return currentMatches.length === 1
						? { id: currentMatches[0].id, key, value }
						: { key, value };
				});

				const updateResponse = await wcWrite(`products/${TOTALBLOCK_PRODUCT_ID}`, {
					name: TOTALBLOCK_PRODUCT_NAME,
					slug: TOTALBLOCK_PRODUCT_SLUG,
					status: "draft",
					catalog_visibility: "hidden",
					description: TOTALBLOCK_DESCRIPTION,
					short_description: TOTALBLOCK_SHORT_DESCRIPTION,
					categories: [{ id: TOTALBLOCK_PRODUCT_CATEGORY_ID }],
					meta_data: metaData,
				});
				await updateResponse.json<any>();

				const verificationResponse = await wcFetch(`products/${TOTALBLOCK_PRODUCT_ID}`);
				const verified = await verificationResponse.json<any>();
				const verifiedMeta = new Map(
					(verified.meta_data ?? []).map((meta: any) => [
						String(meta.key),
						String(meta.value ?? ""),
					]),
				);
				const verificationFailures = [
					verified.name !== TOTALBLOCK_PRODUCT_NAME && "name",
					verified.slug !== TOTALBLOCK_PRODUCT_SLUG && "slug",
					verified.status !== "draft" && "status",
					verified.catalog_visibility !== "hidden" && "catalog_visibility",
					normalizeTotalBlockHtml(verified.description) !==
						normalizeTotalBlockHtml(TOTALBLOCK_DESCRIPTION) && "description",
					normalizeTotalBlockHtml(verified.short_description) !==
						normalizeTotalBlockHtml(TOTALBLOCK_SHORT_DESCRIPTION) &&
						"short_description",
					(verified.categories?.length !== 1 ||
						verified.categories[0]?.id !== TOTALBLOCK_PRODUCT_CATEGORY_ID) &&
						"categories",
					...seoUpdates.map(
						([key, value]) => verifiedMeta.get(key) !== value && `metadata:${key}`,
					),
				].filter(Boolean);
				if (verificationFailures.length > 0) {
					throw new Error(
						`TotalBlock content write failed post-write verification for: ${verificationFailures.join(
							", ",
						)}; product remains draft and hidden.`,
					);
				}

				return toolResult({
					updated: true,
					product: {
						id: verified.id,
						name: verified.name,
						slug: verified.slug,
						status: verified.status,
						catalog_visibility: verified.catalog_visibility,
						category: verified.categories[0],
					},
					seo: {
						title: verifiedMeta.get("_yoast_wpseo_title"),
						meta_description: verifiedMeta.get("_yoast_wpseo_metadesc"),
						focus_keyword: verifiedMeta.get("_yoast_wpseo_focuskw"),
					},
					untouched: [
						"price",
						"images",
						"attributes",
						"product options",
						"non-SEO metadata",
					],
					publication_performed: false,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"inspect_totalblock_blockout_fabric_options",
		{
			description:
				"Read-only inspection of WAPF fabric-option candidates on locked TotalBlock product 9413, Premium Roller Blinds product 4788 and Everyday Roller Blinds product 3839 as the Vibe pricing source. Reports locked fabric slices, choice production values, active pricing fields, fabric pricing-variable definitions, images and conditions without returning unrelated product metadata or performing writes.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				const [targetResponse, sourceResponse, vibeSourceResponse] = await Promise.all([
					wcFetch(`products/${TOTALBLOCK_PRODUCT_ID}`),
					wcFetch(`products/${TOTALBLOCK_FABRIC_SOURCE_ID}`),
					wcFetch(`products/${TOTALBLOCK_VIBE_PRICING_SOURCE_ID}`),
				]);
				const target = await targetResponse.json<any>();
				const source = await sourceResponse.json<any>();
				const vibeSource = await vibeSourceResponse.json<any>();
				if (
					target.id !== TOTALBLOCK_PRODUCT_ID ||
					target.name !== TOTALBLOCK_PRODUCT_NAME ||
					target.status !== "draft" ||
					target.catalog_visibility !== "hidden"
				) {
					throw new Error("Locked TotalBlock identity or draft/hidden state changed.");
				}
				if (
					source.id !== TOTALBLOCK_FABRIC_SOURCE_ID ||
					source.name !== TOTALBLOCK_FABRIC_SOURCE_NAME ||
					source.status !== "publish"
				) {
					throw new Error("Locked Premium Roller Blinds source identity changed.");
				}
				if (
					vibeSource.id !== TOTALBLOCK_VIBE_PRICING_SOURCE_ID ||
					vibeSource.name !== TOTALBLOCK_VIBE_PRICING_SOURCE_NAME ||
					vibeSource.status !== "publish"
				) {
					throw new Error("Locked Everyday Roller Blinds Vibe pricing source changed.");
				}

				async function inspect(product: any, lockedSlice: readonly [number, number]) {
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
					const serialized = JSON.stringify(matches[0].value);
					return {
						product: { id: product.id, name: product.name, status: product.status },
						meta_data_id: matches[0].id,
						field_group_sha256: await sha256Hex(new TextEncoder().encode(serialized)),
						field_count: group.fields.length,
						fabric_candidates: wapfFabricCandidates(group),
						locked_fabric_slice: group.fields
							.slice(lockedSlice[0], lockedSlice[1] + 1)
							.map((field: any, offset: number) =>
								wapfFieldSummary(field, lockedSlice[0] + offset),
							),
						pricing_context: wapfPricingContext(group),
						fabric_pricing_definitions: wapfFabricPricingDefinitions(group),
					};
				}

				return toolResult({
					read_only: true,
					target: await inspect(target, [7, 12]),
					source: await inspect(source, [126, 130]),
					vibe_pricing_source: await inspect(vibeSource, [0, -1]),
					write_performed: false,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"install_totalblock_blockout_fabrics_guarded",
		{
			description:
				"Install only the reviewed internal blockout fabric subtree on locked draft TotalBlock product 9413: discounted Vibe plus premium LeReve, Linesque and Palm Beach, with conditional colours and source-derived pricing groups. Exact identities, WAPF IDs and inspected hashes must match. Removes only the inherited outdoor fabric subtree, forces draft/hidden state, verifies untouched product data and performs an exact rollback on failure. Cannot publish the product.",
			inputSchema: z.object({
				product_id: z.literal(TOTALBLOCK_PRODUCT_ID),
				premium_source_product_id: z.literal(TOTALBLOCK_FABRIC_SOURCE_ID),
				vibe_source_product_id: z.literal(TOTALBLOCK_VIBE_PRICING_SOURCE_ID),
				confirmation: z.literal(TOTALBLOCK_FABRIC_WRITE_CONFIRMATION),
			}),
		},
		async () => {
			try {
				const responses = await Promise.all([
					wcFetch(`products/${TOTALBLOCK_PRODUCT_ID}`),
					wcFetch(`products/${TOTALBLOCK_FABRIC_SOURCE_ID}`),
					wcFetch(`products/${TOTALBLOCK_VIBE_PRICING_SOURCE_ID}`),
				]);
				const [target, premium, everyday] = await Promise.all(
					responses.map((response) => response.json<any>()),
				);
				if (
					target.id !== TOTALBLOCK_PRODUCT_ID ||
					target.name !== TOTALBLOCK_PRODUCT_NAME ||
					target.slug !== TOTALBLOCK_PRODUCT_SLUG ||
					target.status !== "draft" ||
					target.catalog_visibility !== "hidden"
				) {
					throw new Error("Locked TotalBlock identity or draft/hidden state changed.");
				}
				if (
					premium.id !== TOTALBLOCK_FABRIC_SOURCE_ID ||
					premium.name !== TOTALBLOCK_FABRIC_SOURCE_NAME ||
					premium.status !== "publish"
				) {
					throw new Error("Locked Premium Roller Blinds source identity changed.");
				}
				if (
					everyday.id !== TOTALBLOCK_VIBE_PRICING_SOURCE_ID ||
					everyday.name !== TOTALBLOCK_VIBE_PRICING_SOURCE_NAME ||
					everyday.status !== "publish"
				) {
					throw new Error("Locked Everyday Roller Blinds source identity changed.");
				}

				function lockedWapf(product: any, metaId: number) {
					const matches = (product.meta_data ?? []).filter(
						(meta: any) => String(meta.key) === "_wapf_fieldgroup",
					);
					if (matches.length !== 1 || matches[0].id !== metaId) {
						throw new Error(
							`Locked WAPF metadata ${metaId} changed on product ${product.id}.`,
						);
					}
					const group = parseWapfFieldGroup(matches[0].value);
					if (!group || !Array.isArray(group.fields)) {
						throw new Error(`Product ${product.id} WAPF group is not readable.`);
					}
					return { meta: matches[0], group };
				}

				const targetWapf = lockedWapf(target, TOTALBLOCK_FABRIC_TARGET_META_ID);
				const premiumWapf = lockedWapf(premium, TOTALBLOCK_FABRIC_SOURCE_META_ID);
				const vibeWapf = lockedWapf(everyday, TOTALBLOCK_VIBE_SOURCE_META_ID);
				const hashes = await Promise.all(
					[targetWapf.meta.value, premiumWapf.meta.value, vibeWapf.meta.value].map(
						(value) => sha256Hex(new TextEncoder().encode(JSON.stringify(value))),
					),
				);
				if (
					hashes[0] !== TOTALBLOCK_FABRIC_TARGET_HASH ||
					hashes[1] !== TOTALBLOCK_FABRIC_SOURCE_HASH ||
					hashes[2] !== TOTALBLOCK_VIBE_SOURCE_HASH
				) {
					throw new Error(
						"A locked WAPF source changed after inspection; refusing write.",
					);
				}
				if (
					targetWapf.group.fields.length !== 26 ||
					premiumWapf.group.fields.length !== 144 ||
					vibeWapf.group.fields.length !== 125
				) {
					throw new Error("A locked WAPF field count changed after inspection.");
				}

				const oldFabricFields = targetWapf.group.fields.slice(7, 15);
				const oldLabels = oldFabricFields.map(wapfFieldLabel);
				const expectedOldLabels = [
					"Fabric Options",
					"Skyline 94 Colours",
					"Skyline 99 Colours",
					"Vistaweave 95 Colours",
					"Vistaweave Privacy 99 Colours",
					"Vistaweave MAX Blockout Colours",
					"1mm PVC Colours",
					"MegaScreen 80 Colour",
				];
				if (JSON.stringify(oldLabels) !== JSON.stringify(expectedOldLabels)) {
					throw new Error("TotalBlock outdoor fabric subtree changed after inspection.");
				}
				const premiumFields = premiumWapf.group.fields.slice(126, 131);
				if (
					JSON.stringify(premiumFields.map(wapfFieldLabel)) !==
					JSON.stringify([
						"Blockout Fabric Options",
						"LeReve blockout colours",
						"Linesque BO Colours",
						"Palm Beach blockout colours",
						"Vibe Blockout Colours",
					])
				) {
					throw new Error("Premium blockout fabric subtree changed after inspection.");
				}
				const everydaySelector = vibeWapf.group.fields[111];
				const vibeChoice = everydaySelector?.options?.choices?.[0];
				if (
					wapfFieldLabel(everydaySelector) !== "Blockout Fabric Options" ||
					vibeChoice?.label !== "Vibe Blockout" ||
					vibeChoice?.slug !== "g5ugt" ||
					vibeChoice?.attachment !== 4957
				) {
					throw new Error("Everyday Vibe selector identity changed after inspection.");
				}

				const removedIds = oldFabricFields.map((field: any) => String(field.id));
				const retainedFields = [
					...targetWapf.group.fields.slice(0, 7),
					...targetWapf.group.fields.slice(15),
				];
				const retainedSerialized = JSON.stringify(retainedFields);
				const staleReferences = removedIds.filter((id: string) =>
					retainedSerialized.includes(id),
				);
				if (staleReferences.length > 0) {
					throw new Error(
						`Retained TotalBlock fields reference removed fabric IDs: ${staleReferences}.`,
					);
				}

				const newFabricFields = JSON.parse(
					JSON.stringify(premiumFields).replaceAll(
						"https://staging-online.blindmotion.com.au/",
						"https://online.blindmotion.com.au/",
					),
				);
				const selector = newFabricFields[0];
				selector.conditionals = [];
				if (
					JSON.stringify(selector.options?.choices?.map((choice: any) => choice.slug)) !==
					JSON.stringify(["mdvec", "hlmfv", "dy9ua"])
				) {
					throw new Error("Premium blockout selector choices changed after inspection.");
				}
				const newVibeChoice = JSON.parse(JSON.stringify(vibeChoice));
				newVibeChoice.label = "Vibe";
				selector.options.choices.push(newVibeChoice);
				const widthId = "6714d030794c6";
				const dropId = "6714d0303b92e";
				const pricingBySlug: Record<string, string> = {
					mdvec: `lookuptable(rollerfabricgrp8_50pcgmgst_12000w;${widthId};${dropId})*[qty]`,
					hlmfv: `lookuptable(roller_fabric_grp9_12000w_50pcgm_gst;${widthId};${dropId})*[qty]`,
					dy9ua: `lookuptable(rollerfabricgrp8_50pcgmgst_12000w;${widthId};${dropId})*[qty]`,
					g5ugt: `lookuptable(roller_fabric_grp2_12000w_50pcgm_gst;${widthId};${dropId})*[qty]`,
				};
				for (const choice of selector.options.choices) {
					const formula = pricingBySlug[String(choice.slug)];
					if (!formula)
						throw new Error(`Unexpected TotalBlock fabric choice ${choice.slug}.`);
					choice.pricing_type = "fx";
					choice.pricing_amount = formula;
				}
				newFabricFields[4].conditionals = [
					{
						rules: [
							{
								condition: "==",
								value: "g5ugt",
								field: selector.id,
								generated: false,
							},
						],
					},
				];
				const newIds = newFabricFields.map((field: any) => String(field.id));
				const conflictingNewIds = newIds.filter((id: string) =>
					retainedSerialized.includes(id),
				);
				if (new Set(newIds).size !== newIds.length || conflictingNewIds.length > 0) {
					throw new Error(
						"New TotalBlock fabric field IDs are duplicated or conflict with retained fields.",
					);
				}
				const conditionalFieldIds = [
					...JSON.stringify(newFabricFields.slice(1)).matchAll(/"field":"([^"]+)"/g),
				].map((match) => match[1]);
				if (conditionalFieldIds.some((id) => !newIds.includes(id))) {
					throw new Error(
						"New TotalBlock fabric subtree has an external field dependency.",
					);
				}

				const updatedGroup = JSON.parse(JSON.stringify(targetWapf.group));
				updatedGroup.fields.splice(7, 8, ...newFabricFields);
				const originalValue = targetWapf.meta.value;
				const untouchedState = JSON.stringify({
					name: target.name,
					slug: target.slug,
					price: target.price,
					regular_price: target.regular_price,
					sale_price: target.sale_price,
					description: target.description,
					short_description: target.short_description,
					images: target.images,
					categories: target.categories,
					attributes: target.attributes,
				});

				try {
					await wcWrite(`products/${TOTALBLOCK_PRODUCT_ID}`, {
						status: "draft",
						catalog_visibility: "hidden",
						meta_data: [
							{
								id: TOTALBLOCK_FABRIC_TARGET_META_ID,
								key: "_wapf_fieldgroup",
								value: updatedGroup,
							},
						],
					});
					const verificationResponse = await wcFetch(`products/${TOTALBLOCK_PRODUCT_ID}`);
					const verified = await verificationResponse.json<any>();
					const verifiedWapf = lockedWapf(verified, TOTALBLOCK_FABRIC_TARGET_META_ID);
					const verifiedState = JSON.stringify({
						name: verified.name,
						slug: verified.slug,
						price: verified.price,
						regular_price: verified.regular_price,
						sale_price: verified.sale_price,
						description: verified.description,
						short_description: verified.short_description,
						images: verified.images,
						categories: verified.categories,
						attributes: verified.attributes,
					});
					if (
						verified.status !== "draft" ||
						verified.catalog_visibility !== "hidden" ||
						verifiedWapf.group.fields.length !== 23 ||
						JSON.stringify(verifiedWapf.group) !== JSON.stringify(updatedGroup) ||
						verifiedState !== untouchedState
					) {
						throw new Error("Post-write TotalBlock fabric verification failed.");
					}
					return toolResult({
						updated: true,
						product: {
							id: verified.id,
							name: verified.name,
							status: verified.status,
							catalog_visibility: verified.catalog_visibility,
							price: verified.price,
						},
						fabric_ranges: ["Vibe", "LeReve", "Linesque", "Palm Beach"],
						pricing_groups: { Vibe: 2, LeReve: 8, Linesque: 9, "Palm Beach": 8 },
						colour_choice_count: 45,
						removed_outdoor_fabric_fields: expectedOldLabels,
						publication_performed: false,
					});
				} catch (writeError) {
					await wcWrite(`products/${TOTALBLOCK_PRODUCT_ID}`, {
						status: "draft",
						catalog_visibility: "hidden",
						meta_data: [
							{
								id: TOTALBLOCK_FABRIC_TARGET_META_ID,
								key: "_wapf_fieldgroup",
								value: originalValue,
							},
						],
					});
					const rollbackResponse = await wcFetch(`products/${TOTALBLOCK_PRODUCT_ID}`);
					const rolledBack = await rollbackResponse.json<any>();
					const rolledBackWapf = lockedWapf(rolledBack, TOTALBLOCK_FABRIC_TARGET_META_ID);
					const rollbackHash = await sha256Hex(
						new TextEncoder().encode(JSON.stringify(rolledBackWapf.meta.value)),
					);
					if (
						rolledBack.status !== "draft" ||
						rolledBack.catalog_visibility !== "hidden" ||
						rollbackHash !== TOTALBLOCK_FABRIC_TARGET_HASH
					) {
						const rollbackError = new Error(
							"TotalBlock fabric write and rollback verification both failed.",
						);
						(rollbackError as any).cause = writeError;
						throw rollbackError;
					}
					const rolledBackError = new Error(
						`TotalBlock fabric write failed; exact rollback succeeded: ${
							writeError instanceof Error ? writeError.message : String(writeError)
						}`,
					);
					(rolledBackError as any).cause = writeError;
					throw rolledBackError;
				}
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"add_totalblock_duo_block_guarded",
		{
			description:
				"Add only Duo Block and its eight reviewed colours from locked Everyday Roller Blinds product 3839 to the already-installed TotalBlock blockout fabric subtree on draft product 9413. Uses fabric pricing group 3, preserves every unrelated field and product value, forces draft/hidden state, verifies the exact result and rolls back on failure. Cannot publish the product.",
			inputSchema: z.object({
				product_id: z.literal(TOTALBLOCK_PRODUCT_ID),
				source_product_id: z.literal(TOTALBLOCK_VIBE_PRICING_SOURCE_ID),
				confirmation: z.literal(TOTALBLOCK_DUO_BLOCK_CONFIRMATION),
			}),
		},
		async () => {
			try {
				const [targetResponse, sourceResponse] = await Promise.all([
					wcFetch(`products/${TOTALBLOCK_PRODUCT_ID}`),
					wcFetch(`products/${TOTALBLOCK_VIBE_PRICING_SOURCE_ID}`),
				]);
				const [target, source] = await Promise.all([
					targetResponse.json<any>(),
					sourceResponse.json<any>(),
				]);
				if (
					target.id !== TOTALBLOCK_PRODUCT_ID ||
					target.name !== TOTALBLOCK_PRODUCT_NAME ||
					target.slug !== TOTALBLOCK_PRODUCT_SLUG ||
					target.status !== "draft" ||
					target.catalog_visibility !== "hidden"
				) {
					throw new Error("Locked TotalBlock identity or draft/hidden state changed.");
				}
				if (
					source.id !== TOTALBLOCK_VIBE_PRICING_SOURCE_ID ||
					source.name !== TOTALBLOCK_VIBE_PRICING_SOURCE_NAME ||
					source.status !== "publish"
				) {
					throw new Error("Locked Everyday Roller Blinds source identity changed.");
				}

				function lockedWapf(product: any, metaId: number) {
					const matches = (product.meta_data ?? []).filter(
						(meta: any) => String(meta.key) === "_wapf_fieldgroup",
					);
					if (matches.length !== 1 || matches[0].id !== metaId) {
						throw new Error(
							`Locked WAPF metadata ${metaId} changed on product ${product.id}.`,
						);
					}
					const group = parseWapfFieldGroup(matches[0].value);
					if (!group || !Array.isArray(group.fields)) {
						throw new Error(`Product ${product.id} WAPF group is not readable.`);
					}
					return { meta: matches[0], group };
				}

				const targetWapf = lockedWapf(target, TOTALBLOCK_FABRIC_TARGET_META_ID);
				const sourceWapf = lockedWapf(source, TOTALBLOCK_VIBE_SOURCE_META_ID);
				const [targetHash, sourceHash] = await Promise.all(
					[targetWapf.meta.value, sourceWapf.meta.value].map((value) =>
						sha256Hex(new TextEncoder().encode(JSON.stringify(value))),
					),
				);
				if (
					targetHash !== TOTALBLOCK_FABRIC_INSTALLED_HASH ||
					sourceHash !== TOTALBLOCK_VIBE_SOURCE_HASH ||
					targetWapf.group.fields.length !== 23 ||
					sourceWapf.group.fields.length !== 125
				) {
					throw new Error(
						"A locked TotalBlock or Duo Block source changed; refusing write.",
					);
				}

				const selector = targetWapf.group.fields[7];
				const targetColourFields = targetWapf.group.fields.slice(8, 12);
				if (
					String(selector?.id) !== "690277bc86553" ||
					wapfFieldLabel(selector) !== "Blockout Fabric Options" ||
					JSON.stringify(
						selector?.options?.choices?.map((choice: any) => choice.slug),
					) !== JSON.stringify(["mdvec", "hlmfv", "dy9ua", "g5ugt"]) ||
					JSON.stringify(targetColourFields.map(wapfFieldLabel)) !==
						JSON.stringify([
							"LeReve blockout colours",
							"Linesque BO Colours",
							"Palm Beach blockout colours",
							"Vibe Blockout Colours",
						])
				) {
					throw new Error("Installed TotalBlock fabric subtree changed.");
				}

				const sourceSelector = sourceWapf.group.fields[111];
				const duoChoice = sourceSelector?.options?.choices?.[1];
				const duoColours = sourceWapf.group.fields[113];
				const expectedColours = [
					["Aztec", "63rcp", 8243],
					["Basalt", "sev54", 4959],
					["Cumulus", "hjkq3", 8246],
					["Salt", "adqyf", 4963],
					["Shadow", "x0ga8", 58],
					["Dove", "dnr1m", 4960],
					["Muse", "7pgj4", 9416],
					["Nova", "0pxql", 4962],
				];
				if (
					wapfFieldLabel(sourceSelector) !== "Blockout Fabric Options" ||
					duoChoice?.label !== "Duo Block" ||
					duoChoice?.slug !== "k0gr7" ||
					duoChoice?.attachment !== 4967 ||
					String(duoColours?.id) !== "651e63fe0c2f8" ||
					wapfFieldLabel(duoColours) !== "Duo Blockout Colours" ||
					JSON.stringify(
						duoColours?.options?.choices?.map((choice: any) => [
							choice.label,
							choice.slug,
							choice.attachment,
						]),
					) !== JSON.stringify(expectedColours)
				) {
					throw new Error("Everyday Duo Block source changed after inspection.");
				}

				const updatedGroup = JSON.parse(JSON.stringify(targetWapf.group));
				const updatedSelector = updatedGroup.fields[7];
				const newChoice = JSON.parse(JSON.stringify(duoChoice));
				newChoice.pricing_type = "fx";
				newChoice.pricing_amount =
					"lookuptable(rollerfabricgrp3_50pcgmgst_12000w;6714d030794c6;6714d0303b92e)*[qty]";
				updatedSelector.options.choices.push(newChoice);
				const newColours = JSON.parse(
					JSON.stringify(duoColours).replaceAll(
						"https://staging-online.blindmotion.com.au/",
						"https://online.blindmotion.com.au/",
					),
				);
				newColours.conditionals = [
					{
						rules: [
							{
								condition: "==",
								value: "k0gr7",
								field: updatedSelector.id,
								generated: false,
							},
						],
					},
				];
				const retainedSerialized = JSON.stringify(updatedGroup.fields);
				if (retainedSerialized.includes(`"id":"${newColours.id}"`)) {
					throw new Error(
						"Duo Block colour field ID conflicts with retained TotalBlock fields.",
					);
				}
				updatedGroup.fields.splice(12, 0, newColours);

				const originalValue = targetWapf.meta.value;
				const untouchedState = JSON.stringify({
					name: target.name,
					slug: target.slug,
					price: target.price,
					regular_price: target.regular_price,
					sale_price: target.sale_price,
					description: target.description,
					short_description: target.short_description,
					images: target.images,
					categories: target.categories,
					attributes: target.attributes,
				});

				try {
					await wcWrite(`products/${TOTALBLOCK_PRODUCT_ID}`, {
						status: "draft",
						catalog_visibility: "hidden",
						meta_data: [
							{
								id: TOTALBLOCK_FABRIC_TARGET_META_ID,
								key: "_wapf_fieldgroup",
								value: updatedGroup,
							},
						],
					});
					const verificationResponse = await wcFetch(`products/${TOTALBLOCK_PRODUCT_ID}`);
					const verified = await verificationResponse.json<any>();
					const verifiedWapf = lockedWapf(verified, TOTALBLOCK_FABRIC_TARGET_META_ID);
					const verifiedState = JSON.stringify({
						name: verified.name,
						slug: verified.slug,
						price: verified.price,
						regular_price: verified.regular_price,
						sale_price: verified.sale_price,
						description: verified.description,
						short_description: verified.short_description,
						images: verified.images,
						categories: verified.categories,
						attributes: verified.attributes,
					});
					const verifiedSelector = verifiedWapf.group.fields[7];
					if (
						verified.status !== "draft" ||
						verified.catalog_visibility !== "hidden" ||
						verifiedWapf.group.fields.length !== 24 ||
						JSON.stringify(verifiedWapf.group) !== JSON.stringify(updatedGroup) ||
						verifiedState !== untouchedState ||
						JSON.stringify(
							verifiedSelector.options.choices.map((choice: any) => choice.label),
						) !==
							JSON.stringify([
								"LeReve",
								"Linesque",
								"Palm Beach",
								"Vibe",
								"Duo Block",
							])
					) {
						throw new Error("Post-write TotalBlock Duo Block verification failed.");
					}
					return toolResult({
						updated: true,
						product: {
							id: verified.id,
							name: verified.name,
							status: verified.status,
							catalog_visibility: verified.catalog_visibility,
							price: verified.price,
						},
						fabric_ranges: ["LeReve", "Linesque", "Palm Beach", "Vibe", "Duo Block"],
						duo_block_colours: expectedColours.map(([label]) => label),
						pricing_group: 3,
						publication_performed: false,
					});
				} catch (writeError) {
					await wcWrite(`products/${TOTALBLOCK_PRODUCT_ID}`, {
						status: "draft",
						catalog_visibility: "hidden",
						meta_data: [
							{
								id: TOTALBLOCK_FABRIC_TARGET_META_ID,
								key: "_wapf_fieldgroup",
								value: originalValue,
							},
						],
					});
					const rollbackResponse = await wcFetch(`products/${TOTALBLOCK_PRODUCT_ID}`);
					const rolledBack = await rollbackResponse.json<any>();
					const rolledBackWapf = lockedWapf(rolledBack, TOTALBLOCK_FABRIC_TARGET_META_ID);
					const rollbackHash = await sha256Hex(
						new TextEncoder().encode(JSON.stringify(rolledBackWapf.meta.value)),
					);
					if (
						rolledBack.status !== "draft" ||
						rolledBack.catalog_visibility !== "hidden" ||
						rollbackHash !== TOTALBLOCK_FABRIC_INSTALLED_HASH
					) {
						const rollbackError = new Error(
							"TotalBlock Duo Block write and rollback verification both failed.",
						);
						(rollbackError as any).cause = writeError;
						throw rollbackError;
					}
					const rolledBackError = new Error(
						`TotalBlock Duo Block write failed; exact rollback succeeded: ${
							writeError instanceof Error ? writeError.message : String(writeError)
						}`,
					);
					(rolledBackError as any).cause = writeError;
					throw rolledBackError;
				}
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"add_totalblock_sanctuary_guarded",
		{
			description:
				"Add only Sanctuary Blockout and its ten reviewed colours from locked Everyday Roller Blinds product 3839 to the already-installed TotalBlock blockout fabric subtree on draft product 9413. Uses fabric pricing group 6 and excludes Sanctuary Light Filter, preserves every unrelated field and product value, forces draft/hidden state, verifies the exact result and rolls back on failure. Cannot publish the product.",
			inputSchema: z.object({
				product_id: z.literal(TOTALBLOCK_PRODUCT_ID),
				source_product_id: z.literal(TOTALBLOCK_VIBE_PRICING_SOURCE_ID),
				confirmation: z.literal(TOTALBLOCK_SANCTUARY_CONFIRMATION),
			}),
		},
		async () => {
			try {
				const [targetResponse, sourceResponse] = await Promise.all([
					wcFetch(`products/${TOTALBLOCK_PRODUCT_ID}`),
					wcFetch(`products/${TOTALBLOCK_VIBE_PRICING_SOURCE_ID}`),
				]);
				const [target, source] = await Promise.all([
					targetResponse.json<any>(),
					sourceResponse.json<any>(),
				]);
				if (
					target.id !== TOTALBLOCK_PRODUCT_ID ||
					target.name !== TOTALBLOCK_PRODUCT_NAME ||
					target.slug !== TOTALBLOCK_PRODUCT_SLUG ||
					target.status !== "draft" ||
					target.catalog_visibility !== "hidden"
				) {
					throw new Error("Locked TotalBlock identity or draft/hidden state changed.");
				}
				if (
					source.id !== TOTALBLOCK_VIBE_PRICING_SOURCE_ID ||
					source.name !== TOTALBLOCK_VIBE_PRICING_SOURCE_NAME ||
					source.status !== "publish"
				) {
					throw new Error("Locked Everyday Roller Blinds source identity changed.");
				}

				function lockedWapf(product: any, metaId: number) {
					const matches = (product.meta_data ?? []).filter(
						(meta: any) => String(meta.key) === "_wapf_fieldgroup",
					);
					if (matches.length !== 1 || matches[0].id !== metaId) {
						throw new Error(
							`Locked WAPF metadata ${metaId} changed on product ${product.id}.`,
						);
					}
					const group = parseWapfFieldGroup(matches[0].value);
					if (!group || !Array.isArray(group.fields)) {
						throw new Error(`Product ${product.id} WAPF group is not readable.`);
					}
					return { meta: matches[0], group };
				}

				const targetWapf = lockedWapf(target, TOTALBLOCK_FABRIC_TARGET_META_ID);
				const sourceWapf = lockedWapf(source, TOTALBLOCK_VIBE_SOURCE_META_ID);
				const [targetHash, sourceHash] = await Promise.all(
					[targetWapf.meta.value, sourceWapf.meta.value].map((value) =>
						sha256Hex(new TextEncoder().encode(JSON.stringify(value))),
					),
				);
				if (
					targetHash !== TOTALBLOCK_DUO_BLOCK_INSTALLED_HASH ||
					sourceHash !== TOTALBLOCK_VIBE_SOURCE_HASH ||
					targetWapf.group.fields.length !== 24 ||
					sourceWapf.group.fields.length !== 125
				) {
					throw new Error(
						"A locked TotalBlock or Sanctuary source changed; refusing write.",
					);
				}

				const selector = targetWapf.group.fields[7];
				const targetColourFields = targetWapf.group.fields.slice(8, 13);
				if (
					String(selector?.id) !== "690277bc86553" ||
					wapfFieldLabel(selector) !== "Blockout Fabric Options" ||
					JSON.stringify(
						selector?.options?.choices?.map((choice: any) => choice.slug),
					) !== JSON.stringify(["mdvec", "hlmfv", "dy9ua", "g5ugt", "k0gr7"]) ||
					JSON.stringify(targetColourFields.map(wapfFieldLabel)) !==
						JSON.stringify([
							"LeReve blockout colours",
							"Linesque BO Colours",
							"Palm Beach blockout colours",
							"Vibe Blockout Colours",
							"Duo Blockout Colours",
						])
				) {
					throw new Error("Installed TotalBlock fabric subtree changed.");
				}

				const sourceSelector = sourceWapf.group.fields[111];
				const sanctuaryChoice = sourceSelector?.options?.choices?.find(
					(choice: any) => choice.slug === "eqis3",
				);
				const sanctuaryColours = sourceWapf.group.fields.find(
					(field: any) => String(field?.id) === "698076068f9f0",
				);
				const expectedColours = [
					["Baltic", "gjziy", 8807],
					["Ceramic", "7elhw", 8813],
					["Fossil", "qegps", 8811],
					["Limestone", "ch1fd", 8814],
					["Marble", "kqttw", 8815],
					["Mineral", "3j2ob", 8809],
					["Plaster", "8w0yu", 8816],
					["Slate", "8hoea", 8808],
					["Suede", "lejmd", 8810],
					["Truffle", "qynf6", 8812],
				];
				if (
					wapfFieldLabel(sourceSelector) !== "Blockout Fabric Options" ||
					sanctuaryChoice?.label !== "Sanctuary Blockout" ||
					sanctuaryChoice?.slug !== "eqis3" ||
					sanctuaryChoice?.attachment !== 8818 ||
					wapfFieldLabel(sanctuaryColours) !== "Sanctuary Blockout Colours" ||
					JSON.stringify(
						sanctuaryColours?.options?.choices?.map((choice: any) => [
							choice.label,
							choice.slug,
							choice.attachment,
						]),
					) !== JSON.stringify(expectedColours)
				) {
					throw new Error("Everyday Sanctuary source changed after inspection.");
				}

				const updatedGroup = JSON.parse(JSON.stringify(targetWapf.group));
				const updatedSelector = updatedGroup.fields[7];
				const newChoice = JSON.parse(JSON.stringify(sanctuaryChoice));
				newChoice.pricing_type = "fx";
				newChoice.label = "Sanctuary";
				newChoice.pricing_amount =
					"lookuptable(rollerfabricgrp6_50pcgmgst_12000w;6714d030794c6;6714d0303b92e)*[qty]";
				updatedSelector.options.choices.push(newChoice);
				const newColours = JSON.parse(
					JSON.stringify(sanctuaryColours).replaceAll(
						"https://staging-online.blindmotion.com.au/",
						"https://online.blindmotion.com.au/",
					),
				);
				newColours.conditionals = [
					{
						rules: [
							{
								condition: "==",
								value: "eqis3",
								field: updatedSelector.id,
								generated: false,
							},
						],
					},
				];
				const retainedSerialized = JSON.stringify(updatedGroup.fields);
				if (retainedSerialized.includes(`"id":"${newColours.id}"`)) {
					throw new Error(
						"Sanctuary colour field ID conflicts with retained TotalBlock fields.",
					);
				}
				updatedGroup.fields.splice(13, 0, newColours);

				const originalValue = targetWapf.meta.value;
				const untouchedState = JSON.stringify({
					name: target.name,
					slug: target.slug,
					price: target.price,
					regular_price: target.regular_price,
					sale_price: target.sale_price,
					description: target.description,
					short_description: target.short_description,
					images: target.images,
					categories: target.categories,
					attributes: target.attributes,
				});

				try {
					await wcWrite(`products/${TOTALBLOCK_PRODUCT_ID}`, {
						status: "draft",
						catalog_visibility: "hidden",
						meta_data: [
							{
								id: TOTALBLOCK_FABRIC_TARGET_META_ID,
								key: "_wapf_fieldgroup",
								value: updatedGroup,
							},
						],
					});
					const verificationResponse = await wcFetch(`products/${TOTALBLOCK_PRODUCT_ID}`);
					const verified = await verificationResponse.json<any>();
					const verifiedWapf = lockedWapf(verified, TOTALBLOCK_FABRIC_TARGET_META_ID);
					const verifiedState = JSON.stringify({
						name: verified.name,
						slug: verified.slug,
						price: verified.price,
						regular_price: verified.regular_price,
						sale_price: verified.sale_price,
						description: verified.description,
						short_description: verified.short_description,
						images: verified.images,
						categories: verified.categories,
						attributes: verified.attributes,
					});
					const verifiedSelector = verifiedWapf.group.fields[7];
					if (
						verified.status !== "draft" ||
						verified.catalog_visibility !== "hidden" ||
						verifiedWapf.group.fields.length !== 25 ||
						JSON.stringify(verifiedWapf.group) !== JSON.stringify(updatedGroup) ||
						verifiedState !== untouchedState ||
						JSON.stringify(
							verifiedSelector.options.choices.map((choice: any) => choice.label),
						) !==
							JSON.stringify([
								"LeReve",
								"Linesque",
								"Palm Beach",
								"Vibe",
								"Duo Block",
								"Sanctuary",
							])
					) {
						throw new Error("Post-write TotalBlock Sanctuary verification failed.");
					}
					return toolResult({
						updated: true,
						product: {
							id: verified.id,
							name: verified.name,
							status: verified.status,
							catalog_visibility: verified.catalog_visibility,
							price: verified.price,
						},
						fabric_ranges: [
							"LeReve",
							"Linesque",
							"Palm Beach",
							"Vibe",
							"Duo Block",
							"Sanctuary",
						],
						sanctuary_colours: expectedColours.map(([label]) => label),
						pricing_group: 6,
						publication_performed: false,
					});
				} catch (writeError) {
					await wcWrite(`products/${TOTALBLOCK_PRODUCT_ID}`, {
						status: "draft",
						catalog_visibility: "hidden",
						meta_data: [
							{
								id: TOTALBLOCK_FABRIC_TARGET_META_ID,
								key: "_wapf_fieldgroup",
								value: originalValue,
							},
						],
					});
					const rollbackResponse = await wcFetch(`products/${TOTALBLOCK_PRODUCT_ID}`);
					const rolledBack = await rollbackResponse.json<any>();
					const rolledBackWapf = lockedWapf(rolledBack, TOTALBLOCK_FABRIC_TARGET_META_ID);
					const rollbackHash = await sha256Hex(
						new TextEncoder().encode(JSON.stringify(rolledBackWapf.meta.value)),
					);
					if (
						rolledBack.status !== "draft" ||
						rolledBack.catalog_visibility !== "hidden" ||
						rollbackHash !== TOTALBLOCK_DUO_BLOCK_INSTALLED_HASH
					) {
						const rollbackError = new Error(
							"TotalBlock Sanctuary write and rollback verification both failed.",
						);
						(rollbackError as any).cause = writeError;
						throw rollbackError;
					}
					const rolledBackError = new Error(
						`TotalBlock Sanctuary write failed; exact rollback succeeded: ${
							writeError instanceof Error ? writeError.message : String(writeError)
						}`,
					);
					(rolledBackError as any).cause = writeError;
					throw rolledBackError;
				}
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
		"replace_totalblock_featured_image_guarded",
		{
			description: `Upload or reuse an approved image and replace only the featured image of TotalBlock product ${TOTALBLOCK_PRODUCT_ID}. Preserves gallery images and all product configuration, records the previous attachment for rollback, and requires exact confirmation: ${TOTALBLOCK_FEATURED_IMAGE_CONFIRMATION}`,
			inputSchema: z
				.object({
					expected_current_attachment_id: z
						.literal(TOTALBLOCK_EXPECTED_FEATURED_IMAGE_ID)
						.default(TOTALBLOCK_EXPECTED_FEATURED_IMAGE_ID),
					replacement_attachment_id: z.number().int().positive().optional(),
					replacement_filename: z
						.string()
						.regex(/^[A-Za-z0-9._-]+$/)
						.optional(),
					replacement_mime_type: z
						.enum(["image/jpeg", "image/png", "image/webp"])
						.optional(),
					replacement_base64: z.string().min(4).max(8_000_000).optional(),
					alt_text: z
						.string()
						.trim()
						.min(1)
						.max(250)
						.default("Blindmotion TotalBlock cassette blind installed in a bedroom"),
					confirmation: z.literal(TOTALBLOCK_FEATURED_IMAGE_CONFIRMATION),
				})
				.refine(
					(value) => {
						const reusingAttachment = value.replacement_attachment_id !== undefined;
						const uploadFields = [
							value.replacement_filename,
							value.replacement_mime_type,
							value.replacement_base64,
						];
						const anyUploadField = uploadFields.some((field) => field !== undefined);
						const completeUpload = uploadFields.every((field) => field !== undefined);
						return reusingAttachment ? !anyUploadField : completeUpload;
					},
					{
						message:
							"Provide either replacement_attachment_id or a complete filename/MIME/base64 upload payload.",
					},
				),
		},
		async ({
			expected_current_attachment_id,
			replacement_attachment_id,
			replacement_filename,
			replacement_mime_type,
			replacement_base64,
			alt_text,
		}) => {
			let product: any;
			let originalImages: Array<{ id: number }> = [];
			let productWriteCompleted = false;
			try {
				const productResponse = await wcFetch(`products/${TOTALBLOCK_PRODUCT_ID}`);
				product = await productResponse.json<any>();
				if (
					product.id !== TOTALBLOCK_PRODUCT_ID ||
					product.name !== TOTALBLOCK_PRODUCT_NAME ||
					product.slug !== TOTALBLOCK_PRODUCT_SLUG
				) {
					throw new Error(
						"TotalBlock product identity check failed; no write performed.",
					);
				}
				if (product.status !== "draft") {
					throw new Error("TotalBlock is no longer draft; no write performed.");
				}
				if (
					!Array.isArray(product.images) ||
					Number(product.images[0]?.id) !== expected_current_attachment_id
				) {
					throw new Error(
						`Current featured image is not the reviewed attachment ${expected_current_attachment_id}; no write performed.`,
					);
				}
				originalImages = product.images.map((image: any) => ({ id: Number(image.id) }));
				if (originalImages.some((image) => !Number.isInteger(image.id) || image.id <= 0)) {
					throw new Error(
						"The current product image list is invalid; no write performed.",
					);
				}

				let replacement: any;
				let uploadedByThisTool = false;
				if (replacement_attachment_id !== undefined) {
					const mediaResponse = await wpAuthenticatedFetch(
						`media/${replacement_attachment_id}?context=edit`,
					);
					replacement = await mediaResponse.json<any>();
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
					replacement = await wpUploadMedia(
						replacement_filename!,
						replacement_mime_type!,
						bytes,
					);
					uploadedByThisTool = true;
				}
				if (
					!replacement?.id ||
					typeof replacement.source_url !== "string" ||
					!/^image\/(jpeg|png|webp)$/i.test(replacement.mime_type ?? "")
				) {
					throw new Error(
						"The replacement attachment is not a supported WordPress image.",
					);
				}
				if (Number(replacement.id) === expected_current_attachment_id) {
					throw new Error(
						"The replacement attachment is already the current featured image.",
					);
				}

				const backupMeta = (product.meta_data ?? []).find(
					(item: any) => item.key === TOTALBLOCK_FEATURED_IMAGE_BACKUP_KEY,
				);
				const backups = Array.isArray(backupMeta?.value) ? [...backupMeta.value] : [];
				const backup = {
					backup_id: crypto.randomUUID(),
					created_at: new Date().toISOString(),
					product_id: TOTALBLOCK_PRODUCT_ID,
					old_featured_attachment_id: expected_current_attachment_id,
					old_featured_source_url: product.images[0]?.src ?? null,
					new_featured_attachment_id: Number(replacement.id),
					new_featured_source_url: replacement.source_url,
					original_gallery_attachment_ids: originalImages
						.slice(1)
						.map((image) => image.id),
				};
				backups.push(backup);

				await wcWrite(`products/${TOTALBLOCK_PRODUCT_ID}`, {
					images: [{ id: Number(replacement.id) }, ...originalImages.slice(1)],
					meta_data: [
						{
							...(backupMeta?.id ? { id: backupMeta.id } : {}),
							key: TOTALBLOCK_FEATURED_IMAGE_BACKUP_KEY,
							value: backups,
						},
					],
				});
				productWriteCompleted = true;

				const verifyResponse = await wcFetch(`products/${TOTALBLOCK_PRODUCT_ID}`);
				const verified = await verifyResponse.json<any>();
				const verifiedImageIds = (verified.images ?? []).map((image: any) =>
					Number(image.id),
				);
				const expectedImageIds = [
					Number(replacement.id),
					...originalImages.slice(1).map((image) => image.id),
				];
				if (
					verified.id !== TOTALBLOCK_PRODUCT_ID ||
					verified.name !== TOTALBLOCK_PRODUCT_NAME ||
					verified.slug !== TOTALBLOCK_PRODUCT_SLUG ||
					verified.status !== "draft" ||
					JSON.stringify(verifiedImageIds) !== JSON.stringify(expectedImageIds)
				) {
					throw new Error("Post-write TotalBlock featured-image verification failed.");
				}

				await wpAuthenticatedWrite(`media/${replacement.id}`, {
					alt_text,
					title: "Blindmotion TotalBlock Cassette Blind",
					caption: "",
					description: "",
				});

				return toolResult({
					replaced: true,
					product_id: verified.id,
					product_name: verified.name,
					product_status: verified.status,
					old_featured_attachment_id: expected_current_attachment_id,
					new_featured_attachment: {
						...mediaMetadata(replacement),
						alt: alt_text,
					},
					gallery_attachment_ids: verifiedImageIds.slice(1),
					gallery_preserved: true,
					original_attachment_deleted: false,
					rollback_record: backup,
					uploaded_by_this_tool: uploadedByThisTool,
				});
			} catch (error) {
				if (productWriteCompleted && originalImages.length > 0) {
					try {
						await wcWrite(`products/${TOTALBLOCK_PRODUCT_ID}`, {
							images: originalImages,
						});
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
		"replace_totalblock_gallery_images_guarded",
		{
			description: `Upload or reuse exactly four approved images and replace only the four gallery images of TotalBlock product ${TOTALBLOCK_PRODUCT_ID}. Preserves featured image 9417 and all product configuration, records the previous gallery for rollback, and requires exact confirmation: ${TOTALBLOCK_GALLERY_CONFIRMATION}`,
			inputSchema: z.object({
				replacements: z
					.array(
						z
							.object({
								replacement_attachment_id: z.number().int().positive().optional(),
								replacement_filename: z
									.string()
									.regex(/^[A-Za-z0-9._-]+$/)
									.optional(),
								replacement_mime_type: z
									.enum(["image/jpeg", "image/png", "image/webp"])
									.optional(),
								replacement_base64: z.string().min(4).max(8_000_000).optional(),
								alt_text: z.string().trim().min(1).max(250),
							})
							.refine(
								(value) => {
									const reusingAttachment =
										value.replacement_attachment_id !== undefined;
									const uploadFields = [
										value.replacement_filename,
										value.replacement_mime_type,
										value.replacement_base64,
									];
									const anyUploadField = uploadFields.some(
										(field) => field !== undefined,
									);
									const completeUpload = uploadFields.every(
										(field) => field !== undefined,
									);
									return reusingAttachment ? !anyUploadField : completeUpload;
								},
								{
									message:
										"Each gallery slot requires either replacement_attachment_id or a complete filename/MIME/base64 upload payload.",
								},
							),
					)
					.length(4),
				confirmation: z.literal(TOTALBLOCK_GALLERY_CONFIRMATION),
			}),
		},
		async ({ replacements }) => {
			let originalImages: Array<{ id: number }> = [];
			let productWriteCompleted = false;
			try {
				const productResponse = await wcFetch(`products/${TOTALBLOCK_PRODUCT_ID}`);
				const product = await productResponse.json<any>();
				if (
					product.id !== TOTALBLOCK_PRODUCT_ID ||
					product.name !== TOTALBLOCK_PRODUCT_NAME ||
					product.slug !== TOTALBLOCK_PRODUCT_SLUG
				) {
					throw new Error(
						"TotalBlock product identity check failed; no write performed.",
					);
				}
				if (product.status !== "draft") {
					throw new Error("TotalBlock is no longer draft; no write performed.");
				}

				originalImages = (product.images ?? []).map((image: any) => ({
					id: Number(image.id),
				}));
				const currentImageIds = originalImages.map((image) => image.id);
				if (
					JSON.stringify(currentImageIds) !==
					JSON.stringify(TOTALBLOCK_EXPECTED_CURRENT_IMAGE_IDS)
				) {
					throw new Error(
						`Current TotalBlock image list does not match the reviewed five-image state; no write performed. Current IDs: ${currentImageIds.join(", ")}.`,
					);
				}

				const resolvedReplacements: Array<{
					media: any;
					altText: string;
					uploadedByThisTool: boolean;
				}> = [];
				for (const replacement of replacements) {
					let media: any;
					let uploadedByThisTool = false;
					if (replacement.replacement_attachment_id !== undefined) {
						const mediaResponse = await wpAuthenticatedFetch(
							`media/${replacement.replacement_attachment_id}?context=edit`,
						);
						media = await mediaResponse.json<any>();
					} else {
						const bytes = decodeBase64(replacement.replacement_base64!);
						if (!bytes.length || bytes.length > 6_000_000) {
							throw new Error(
								"Each replacement image must decode to between 1 byte and 6 MB.",
							);
						}
						if (!hasExpectedImageSignature(bytes, replacement.replacement_mime_type!)) {
							throw new Error(
								"Replacement bytes do not match the declared image MIME type.",
							);
						}
						media = await wpUploadMedia(
							replacement.replacement_filename!,
							replacement.replacement_mime_type!,
							bytes,
						);
						uploadedByThisTool = true;
					}
					if (
						!media?.id ||
						typeof media.source_url !== "string" ||
						!/^image\/(jpeg|png|webp)$/i.test(media.mime_type ?? "")
					) {
						throw new Error(
							"One replacement attachment is not a supported WordPress image.",
						);
					}
					resolvedReplacements.push({
						media,
						altText: replacement.alt_text,
						uploadedByThisTool,
					});
				}

				const replacementIds = resolvedReplacements.map(({ media }) => Number(media.id));
				if (new Set(replacementIds).size !== 4) {
					throw new Error("The four gallery replacements must be four distinct images.");
				}
				if (replacementIds.includes(TOTALBLOCK_EXPECTED_CURRENT_IMAGE_IDS[0])) {
					throw new Error(
						"The featured image cannot also be used as a gallery replacement.",
					);
				}

				const backupMeta = (product.meta_data ?? []).find(
					(item: any) => item.key === TOTALBLOCK_GALLERY_BACKUP_KEY,
				);
				const backups = Array.isArray(backupMeta?.value) ? [...backupMeta.value] : [];
				const backup = {
					backup_id: crypto.randomUUID(),
					created_at: new Date().toISOString(),
					product_id: TOTALBLOCK_PRODUCT_ID,
					featured_attachment_id: TOTALBLOCK_EXPECTED_CURRENT_IMAGE_IDS[0],
					old_gallery_attachment_ids: currentImageIds.slice(1),
					new_gallery_attachment_ids: replacementIds,
				};
				backups.push(backup);

				const expectedImageIds = [
					TOTALBLOCK_EXPECTED_CURRENT_IMAGE_IDS[0],
					...replacementIds,
				];
				await wcWrite(`products/${TOTALBLOCK_PRODUCT_ID}`, {
					images: expectedImageIds.map((id) => ({ id })),
					meta_data: [
						{
							...(backupMeta?.id ? { id: backupMeta.id } : {}),
							key: TOTALBLOCK_GALLERY_BACKUP_KEY,
							value: backups,
						},
					],
				});
				productWriteCompleted = true;

				const verifyResponse = await wcFetch(`products/${TOTALBLOCK_PRODUCT_ID}`);
				const verified = await verifyResponse.json<any>();
				const verifiedImageIds = (verified.images ?? []).map((image: any) =>
					Number(image.id),
				);
				if (
					verified.id !== TOTALBLOCK_PRODUCT_ID ||
					verified.name !== TOTALBLOCK_PRODUCT_NAME ||
					verified.slug !== TOTALBLOCK_PRODUCT_SLUG ||
					verified.status !== "draft" ||
					JSON.stringify(verifiedImageIds) !== JSON.stringify(expectedImageIds)
				) {
					throw new Error("Post-write TotalBlock gallery verification failed.");
				}

				const metadataResults = await Promise.allSettled(
					resolvedReplacements.map(({ media, altText }) =>
						wpAuthenticatedWrite(`media/${media.id}`, {
							alt_text: altText,
							title: altText,
							caption: "",
							description: "",
						}),
					),
				);
				const metadataUpdateErrors = metadataResults
					.map((result, index) =>
						result.status === "rejected"
							? {
									gallery_position: index + 1,
									attachment_id: replacementIds[index],
									error:
										result.reason instanceof Error
											? result.reason.message
											: String(result.reason),
								}
							: null,
					)
					.filter(Boolean);

				return toolResult({
					replaced: true,
					product_id: verified.id,
					product_name: verified.name,
					product_status: verified.status,
					featured_attachment_id: verifiedImageIds[0],
					featured_preserved: verifiedImageIds[0] === originalImages[0].id,
					old_gallery_attachment_ids: currentImageIds.slice(1),
					new_gallery: resolvedReplacements.map(
						({ media, altText, uploadedByThisTool }, index) => ({
							position: index + 1,
							attachment: {
								...mediaMetadata(media),
								alt: altText,
							},
							uploaded_by_this_tool: uploadedByThisTool,
						}),
					),
					rollback_record: backup,
					original_attachments_deleted: false,
					metadata_update_errors: metadataUpdateErrors,
				});
			} catch (error) {
				if (productWriteCompleted && originalImages.length === 5) {
					try {
						await wcWrite(`products/${TOTALBLOCK_PRODUCT_ID}`, {
							images: originalImages,
						});
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
		"clone_winter_meta_form_for_spring_repair_guarded",
		{
			description:
				"Create one unattached corrected Spring Instant Form for the locked live Spring campaign by cloning the exact seven-question schema from the locked Winter form and copying the current Spring form's policy and follow-up URLs. Verifies the clone and cannot create, activate, pause or delete ads.",
			inputSchema: z.object({
				confirmation: z.literal(META_CLONE_WINTER_FORM_CONFIRMATION),
			}),
		},
		async () => {
			try {
				const campaign = await assertMetaObjectOwnership(
					META_SPRING_REPAIR_CAMPAIGN_ID,
					"campaign",
				);
				if (
					campaign.name !== META_SPRING_REPAIR_CAMPAIGN_NAME ||
					campaign.status !== "ACTIVE" ||
					campaign.objective !== "OUTCOME_LEADS"
				) {
					throw new Error("Refusing clone: locked Spring campaign state did not match.");
				}
				const page = await assertOwnedMetaPage(META_SPRING_REPAIR_PAGE_ID);
				const pageAccessToken = await getOwnedMetaPageAccessToken(
					META_SPRING_REPAIR_PAGE_ID,
				);
				const ownedForms = await getOwnedMetaLeadForms(META_SPRING_REPAIR_PAGE_ID, 100);
				const assertFormSummary = (id: string, name: string) => {
					const form = ownedForms.find((item: any) => String(item.id) === id);
					if (!form || form.status !== "ACTIVE" || String(form.name) !== name) {
						throw new Error(`Refusing clone: locked form ${id} did not match.`);
					}
					return form;
				};
				assertFormSummary(META_WINTER_FORM_ID, META_WINTER_FORM_NAME);
				assertFormSummary(META_SIMPLIFIED_SPRING_FORM_ID, META_SIMPLIFIED_SPRING_FORM_NAME);
				if (
					ownedForms.some(
						(item: any) => String(item.name) === META_CORRECTED_SPRING_FORM_NAME,
					)
				) {
					throw new Error("Refusing clone: corrected Spring form already exists.");
				}

				const [winterForm, springForm] = await Promise.all([
					metaFetch(
						META_WINTER_FORM_ID,
						{ fields: "id,name,status,locale,questions" },
						pageAccessToken,
					),
					metaFetch(
						META_SIMPLIFIED_SPRING_FORM_ID,
						{
							fields: "id,name,status,privacy_policy_url,follow_up_action_url",
						},
						pageAccessToken,
					),
				]);
				const winterQuestions = normalizeMetaLeadFormQuestions(winterForm.questions);
				assertWinterOutdoorLeadQuestionSchema(winterQuestions);
				if (!springForm.privacy_policy_url || !springForm.follow_up_action_url) {
					throw new Error(
						"Refusing clone: current Spring form did not expose its policy and follow-up URLs.",
					);
				}

				const creationQuestions = winterQuestions.map((question) =>
					question.type === "CUSTOM"
						? question
						: { type: question.type, key: question.key },
				);
				const created = await metaPost(
					META_SPRING_REPAIR_PAGE_ID + "/leadgen_forms",
					{
						name: META_CORRECTED_SPRING_FORM_NAME,
						locale: String(winterForm.locale ?? "en_US"),
						questions: JSON.stringify(creationQuestions),
						question_page_custom_headline: META_CORRECTED_SPRING_FORM_HEADLINE,
						privacy_policy: JSON.stringify({
							url: String(springForm.privacy_policy_url),
							link_text: "View Privacy Policy",
						}),
						follow_up_action_url: String(springForm.follow_up_action_url),
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
				const verifiedQuestions = normalizeMetaLeadFormQuestions(verified.questions);
				assertWinterOutdoorLeadQuestionSchema(verifiedQuestions);
				if (
					verified.status !== "ACTIVE" ||
					verified.name !== META_CORRECTED_SPRING_FORM_NAME ||
					JSON.stringify(verifiedQuestions) !== JSON.stringify(winterQuestions)
				) {
					throw new Error("Created Spring form failed exact Winter-schema verification.");
				}
				return toolResult({
					created: true,
					activation_performed: false,
					delivery_possible_without_a_separate_ad: false,
					campaign: { id: campaign.id, name: campaign.name, status: campaign.status },
					page,
					source_winter_form: {
						id: winterForm.id,
						name: winterForm.name,
						question_count: winterQuestions.length,
					},
					form: verified,
					verified_question_keys: verifiedQuestions.map((question) => question.key),
					note: "This verified form is unattached and cannot deliver until replacement ads are separately created and switched.",
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
		"get_search_console_property",
		{
			description:
				"Confirm read-only access to the fixed Blindmotion Search Console domain property and return a small recent organic-search activity check.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				const { siteUrl, serviceAccount } = getSearchConsoleConfig();
				const property = await searchConsoleFetch();
				if (
					!property.permissionLevel ||
					property.permissionLevel === "siteUnverifiedUser"
				) {
					throw new Error(
						"The configured service account is not a verified user of the Blindmotion Search Console property.",
					);
				}
				const startDate = utcDateDaysAgo(9);
				const endDate = utcDateDaysAgo(3);
				const activity = await searchConsoleQuery({
					startDate,
					endDate,
					rowLimit: 1,
				});
				return toolResult({
					site_url: siteUrl,
					permission_level: property.permissionLevel,
					service_account: serviceAccount.client_email,
					access_confirmed: true,
					activity_check: searchConsoleReportResult(activity, startDate, endDate, []),
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

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
	const curtainChoiceSchema = z.object({
		key: curtainConfigKey,
		label: z.string().trim().min(1).max(200),
		price_adjustment_aud: z.number().min(0).max(100000).default(0),
	});
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
		key: curtainConfigKey,
		label: z.string().trim().min(1).max(200),
		layers: z.array(z.enum(["sheer", "blockout"])).min(1).max(2),
		price_adjustment_aud: z.number().min(0).max(100000).default(0),
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
		uniqueKeys(value.motor_power_options, "motor_power_options");
		uniqueKeys(value.motor_position_options, "motor_position_options");
		uniqueKeys(value.control_options, "control_options");
		for (const role of ["sheer", "blockout"] as const) {
			if (!value.fabric_collections.some((collection) => collection.role === role)) {
				context.addIssue({ code: z.ZodIssueCode.custom, path: ["fabric_collections"], message: `At least one ${role} collection is required.` });
			}
			if (!value.configurations.some((configuration) => configuration.layers.includes(role))) {
				context.addIssue({ code: z.ZodIssueCode.custom, path: ["configurations"], message: `At least one configuration must use the ${role} role.` });
			}
		}
		for (const configuration of value.configurations) {
			if (new Set(configuration.layers).size !== configuration.layers.length) {
				context.addIssue({ code: z.ZodIssueCode.custom, path: ["configurations"], message: "A configuration cannot repeat a fabric role." });
			}
		}
		const attachmentIds = value.fabric_collections.flatMap((collection) => collection.swatches.map((swatch) => swatch.attachment_id));
		if (new Set(attachmentIds).size !== attachmentIds.length) {
			context.addIssue({ code: z.ZodIssueCode.custom, path: ["fabric_collections"], message: "Each swatch attachment may appear only once." });
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

		const requestedSwatches = args.fabric_collections.flatMap((collection) => collection.swatches);
		const mediaById = new Map<number, any>();
		for (let index = 0; index < requestedSwatches.length; index += 100) {
			const ids = requestedSwatches.slice(index, index + 100).map((swatch) => swatch.attachment_id);
			const response = await wpFetch(`media?include=${ids.join(",")}&per_page=100`);
			for (const media of await response.json<any[]>()) mediaById.set(Number(media.id), media);
		}
		for (const swatch of requestedSwatches) {
			const media = mediaById.get(swatch.attachment_id);
			if (!media) throw new Error("WordPress attachment " + swatch.attachment_id + " is unavailable.");
			const filename = String(media.media_details?.file ?? media.source_url ?? "").split("/").pop()?.toLocaleLowerCase();
			if (filename !== swatch.expected_filename.toLocaleLowerCase()) {
				throw new Error(`Attachment ${swatch.attachment_id} filename changed; expected ${swatch.expected_filename}, found ${filename ?? "unknown"}.`);
			}
			if (!String(media.mime_type ?? "").startsWith("image/")) throw new Error("A selected swatch attachment is not an image.");
		}

		const fieldId = async (key: string) => curtainStableToken(`curtain-field-v1:${args.product_id}:${key}`, 13);
		const choiceSlug = async (fieldKey: string, key: string) => curtainStableToken(`curtain-choice-v1:${args.product_id}:${fieldKey}:${key}`, 5);
		const templateChoice = (type: string) => {
			const choice = templates.get(type)?.options?.choices?.[0];
			return choice ? structuredClone(choice) : {};
		};
		const makeChoices = async (fieldKey: string, choices: CurtainChoiceInput[], type = "radio") => Promise.all(choices.map(async (choice) => ({
			...templateChoice(type),
			label: choice.label,
			slug: await choiceSlug(fieldKey, choice.key),
			pricing_type: choice.price_adjustment_aud > 0 ? "fixed" : "none",
			pricing_amount: choice.price_adjustment_aud,
			image: null,
			attachment: null,
		})));
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
		const configurationChoices = await makeChoices(configurationFieldKey, args.configurations);
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
		const fields: any[] = [];
		fields.push(await makeField("text", "location", "Room / Location"));
		fields.push(await makeField("radio", configurationFieldKey, "Curtain Configuration", configurationChoices));
		fields.push(await makeField("number", "width", "Finished Track Width (mm)", [], [], { min: args.minimum_width_mm, max: args.maximum_width_mm }));
		fields.push(await makeField("number", "drop", "Curtain Drop (mm)", [], [], { min: args.minimum_drop_mm, max: args.maximum_drop_mm }));
		fields.push(await makeField("radio", "heading", "Heading Style", await makeChoices("heading", args.heading_options)));
		fields.push(await makeField("radio", "mounting", "Track Mounting", await makeChoices("mounting", args.mounting_options)));
		fields.push(await makeField("radio", "stack_direction", "Stack Direction", await makeChoices("stack_direction", args.stack_direction_options)));
		fields.push(await makeField("radio", "motor_power", `${args.motor_brand} Motor Power`, await makeChoices("motor_power", args.motor_power_options)));
		if (singleConfigurationValues.length) fields.push(await makeField("radio", "single_motor_position", "Motor Position (viewed from room)", await makeChoices("single_motor_position", args.motor_position_options), curtainCondition(configurationFieldId, singleConfigurationValues)));
		if (doubleConfigurationValues.length) {
			fields.push(await makeField("radio", "sheer_motor_position", "Sheer Track Motor Position (viewed from room)", await makeChoices("sheer_motor_position", args.motor_position_options), curtainCondition(configurationFieldId, doubleConfigurationValues)));
			fields.push(await makeField("radio", "blockout_motor_position", "Blockout Track Motor Position (viewed from room)", await makeChoices("blockout_motor_position", args.motor_position_options), curtainCondition(configurationFieldId, doubleConfigurationValues)));
		}
		fields.push(await makeField("radio", "control", "Curtain Control", await makeChoices("control", args.control_options)));

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

	return server;
}

const handler = createMcpHandler(createServer);

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return handler(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
