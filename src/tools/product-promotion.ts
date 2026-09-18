import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

type PromotionEnvironment = "staging" | "live";
type PromotionSite = {
	environment: PromotionEnvironment;
	baseUrl: string;
	username: string;
	applicationPassword: string;
	expectedHost: string;
	expectedRole: "source" | "target";
};

const PROMOTION_PLUGIN_SLUG = "blindmotion-product-promotion-bridge";
const PROMOTION_PLUGIN_VERSION = "0.3.4";
const BOOTSTRAP_CONFIRMATION = "CONFIRM BOOTSTRAP LIVE PRODUCT TO STAGING";
const IDENTITY_CONFIRMATION = "CONFIRM ASSIGN PROMOTION IDENTITY";
const MEDIA_CONFIRMATION = "CONFIRM PREPARE BOOTSTRAP MEDIA";
const FINALIZE_CONFIRMATION = "CONFIRM FINALIZE BOOTSTRAP TO STAGING";
const ABORT_CONFIRMATION = "CONFIRM ABORT BOOTSTRAP MEDIA";
const ROLLBACK_CONFIRMATION = "CONFIRM ROLLBACK STAGING BOOTSTRAP";
const SHA256 = /^[a-f0-9]{64}$/;

function workerEnvironment() {
	return env as unknown as Record<string, string | undefined>;
}

function promotionSite(environment: PromotionEnvironment): PromotionSite {
	const workerEnv = workerEnvironment();
	const raw = environment === "staging"
		? {
			baseUrl: workerEnv.WC_STAGING_SITE,
			username: workerEnv.WP_STAGING_USERNAME,
			applicationPassword: workerEnv.WP_STAGING_APPLICATION_PASSWORD,
			expectedHost: "staging-online.blindmotion.com.au",
			expectedRole: "source" as const,
		}
		: {
			baseUrl: workerEnv.WC_SITE,
			username: workerEnv.WP_USERNAME,
			applicationPassword: workerEnv.WP_APPLICATION_PASSWORD,
			expectedHost: "online.blindmotion.com.au",
			expectedRole: "target" as const,
		};
	if (!raw.baseUrl || !raw.username || !raw.applicationPassword) {
		throw new Error(`${environment} WordPress promotion access is not configured in Cloudflare.`);
	}
	const url = new URL(raw.baseUrl);
	if (
		url.protocol !== "https:" ||
		url.hostname !== raw.expectedHost ||
		(url.pathname !== "/" && url.pathname !== "") ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new Error(`${environment} WordPress promotion site must be the exact approved HTTPS origin.`);
	}
	return {
		environment,
		baseUrl: url.origin,
		username: raw.username,
		applicationPassword: raw.applicationPassword,
		expectedHost: raw.expectedHost,
		expectedRole: raw.expectedRole,
	};
}

async function promotionRequest(
	environment: PromotionEnvironment,
	path: string,
	method: "GET" | "POST" = "GET",
	body?: unknown,
) {
	const site = promotionSite(environment);
	const url = new URL(`/wp-json/blindmotion-mcp/v1/${path.replace(/^\/+/, "")}`, site.baseUrl);
	const response = await fetch(url.toString(), {
		method,
		headers: {
			Authorization: `Basic ${btoa(`${site.username}:${site.applicationPassword}`)}`,
			Accept: "application/json",
			...(method === "POST" ? { "Content-Type": "application/json" } : {}),
		},
		body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
	});
	const responseText = await response.text();
	if (!response.ok) {
		throw new Error(`${environment} promotion bridge failed: ${response.status} ${responseText.slice(0, 1000)}`);
	}
	let payload: any;
	try {
		payload = JSON.parse(responseText);
	} catch {
		throw new Error(`${environment} promotion bridge did not return JSON.`);
	}
	return { site, payload };
}

function assertPlugin(payload: any) {
	if (
		payload?.plugin?.slug !== PROMOTION_PLUGIN_SLUG ||
		payload?.plugin?.version !== PROMOTION_PLUGIN_VERSION
	) {
		throw new Error("Product promotion bridge identity or version did not match.");
	}
}

async function environmentContract(environment: PromotionEnvironment) {
	const response = await promotionRequest(environment, "product-promotion/environment");
	assertPlugin(response.payload);
	const returnedUrl = new URL(String(response.payload?.site_url ?? ""));
	if (
		response.payload?.configured !== true ||
		response.payload?.role !== response.site.expectedRole ||
		response.payload?.environment_id !== environment ||
		response.payload?.write_routes_available !== true ||
		response.payload?.automatic_sync_hooks_registered !== false ||
		response.payload?.write_policy?.automatic_sync !== false ||
		response.payload?.write_policy?.bootstrap_direction !== "live-to-staging-only" ||
		response.payload?.write_policy?.bootstrap_destination_state !== "draft-hidden" ||
		response.payload?.write_policy?.resumable_media_batches !== true ||
		response.payload?.write_policy?.publishing_supported !== false ||
		returnedUrl.protocol !== "https:" ||
		returnedUrl.hostname !== response.site.expectedHost
	) {
		throw new Error(`${environment} promotion environment failed its safety contract.`);
	}
	return {
		verified: true,
		write_performed: false,
		environment,
		role: response.payload.role,
		environment_id: response.payload.environment_id,
		site_url: response.payload.site_url,
		plugin: response.payload.plugin,
		write_policy: response.payload.write_policy,
		automatic_sync_hooks_registered: false,
	};
}

async function manifest(environment: PromotionEnvironment, productId: number) {
	const response = await promotionRequest(
		environment,
		`product-promotion/products/${productId}/manifest`,
	);
	assertPlugin(response.payload);
	if (
		response.payload?.read_only !== true ||
		response.payload?.write_performed !== false ||
		response.payload?.manifest?.identity?.product_id !== productId ||
		response.payload?.manifest?.source?.role !== response.site.expectedRole ||
		response.payload?.manifest?.source?.environment_id !== environment ||
		!SHA256.test(String(response.payload?.manifest_sha256 ?? ""))
	) {
		throw new Error(`${environment} product manifest failed its read-only identity contract.`);
	}
	return response.payload;
}

function changedFields(left: Record<string, unknown> = {}, right: Record<string, unknown> = {}) {
	return [...new Set([...Object.keys(left), ...Object.keys(right)])]
		.sort()
		.filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]));
}

function normalizedTaxonomy(value: Record<string, any[]> = {}) {
	return Object.fromEntries(Object.entries(value).map(([taxonomy, terms]) => [
		taxonomy,
		terms.map((term) => ({ slug: term.slug, name: term.name }))
			.sort((a, b) => String(a.slug).localeCompare(String(b.slug))),
	]));
}

function normalizedMedia(value: any[] = []) {
	return value.map((item) => ({
		relative_file: item.relative_file,
		mime_type: item.mime_type,
		file_exists: item.file_exists,
		file_bytes: item.file_bytes,
		file_sha256: item.file_sha256,
	})).sort((a, b) => String(a.relative_file).localeCompare(String(b.relative_file)));
}

function metadataDiff(staging: Record<string, any> = {}, live: Record<string, any> = {}) {
	const noise = (key: string) =>
		key.startsWith("_blindmotion_mcp_") ||
		key.startsWith("_blindmotion_promotion_snapshot_") ||
		key === "_last_change_time";
	const stagingKeys = Object.keys(staging).filter((key) => !noise(key));
	const liveKeys = Object.keys(live).filter((key) => !noise(key));
	const common = stagingKeys.filter((key) => liveKeys.includes(key));
	const changed = common.filter((key) => JSON.stringify(staging[key]) !== JSON.stringify(live[key]));
	return {
		staging_key_count: stagingKeys.length,
		live_key_count: liveKeys.length,
		same_key_count: common.length - changed.length,
		changed_keys: changed,
		only_staging: stagingKeys.filter((key) => !liveKeys.includes(key)),
		only_live: liveKeys.filter((key) => !stagingKeys.includes(key)),
	};
}

function readableDiff(stagingPayload: any, livePayload: any) {
	const staging = stagingPayload.manifest;
	const live = livePayload.manifest;
	const stagingIdentity = { ...staging.identity };
	const liveIdentity = { ...live.identity };
	delete stagingIdentity.product_id;
	delete liveIdentity.product_id;
	const stagingTaxonomy = normalizedTaxonomy(staging.taxonomy);
	const liveTaxonomy = normalizedTaxonomy(live.taxonomy);
	const stagingMedia = normalizedMedia(staging.media);
	const liveMedia = normalizedMedia(live.media);
	const sections = {
		environment_noise_excluded: [
			"source role, environment ID and site URL",
			"database product IDs",
			"taxonomy term IDs",
			"attachment IDs and host-specific media URLs",
			"known MCP backup and timestamp metadata",
		],
		identity: {
			changed_fields: changedFields(stagingIdentity, liveIdentity),
			staging: stagingIdentity,
			live: liveIdentity,
		},
		publication: {
			changed_fields: changedFields(staging.publication, live.publication),
			staging: staging.publication,
			live: live.publication,
		},
		content: {
			changed_fields: changedFields(staging.content, live.content),
			staging: staging.content,
			live: live.content,
		},
		commerce: {
			changed_fields: changedFields(staging.commerce, live.commerce),
			staging: staging.commerce,
			live: live.commerce,
		},
		taxonomy: {
			changed: JSON.stringify(stagingTaxonomy) !== JSON.stringify(liveTaxonomy),
			staging: stagingTaxonomy,
			live: liveTaxonomy,
		},
		media: {
			changed: JSON.stringify(stagingMedia) !== JSON.stringify(liveMedia),
			staging: stagingMedia,
			live: liveMedia,
		},
		metadata: metadataDiff(staging.metadata, live.metadata),
	};
	const equivalent =
		sections.identity.changed_fields.length === 0 &&
		sections.publication.changed_fields.length === 0 &&
		sections.content.changed_fields.length === 0 &&
		sections.commerce.changed_fields.length === 0 &&
		sections.taxonomy.changed === false &&
		sections.media.changed === false &&
		sections.metadata.changed_keys.length === 0 &&
		sections.metadata.only_staging.length === 0 &&
		sections.metadata.only_live.length === 0;
	return { equivalent, ...sections };
}

function toolResult(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function toolError(error: unknown) {
	return {
		content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
		isError: true,
	};
}

const inputSchema = z.object({
	action: z.enum([
		"inspect_environment",
		"manifest",
		"compare",
		"preview_bootstrap",
		"begin_bootstrap",
		"prepare_bootstrap_media",
		"finalize_bootstrap",
		"abort_bootstrap_media",
		"rollback_bootstrap",
	]).optional(),
	environment: z.enum(["staging", "live"]).optional(),
	product_id: z.number().int().positive().optional(),
	live_product_id: z.number().int().positive().optional(),
	staging_product_id: z.number().int().positive().optional(),
	expected_plan_sha256: z.string().regex(SHA256).optional(),
	expected_current_manifest_sha256: z.string().regex(SHA256).optional(),
	session_id: z.string().uuid().optional(),
	rollback_snapshot_key: z.string().regex(/^blindmotion_promotion_snapshot_[a-f0-9]{32}$/).optional(),
	confirmation: z.string().optional(),
});

function requireNumber(value: number | undefined, label: string) {
	if (!value) throw new Error(`${label} is required for this action.`);
	return value;
}

async function bootstrapPreview(liveProductId: number, stagingProductId?: number) {
	await Promise.all([environmentContract("live"), environmentContract("staging")]);
	const exportResponse = await promotionRequest(
		"live",
		`product-promotion/products/${liveProductId}/bootstrap-export`,
	);
	assertPlugin(exportResponse.payload);
	if (
		exportResponse.payload?.read_only !== true ||
		exportResponse.payload?.write_performed !== false ||
		!SHA256.test(String(exportResponse.payload?.source_manifest_sha256 ?? "")) ||
		!SHA256.test(String(exportResponse.payload?.export_sha256 ?? "")) ||
		exportResponse.payload?.export?.source?.product_id !== liveProductId
	) {
		throw new Error("Live bootstrap export failed its read-only contract.");
	}
	const previewResponse = await promotionRequest(
		"staging",
		"product-promotion/bootstrap/preview",
		"POST",
		{
			export: exportResponse.payload.export,
			expected_export_sha256: exportResponse.payload.export_sha256,
			...(stagingProductId ? { destination_product_id: stagingProductId } : {}),
		},
	);
	assertPlugin(previewResponse.payload);
	if (
		previewResponse.payload?.preview_only !== true ||
		previewResponse.payload?.write_performed !== false ||
		!SHA256.test(String(previewResponse.payload?.plan_sha256 ?? "")) ||
		previewResponse.payload?.plan?.direction !== "live-to-staging" ||
		previewResponse.payload?.plan?.forced_destination_state?.status !== "draft" ||
		previewResponse.payload?.plan?.forced_destination_state?.catalog_visibility !== "hidden"
	) {
		throw new Error("Staging bootstrap preview failed its safety contract.");
	}
	return {
		exportPayload: exportResponse.payload,
		previewPayload: previewResponse.payload,
	};
}

export function registerProductPromotionTools(server: McpServer) {
	server.registerTool(
		"inspect_product_promotion",
		{
			description:
				"Inspect, compare, preview, bootstrap, abort or roll back the guarded Blindmotion product-promotion workflow. Read actions never write. Bootstrap is live-to-staging legacy reconciliation only, uses hash-locked resumable media preparation, forces draft/hidden state, verifies content/media/WAPF/pricing, and never publishes.",
			inputSchema,
		},
		async (args) => {
			try {
				const action = args.action ?? (args.product_id ? "manifest" : "inspect_environment");
				if (action === "abort_bootstrap_media") {
					if (!args.session_id || !args.expected_plan_sha256) {
						throw new Error("session_id and expected_plan_sha256 are required for media abort.");
					}
					if (args.confirmation !== ABORT_CONFIRMATION) {
						throw new Error(`Exact confirmation required: ${ABORT_CONFIRMATION}`);
					}
					await environmentContract("staging");
					const response = await promotionRequest("staging", "product-promotion/bootstrap/media/abort", "POST", {
						session_id: args.session_id,
						expected_plan_sha256: args.expected_plan_sha256,
						confirmation: ABORT_CONFIRMATION,
					});
					assertPlugin(response.payload);
					if (response.payload?.aborted !== true || response.payload?.product_write_performed !== false) {
						throw new Error("Bootstrap media abort failed its safety contract.");
					}
					return toolResult(response.payload);
				}
				if (action === "rollback_bootstrap") {
					if (!args.rollback_snapshot_key || !args.expected_current_manifest_sha256) {
						throw new Error("rollback_snapshot_key and expected_current_manifest_sha256 are required for rollback.");
					}
					if (args.confirmation !== ROLLBACK_CONFIRMATION) {
						throw new Error(`Exact confirmation required: ${ROLLBACK_CONFIRMATION}`);
					}
					await environmentContract("staging");
					const response = await promotionRequest("staging", "product-promotion/bootstrap/rollback", "POST", {
						snapshot_key: args.rollback_snapshot_key,
						expected_current_manifest_sha256: args.expected_current_manifest_sha256,
						confirmation: ROLLBACK_CONFIRMATION,
					});
					assertPlugin(response.payload);
					if (response.payload?.rolled_back !== true || response.payload?.write_performed !== true) {
						throw new Error("Bootstrap rollback failed its safety contract.");
					}
					return toolResult(response.payload);
				}
				if (action === "inspect_environment") {
					if (!args.environment) throw new Error("environment is required for inspection.");
					return toolResult(await environmentContract(args.environment));
				}
				if (action === "manifest") {
					if (!args.environment) throw new Error("environment is required for a manifest.");
					const productId = requireNumber(args.product_id, "product_id");
					await environmentContract(args.environment);
					return toolResult(await manifest(args.environment, productId));
				}
				if (action === "compare") {
					const liveId = requireNumber(args.live_product_id, "live_product_id");
					const stagingId = requireNumber(args.staging_product_id, "staging_product_id");
					await Promise.all([environmentContract("live"), environmentContract("staging")]);
					const [live, staging] = await Promise.all([
						manifest("live", liveId),
						manifest("staging", stagingId),
					]);
					return toolResult({
						preview_only: true,
						write_performed: false,
						live_product_id: liveId,
						staging_product_id: stagingId,
						live_manifest_sha256: live.manifest_sha256,
						staging_manifest_sha256: staging.manifest_sha256,
						diff: readableDiff(staging, live),
					});
				}
				if (action === "prepare_bootstrap_media") {
					if (!args.session_id || !args.expected_plan_sha256) {
						throw new Error("session_id and expected_plan_sha256 are required for media preparation.");
					}
					if (args.confirmation !== MEDIA_CONFIRMATION) {
						throw new Error(`Exact confirmation required: ${MEDIA_CONFIRMATION}`);
					}
					await environmentContract("staging");
					const batch = await promotionRequest(
						"staging",
						"product-promotion/bootstrap/media/batch",
						"POST",
						{
							session_id: args.session_id,
							expected_plan_sha256: args.expected_plan_sha256,
							confirmation: MEDIA_CONFIRMATION,
						},
					);
					assertPlugin(batch.payload);
					if (
						batch.payload?.batch_prepared !== true ||
						batch.payload?.product_write_performed !== false ||
						batch.payload?.session_id !== args.session_id ||
						batch.payload?.plan_sha256 !== args.expected_plan_sha256
					) {
						throw new Error("Bootstrap media batch failed its safety contract.");
					}
					return toolResult(batch.payload);
				}
				if (action === "finalize_bootstrap") {
					const liveId = requireNumber(args.live_product_id, "live_product_id");
					if (!args.session_id || !args.expected_plan_sha256) {
						throw new Error("session_id and expected_plan_sha256 are required for finalization.");
					}
					if (args.confirmation !== FINALIZE_CONFIRMATION) {
						throw new Error(`Exact confirmation required: ${FINALIZE_CONFIRMATION}`);
					}
					const applyResponse = await promotionRequest(
						"staging",
						"product-promotion/bootstrap/apply",
						"POST",
						{
							session_id: args.session_id,
							expected_plan_sha256: args.expected_plan_sha256,
							confirmation: FINALIZE_CONFIRMATION,
						},
					);
					assertPlugin(applyResponse.payload);
					if (
						applyResponse.payload?.applied !== true ||
						applyResponse.payload?.verified !== true ||
						applyResponse.payload?.write_performed !== true ||
						applyResponse.payload?.rollback_performed !== false ||
						applyResponse.payload?.plan_sha256 !== args.expected_plan_sha256 ||
						applyResponse.payload?.verification?.status !== "draft" ||
						applyResponse.payload?.verification?.catalog_visibility !== "hidden" ||
						applyResponse.payload?.verification?.live_domain_references_in_wapf !== 0 ||
						applyResponse.payload?.verification?.live_domain_references_total !== 0 ||
						!SHA256.test(String(applyResponse.payload?.verification?.wapf_semantic_sha256 ?? ""))
					) {
						throw new Error("Staging bootstrap finalization failed its verification contract.");
					}
					const destinationId = Number(applyResponse.payload.destination_product_id);
					const [liveAfter, stagingAfter] = await Promise.all([
						manifest("live", liveId),
						manifest("staging", destinationId),
					]);
					if (
						liveAfter.manifest.identity.promotion_key === "" ||
						liveAfter.manifest.identity.promotion_key !== stagingAfter.manifest.identity.promotion_key
					) {
						throw new Error("Post-bootstrap promotion identities do not match.");
					}
					return toolResult({
						applied: true,
						verified: true,
						published: false,
						plan_sha256: args.expected_plan_sha256,
						destination_product_id: destinationId,
						created: applyResponse.payload.created,
						rollback_snapshot_key: applyResponse.payload.rollback_snapshot_key,
						verification: applyResponse.payload.verification,
						promotion_key: liveAfter.manifest.identity.promotion_key,
						live_manifest_sha256: liveAfter.manifest_sha256,
						staging_manifest_sha256: stagingAfter.manifest_sha256,
					});
				}
				const liveId = requireNumber(args.live_product_id, "live_product_id");
				const preview = await bootstrapPreview(liveId, args.staging_product_id);
				if (action === "preview_bootstrap") {
					return toolResult({
						preview_only: true,
						write_performed: false,
						plan_sha256: preview.previewPayload.plan_sha256,
						plan: preview.previewPayload.plan,
						identity_write_required: preview.exportPayload.export.identity.promotion_key_persisted !== true,
						required_confirmation: BOOTSTRAP_CONFIRMATION,
					});
				}
				if (action !== "begin_bootstrap") throw new Error("Unsupported product-promotion action.");
				if (!args.expected_plan_sha256 || args.expected_plan_sha256 !== preview.previewPayload.plan_sha256) {
					throw new Error("The exact reviewed bootstrap plan hash is required.");
				}
				if (args.confirmation !== BOOTSTRAP_CONFIRMATION) {
					throw new Error(`Exact confirmation required: ${BOOTSTRAP_CONFIRMATION}`);
				}
				const source = preview.exportPayload.export;
				const identityResponse = await promotionRequest(
					"live",
					`product-promotion/products/${liveId}/promotion-identity`,
					"POST",
					{
						expected_manifest_sha256: preview.exportPayload.source_manifest_sha256,
						promotion_key: source.identity.promotion_key,
						confirmation: IDENTITY_CONFIRMATION,
					},
				);
				assertPlugin(identityResponse.payload);
				if (
					identityResponse.payload?.identity_assigned !== true ||
					identityResponse.payload?.product_id !== liveId ||
					identityResponse.payload?.promotion_key !== source.identity.promotion_key
				) {
					throw new Error("Live promotion identity assignment failed verification.");
				}
				const beginResponse = await promotionRequest(
					"staging",
					"product-promotion/bootstrap/media/begin",
					"POST",
					{
						export: source,
						expected_export_sha256: preview.exportPayload.export_sha256,
						expected_plan_sha256: args.expected_plan_sha256,
						confirmation: BOOTSTRAP_CONFIRMATION,
						...(args.staging_product_id ? { destination_product_id: args.staging_product_id } : {}),
					},
				);
				assertPlugin(beginResponse.payload);
				if (
					beginResponse.payload?.session_created !== true ||
					beginResponse.payload?.write_performed !== true ||
					beginResponse.payload?.product_write_performed !== false ||
					beginResponse.payload?.plan_sha256 !== args.expected_plan_sha256 ||
					typeof beginResponse.payload?.session_id !== "string"
				) {
					throw new Error("Staging bootstrap session failed its safety contract.");
				}
				return toolResult({
					session_created: true,
					product_write_performed: false,
					plan_sha256: args.expected_plan_sha256,
					live_identity_write_performed: identityResponse.payload.write_performed,
					session_id: beginResponse.payload.session_id,
					reusable_verified_assets: beginResponse.payload.reusable_verified_assets,
					pending_assets: beginResponse.payload.pending_assets,
					batch_size: beginResponse.payload.batch_size,
					expires_at: beginResponse.payload.expires_at,
					promotion_key: source.identity.promotion_key,
					next_action: "prepare_bootstrap_media",
					required_confirmation: MEDIA_CONFIRMATION,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);
}
