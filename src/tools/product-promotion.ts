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
const PROMOTION_PLUGIN_VERSION = "0.1.0";

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
		throw new Error(
			`${environment} WordPress promotion access is not configured in Cloudflare.`,
		);
	}

	const url = new URL(raw.baseUrl);
	if (
		url.protocol !== "https:" ||
		url.hostname !== raw.expectedHost ||
		(url.pathname !== "/" && url.pathname !== "") ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new Error(
			`${environment} WordPress promotion site must be the exact approved HTTPS origin.`,
		);
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

async function promotionRequest(environment: PromotionEnvironment, path: string) {
	const site = promotionSite(environment);
	const url = new URL(
		`/wp-json/blindmotion-mcp/v1/${path.replace(/^\/+/, "")}`,
		site.baseUrl,
	);
	const response = await fetch(url.toString(), {
		method: "GET",
		headers: {
			Authorization: `Basic ${btoa(`${site.username}:${site.applicationPassword}`)}`,
			Accept: "application/json",
		},
	});
	const responseText = await response.text();
	if (!response.ok) {
		throw new Error(
			`${environment} promotion bridge failed: ${response.status} ${responseText.slice(0, 500)}`,
		);
	}
	let payload: any;
	try {
		payload = JSON.parse(responseText);
	} catch {
		throw new Error(`${environment} promotion bridge did not return JSON.`);
	}
	return { site, payload };
}

function assertPluginContract(payload: any) {
	if (
		payload?.plugin?.slug !== PROMOTION_PLUGIN_SLUG ||
		payload?.plugin?.version !== PROMOTION_PLUGIN_VERSION ||
		payload?.read_only !== true
	) {
		throw new Error("Product promotion bridge identity or read-only contract did not match.");
	}
}

function assertEnvironmentContract(site: PromotionSite, payload: any) {
	assertPluginContract(payload);
	const returnedUrl = new URL(String(payload?.site_url ?? ""));
	if (
		payload?.configured !== true ||
		payload?.role !== site.expectedRole ||
		payload?.environment_id !== site.environment ||
		payload?.write_routes_available !== false ||
		payload?.automatic_sync_hooks_registered !== false ||
		returnedUrl.protocol !== "https:" ||
		returnedUrl.hostname !== site.expectedHost
	) {
		throw new Error(`${site.environment} promotion environment failed its safety contract.`);
	}
}

function toolResult(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
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

export function registerProductPromotionTools(server: McpServer) {
	server.registerTool(
		"inspect_product_promotion_environment",
		{
			description:
				"Verify the authenticated, read-only Blindmotion product-promotion bridge and exact source/target identity on staging or live. Performs no WordPress or WooCommerce writes.",
			inputSchema: z.object({
				environment: z.enum(["staging", "live"]),
			}),
		},
		async ({ environment }) => {
			try {
				const { site, payload } = await promotionRequest(
					environment,
					"product-promotion/environment",
				);
				assertEnvironmentContract(site, payload);
				return toolResult({
					verified: true,
					write_performed: false,
					environment,
					role: payload.role,
					environment_id: payload.environment_id,
					site_url: payload.site_url,
					plugin: payload.plugin,
					write_routes_available: false,
					automatic_sync_hooks_registered: false,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"inspect_product_promotion_manifest",
		{
			description:
				"Read and verify a deterministic WooCommerce product manifest from the exact Blindmotion staging or live promotion bridge. Returns identity, publication state, pricing, taxonomy, media integrity and metadata hashes; performs no writes.",
			inputSchema: z.object({
				environment: z.enum(["staging", "live"]),
				product_id: z.number().int().positive(),
			}),
		},
		async ({ environment, product_id }) => {
			try {
				const environmentResponse = await promotionRequest(
					environment,
					"product-promotion/environment",
				);
				assertEnvironmentContract(environmentResponse.site, environmentResponse.payload);

				const { site, payload } = await promotionRequest(
					environment,
					`product-promotion/products/${product_id}/manifest`,
				);
				assertPluginContract(payload);
				if (
					payload?.write_performed !== false ||
					payload?.manifest?.identity?.product_id !== product_id ||
					payload?.manifest?.source?.role !== site.expectedRole ||
					payload?.manifest?.source?.environment_id !== environment ||
					typeof payload?.manifest_sha256 !== "string" ||
					!/^[a-f0-9]{64}$/.test(payload.manifest_sha256)
				) {
					throw new Error(`${environment} product manifest failed its read-only identity contract.`);
				}
				return toolResult({
					verified: true,
					write_performed: false,
					environment,
					manifest_sha256: payload.manifest_sha256,
					manifest: payload.manifest,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);
}
