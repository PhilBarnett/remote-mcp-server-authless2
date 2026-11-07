import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export const VIMEO_UPLOAD_PATH = "/media-intake/vimeo-video";
export const VIMEO_PERMIT_KEY_PREFIX = "vimeo-media-intake-upload:";
export const VIMEO_MAX_VIDEO_BYTES = 80_000_000;
export const VIMEO_UPLOAD_CONFIRMATION = "CONFIRM UPLOAD VIMEO VIDEO";
export const ZIPGRIP_VIDEO_PLACEMENT_CONFIRMATION = "CONFIRM PLACE ZIPGRIP PRODUCT VIDEO";

const VIMEO_API = "https://api.vimeo.com";
const VIMEO_ACCEPT = "application/vnd.vimeo.*+json;version=3.4";
const PERMIT_SECONDS = 600;
const ZIPGRIP_PRODUCT_ID = 1301;
const ZIPGRIP_PRODUCT_NAME = "Zip Sided Outdoor Blinds";
const ZIPGRIP_TEMPLATE_ID = 557;
const ZIPGRIP_VIDEO_SECTION_ID = "a1244f0";
const ZIPGRIP_VIDEO_COLUMN_ID = "a1245f1";
const ZIPGRIP_VIDEO_HEADING_ID = "a1246f2";
const ZIPGRIP_VIDEO_HTML_ID = "a1247f3";
const ZIPGRIP_VIDEO_HEADING = "See ZipGrip in a real waterfront installation";

export interface VimeoEnv {
	OAUTH_KV: KVNamespace;
	VIMEO_ACCESS_TOKEN?: string;
	VIMEO_FOLDER_URI?: string;
	WC_SITE?: string;
	WC_CONSUMER_KEY?: string;
	WC_CONSUMER_SECRET?: string;
	WP_USERNAME?: string;
	WP_APPLICATION_PASSWORD?: string;
}

type VimeoPermit = {
	title: string;
	description: string;
	filename: string;
	mime_type: "video/mp4" | "video/quicktime";
	file_size: number;
	created_at: number;
};

type Fetcher = typeof fetch;

const corsHeaders = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "Authorization, Content-Type",
	"Access-Control-Allow-Methods": "POST, OPTIONS",
	"Cache-Control": "no-store",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
};

function textResult(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	console.error("Blindmotion Vimeo tool error", { message });
	return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

function vimeoToken(bindings: VimeoEnv) {
	const token = bindings.VIMEO_ACCESS_TOKEN?.trim();
	if (!token) throw new Error("Vimeo is not connected. Configure VIMEO_ACCESS_TOKEN first.");
	return token;
}

function validateFolderUri(value: string | undefined) {
	if (!value?.trim()) return undefined;
	const folder = value.trim();
	if (!/^\/users\/\d+\/projects\/\d+$/.test(folder)) {
		throw new Error("VIMEO_FOLDER_URI must use /users/{user_id}/projects/{project_id}.");
	}
	return folder;
}

function safeFilename(filename: string, mimeType: VimeoPermit["mime_type"]) {
	const extension = mimeType === "video/quicktime" ? ".mov" : ".mp4";
	let stem = filename
		.replace(/\.(?:mp4|mov)$/i, "")
		.normalize("NFKD")
		.replace(/[^A-Za-z0-9._ -]+/g, "_")
		.replace(/^[_ .-]+|[_ .-]+$/g, "");
	if (!stem) stem = "Blindmotion_Video";
	return stem.slice(0, 190 - extension.length) + extension;
}

async function vimeoRequest(
	bindings: VimeoEnv,
	path: string,
	init: RequestInit = {},
	request: Fetcher = fetch,
) {
	if (!path.startsWith("/")) throw new Error("Invalid Vimeo API path.");
	const response = await request(VIMEO_API + path, {
		...init,
		headers: {
			Authorization: `Bearer ${vimeoToken(bindings)}`,
			Accept: VIMEO_ACCEPT,
			...(init.body ? { "Content-Type": "application/json" } : {}),
			...init.headers,
		},
		redirect: "manual",
		signal: AbortSignal.timeout(30_000),
	});
	if (response.status >= 300 && response.status < 400)
		throw new Error("Vimeo API redirects are refused.");
	const raw = await response.text();
	if (raw.length > 1_000_000) throw new Error("Vimeo API response exceeded the safety limit.");
	let body: any = {};
	try {
		body = raw ? JSON.parse(raw) : {};
	} catch {
		body = {};
	}
	if (!response.ok) {
		const detail = String(
			body?.error ?? body?.developer_message ?? body?.message ?? "Request failed",
		).slice(0, 300);
		throw new Error(`Vimeo API request failed (HTTP ${response.status}): ${detail}`);
	}
	return body;
}

function videoSummary(video: any) {
	const id = String(video?.uri ?? "").match(/^\/videos\/(\d+)$/)?.[1] ?? null;
	const embedHtml = typeof video?.embed?.html === "string" ? video.embed.html : "";
	const embedUrl =
		embedHtml.match(/\bsrc=["'](https:\/\/player\.vimeo\.com\/video\/[^"']+)["']/i)?.[1] ??
		null;
	return {
		video_id: id,
		uri: id ? `/videos/${id}` : null,
		name: video?.name ?? null,
		link: video?.link ?? null,
		embed_url: embedUrl,
		status: video?.status ?? null,
		transcode_status: video?.transcode?.status ?? null,
		privacy: video?.privacy
			? {
					view: video.privacy.view ?? null,
					embed: video.privacy.embed ?? null,
					download: video.privacy.download ?? null,
				}
			: null,
		duration_seconds: video?.duration ?? null,
		width: video?.width ?? null,
		height: video?.height ?? null,
		created_time: video?.created_time ?? null,
		modified_time: video?.modified_time ?? null,
	};
}

const videoFields = [
	"uri",
	"name",
	"link",
	"status",
	"transcode.status",
	"privacy",
	"embed.html",
	"duration",
	"width",
	"height",
	"created_time",
	"modified_time",
].join(",");

async function getVideo(bindings: VimeoEnv, videoId: string, request: Fetcher = fetch) {
	return vimeoRequest(
		bindings,
		`/videos/${videoId}?fields=${encodeURIComponent(videoFields)}`,
		{},
		request,
	);
}

function liveSite(bindings: VimeoEnv) {
	const site = bindings.WC_SITE?.trim().replace(/\/$/, "");
	if (!site || !/^https:\/\/online\.blindmotion\.com\.au$/i.test(site)) {
		throw new Error("The fixed Blindmotion Online origin is not configured.");
	}
	return site;
}

function wpAuth(bindings: VimeoEnv) {
	const username = bindings.WP_USERNAME?.trim();
	const password = bindings.WP_APPLICATION_PASSWORD?.trim();
	if (!username || !password) throw new Error("Live WordPress write access is not configured.");
	return `Basic ${btoa(`${username}:${password}`)}`;
}

async function readJson(response: Response, label: string) {
	const raw = await response.text();
	if (raw.length > 2_000_000) throw new Error(`${label} response exceeded the safety limit.`);
	let body: any;
	try {
		body = raw ? JSON.parse(raw) : {};
	} catch {
		throw new Error(`${label} returned malformed JSON.`);
	}
	if (!response.ok) {
		const detail = String(body?.message ?? body?.code ?? "Request failed").slice(0, 300);
		throw new Error(`${label} failed (HTTP ${response.status}): ${detail}`);
	}
	return body;
}

async function getZipGripProduct(bindings: VimeoEnv, request: Fetcher = fetch) {
	const key = bindings.WC_CONSUMER_KEY?.trim();
	const secret = bindings.WC_CONSUMER_SECRET?.trim();
	if (!key || !secret) throw new Error("WooCommerce read access is not configured.");
	const url = new URL(`${liveSite(bindings)}/wp-json/wc/v3/products/${ZIPGRIP_PRODUCT_ID}`);
	url.searchParams.set("consumer_key", key);
	url.searchParams.set("consumer_secret", secret);
	const product = await readJson(
		await request(url.toString(), {
			headers: { Accept: "application/json" },
			redirect: "manual",
			signal: AbortSignal.timeout(30_000),
		}),
		"WooCommerce product read",
	);
	if (
		product?.id !== ZIPGRIP_PRODUCT_ID ||
		product?.name !== ZIPGRIP_PRODUCT_NAME ||
		product?.status !== "publish"
	) {
		throw new Error("The live ZipGrip product identity or publication state changed.");
	}
	return product;
}

async function getZipGripTemplate(bindings: VimeoEnv, request: Fetcher = fetch) {
	const response = await request(
		`${liveSite(bindings)}/wp-json/wp/v2/elementor_library/${ZIPGRIP_TEMPLATE_ID}?context=edit`,
		{
			headers: { Authorization: wpAuth(bindings), Accept: "application/json" },
			redirect: "manual",
			signal: AbortSignal.timeout(30_000),
		},
	);
	const template = await readJson(response, "Elementor template read");
	if (
		template?.id !== ZIPGRIP_TEMPLATE_ID ||
		String(template?.title?.raw ?? template?.title?.rendered ?? "") !== "Single Product Template" ||
		template?.status !== "publish"
	) {
		throw new Error("The live Elementor template identity or publication state changed.");
	}
	const raw = template?.meta?.["_elementor_data"];
	if (typeof raw !== "string" || raw.length < 1000)
		throw new Error("The live Elementor template data is unavailable.");
	let data: any[];
	try {
		data = JSON.parse(raw);
	} catch {
		throw new Error("The live Elementor template data is malformed.");
	}
	if (!Array.isArray(data)) throw new Error("The live Elementor template root is invalid.");
	return { raw, data };
}

async function sha256(value: string) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hasNodeId(nodes: any[], id: string): boolean {
	for (const node of nodes) {
		if (node?.id === id) return true;
		if (Array.isArray(node?.elements) && hasNodeId(node.elements, id)) return true;
	}
	return false;
}

function zipGripVideoSection(videoId: string) {
	const playerUrl = `https://player.vimeo.com/video/${videoId}?badge=0&autopause=0&player_id=0&app_id=556546`;
	return {
		id: ZIPGRIP_VIDEO_SECTION_ID,
		elType: "section",
		isInner: false,
		settings: {
			structure: "10",
			content_width: { unit: "px", size: 1100, sizes: [] },
			padding: { unit: "px", top: "48", right: "20", bottom: "48", left: "20", isLinked: false },
			padding_tablet: { unit: "px", top: "36", right: "20", bottom: "36", left: "20", isLinked: false },
			padding_mobile: { unit: "px", top: "28", right: "16", bottom: "28", left: "16", isLinked: false },
			dce_visibility_post: [String(ZIPGRIP_PRODUCT_ID)],
			enabled_visibility: "yes",
			css_classes: "zipgrip-koolewong-video",
		},
		elements: [
			{
				id: ZIPGRIP_VIDEO_COLUMN_ID,
				elType: "column",
				isInner: false,
				settings: { _column_size: 100, _inline_size: null },
				elements: [
					{
						id: ZIPGRIP_VIDEO_HEADING_ID,
						elType: "widget",
						widgetType: "heading",
						isInner: false,
						settings: {
							title: ZIPGRIP_VIDEO_HEADING,
							header_size: "h2",
							align: "center",
							align_mobile: "left",
							_margin: { unit: "px", top: "0", right: "0", bottom: "22", left: "0", isLinked: false },
						},
						elements: [],
					},
					{
						id: ZIPGRIP_VIDEO_HTML_ID,
						elType: "widget",
						widgetType: "html",
						isInner: false,
						settings: {
							html: `<div style="position:relative;padding-top:56.25%;overflow:hidden;background:#000;"><iframe src="${playerUrl}" title="ZipGrip outdoor blinds at Koolewong" style="position:absolute;inset:0;width:100%;height:100%;border:0;" allow="autoplay; fullscreen; picture-in-picture; clipboard-write; encrypted-media; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>`,
						},
						elements: [],
					},
				],
			},
		],
	};
}

function buildZipGripPlacement(data: any[], videoId: string) {
	if (hasNodeId(data, ZIPGRIP_VIDEO_SECTION_ID)) {
		throw new Error("The ZipGrip Koolewong video section already exists.");
	}
	const featureIndex = data.findIndex(
		(node) =>
			node?.elType === "section" &&
			String(node?.settings?.css_classes ?? "")
				.split(/\s+/)
				.includes("feat-ben-sec"),
	);
	if (featureIndex < 0) throw new Error("The expected Features & Benefits section was not found.");
	const next = structuredClone(data);
	next.splice(featureIndex, 0, zipGripVideoSection(videoId));
	return { next, insert_index: featureIndex };
}

async function writeZipGripTemplate(bindings: VimeoEnv, raw: string, request: Fetcher = fetch) {
	const result = await readJson(
		await request(`${liveSite(bindings)}/wp-json/wp/v2/elementor_library/${ZIPGRIP_TEMPLATE_ID}`, {
			method: "POST",
			headers: {
				Authorization: wpAuth(bindings),
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				meta: {
					_elementor_data: raw,
					// Elementor's element cache can otherwise continue serving the prior tree.
					_elementor_element_cache: "",
				},
			}),
			redirect: "manual",
			signal: AbortSignal.timeout(30_000),
		}),
		"Elementor template write",
	);
	await readJson(
		await request(`${liveSite(bindings)}/wp-json/jetpack/v4/site/cache/flush`, {
			method: "POST",
			headers: {
				Authorization: wpAuth(bindings),
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: "{}",
			redirect: "manual",
			signal: AbortSignal.timeout(30_000),
		}),
		"Jetpack page-cache flush",
	);
	return result;
}

export function registerVimeoTools(server: McpServer, getBindings: () => VimeoEnv) {
	server.registerTool(
		"manage_vimeo_video",
		{
			description:
				"Connect, inspect and upload Blindmotion website videos to Vimeo, and preview/apply one fixed Koolewong Vimeo placement on the live ZipGrip product template. CONNECTION, VIDEO and PREVIEW_PLACEMENT are read-only. APPLY_PLACEMENT is hash-locked, product-specific, verifies WordPress read-back and public rendering, and restores the exact original Elementor data on failure. PERMIT creates a short-lived, single-use direct upload for one MP4/MOV. No delete, publish-to-feed or video replacement capability.",
			inputSchema: z.discriminatedUnion("action", [
				z.object({ action: z.literal("connection") }),
				z.object({
					action: z.literal("video"),
					video_id: z.string().regex(/^\d+$/),
					expected_name: z.string().trim().min(1).max(255),
				}),
				z.object({
					action: z.literal("preview_placement"),
					video_id: z.string().regex(/^\d+$/),
					expected_name: z.string().trim().min(1).max(255),
				}),
				z.object({
					action: z.literal("apply_placement"),
					video_id: z.string().regex(/^\d+$/),
					expected_name: z.string().trim().min(1).max(255),
					expected_template_sha256: z.string().regex(/^[a-f0-9]{64}$/),
					expected_plan_sha256: z.string().regex(/^[a-f0-9]{64}$/),
					confirmation: z.literal(ZIPGRIP_VIDEO_PLACEMENT_CONFIRMATION),
				}),
				z.object({
					action: z.literal("permit"),
					title: z.string().trim().min(1).max(255),
					description: z.string().trim().max(5000).default(""),
					filename: z.string().trim().min(5).max(200),
					mime_type: z.enum(["video/mp4", "video/quicktime"]),
					file_size: z.number().int().positive().max(VIMEO_MAX_VIDEO_BYTES),
					confirmation: z.literal(VIMEO_UPLOAD_CONFIRMATION),
				}),
			]),
		},
		async (args) => {
			try {
				const bindings = getBindings();
				if (args.action === "connection") {
					if (!bindings.VIMEO_ACCESS_TOKEN?.trim()) {
						return textResult({
							configured: false,
							upload_ready: false,
							required_secret: "VIMEO_ACCESS_TOKEN",
						});
					}
					const account = await vimeoRequest(
						bindings,
						"/me?fields=uri,name,link,account,upload_quota",
					);
					return textResult({
						configured: true,
						upload_ready: true,
						account: {
							uri: account.uri ?? null,
							name: account.name ?? null,
							link: account.link ?? null,
							type: account.account ?? null,
						},
						upload_quota: account.upload_quota ?? null,
						folder_uri: validateFolderUri(bindings.VIMEO_FOLDER_URI) ?? null,
						access_token_exposed: false,
					});
				}
				if (args.action === "video") {
					const video = await getVideo(bindings, args.video_id);
					if (String(video?.name ?? "") !== args.expected_name)
						throw new Error("Vimeo video name does not match expected_name.");
					return textResult({ ...videoSummary(video), read_only: true });
				}
				if (args.action === "preview_placement" || args.action === "apply_placement") {
					const video = await getVideo(bindings, args.video_id);
					if (String(video?.name ?? "") !== args.expected_name)
						throw new Error("Vimeo video name does not match expected_name.");
					if (
						video?.status !== "available" ||
						video?.transcode?.status !== "complete" ||
						video?.privacy?.view !== "disable" ||
						video?.privacy?.embed !== "public" ||
						video?.privacy?.download !== false
					) {
						throw new Error("The Vimeo video is not in the expected completed website-only state.");
					}
					const product = await getZipGripProduct(bindings);
					const current = await getZipGripTemplate(bindings);
					const currentHash = await sha256(current.raw);
					const placement = buildZipGripPlacement(current.data, args.video_id);
					const targetRaw = JSON.stringify(placement.next);
					const targetHash = await sha256(targetRaw);
					const planHash = await sha256(
						JSON.stringify({
							product_id: ZIPGRIP_PRODUCT_ID,
							product_name: ZIPGRIP_PRODUCT_NAME,
							template_id: ZIPGRIP_TEMPLATE_ID,
							video_id: args.video_id,
							video_name: args.expected_name,
							current_sha256: currentHash,
							target_sha256: targetHash,
							insert_index: placement.insert_index,
						}),
					);
					if (args.action === "preview_placement") {
						return textResult({
							action: "preview_placement",
							write_performed: false,
							product: { id: product.id, name: product.name, status: product.status },
							template: {
								id: ZIPGRIP_TEMPLATE_ID,
								expected_template_sha256: currentHash,
								target_template_sha256: targetHash,
								insert_before_css_class: "feat-ben-sec",
								insert_index: placement.insert_index,
							},
							video: videoSummary(video),
							heading: ZIPGRIP_VIDEO_HEADING,
							visibility: { product_ids: [String(ZIPGRIP_PRODUCT_ID)] },
							expected_plan_sha256: planHash,
						});
					}
					if (
						currentHash !== args.expected_template_sha256 ||
						planHash !== args.expected_plan_sha256
					) {
						throw new Error("The Elementor template or placement plan changed after preview.");
					}
					let writeAttempted = false;
					try {
						writeAttempted = true;
						await writeZipGripTemplate(bindings, targetRaw);
						const verified = await getZipGripTemplate(bindings);
						const verifiedHash = await sha256(verified.raw);
						if (
							verifiedHash !== targetHash ||
							!hasNodeId(verified.data, ZIPGRIP_VIDEO_SECTION_ID)
						) {
							throw new Error("Elementor read-back did not match the exact previewed placement.");
						}
						let publicRenderVerified = false;
						let renderDiagnostic = "no response";
						for (let attempt = 1; attempt <= 3; attempt += 1) {
							if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
							const publicUrl = `${liveSite(bindings)}/zipsided-outdoor-blinds/?bm_verify=${Date.now()}-${attempt}`;
							const rendered = await fetch(publicUrl, {
								headers: {
									Accept: "text/html",
									"Cache-Control": "no-cache, no-store, max-age=0",
									Pragma: "no-cache",
								},
								redirect: "manual",
								signal: AbortSignal.timeout(30_000),
							});
							const html = await rendered.text();
							const hasPlayer = html.includes(`player.vimeo.com/video/${args.video_id}`);
							const hasHeading = html.includes(ZIPGRIP_VIDEO_HEADING);
							const hasElement = html.includes(`elementor-element-${ZIPGRIP_VIDEO_SECTION_ID}`);
							renderDiagnostic = `attempt=${attempt}, status=${rendered.status}, player=${hasPlayer}, heading=${hasHeading}, element=${hasElement}, bytes=${html.length}`;
							if (rendered.ok && hasPlayer && hasHeading && hasElement) {
								publicRenderVerified = true;
								break;
							}
						}
						if (!publicRenderVerified) {
							throw new Error(`The public ZipGrip page did not render the new Vimeo section (${renderDiagnostic}).`);
						}
						return textResult({
							action: "apply_placement",
							write_performed: true,
							verified: true,
							rollback_required: false,
							product: { id: product.id, name: product.name, status: product.status },
							template_id: ZIPGRIP_TEMPLATE_ID,
							template_sha256: verifiedHash,
							video: videoSummary(video),
							heading: ZIPGRIP_VIDEO_HEADING,
							public_url: `${liveSite(bindings)}/zipsided-outdoor-blinds/`,
							public_render_verified: true,
						});
					} catch (error) {
						if (writeAttempted) {
							try {
								await writeZipGripTemplate(bindings, current.raw);
								const restored = await getZipGripTemplate(bindings);
								if ((await sha256(restored.raw)) !== currentHash) {
									const rollbackVerificationError = new Error(
										"Exact Elementor rollback verification failed.",
									);
									(rollbackVerificationError as any).cause = error;
									throw rollbackVerificationError;
								}
							} catch (rollbackError) {
								const combinedError = new Error(
									`${error instanceof Error ? error.message : String(error)} Rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
								);
								(combinedError as any).cause = rollbackError;
								throw combinedError;
							}
						}
						throw error;
					}
				}

				vimeoToken(bindings);
				validateFolderUri(bindings.VIMEO_FOLDER_URI);
				const safe = safeFilename(args.filename, args.mime_type);
				const query = encodeURIComponent(args.title);
				const list = await vimeoRequest(
					bindings,
					`/me/videos?query=${query}&per_page=25&sort=date&direction=desc&fields=${encodeURIComponent(videoFields)}`,
				);
				const exact = (Array.isArray(list?.data) ? list.data : []).filter(
					(item: any) => String(item?.name ?? "") === args.title,
				);
				if (exact.length === 1) {
					return textResult({
						action: "existing",
						uploaded: true,
						...videoSummary(exact[0]),
						file_size: args.file_size,
					});
				}
				if (exact.length > 1)
					throw new Error(
						`Refusing upload: ${exact.length} Vimeo videos already use this exact title.`,
					);
				const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
				const uploadToken = Array.from(tokenBytes, (byte) =>
					byte.toString(16).padStart(2, "0"),
				).join("");
				const permit: VimeoPermit = {
					title: args.title,
					description: args.description,
					filename: safe,
					mime_type: args.mime_type,
					file_size: args.file_size,
					created_at: Date.now(),
				};
				await bindings.OAUTH_KV.put(
					VIMEO_PERMIT_KEY_PREFIX + uploadToken,
					JSON.stringify(permit),
					{ expirationTtl: PERMIT_SECONDS },
				);
				return textResult({
					action: "permit",
					upload_url: `https://remote-mcp-server-authless2.phil-cd4.workers.dev${VIMEO_UPLOAD_PATH}`,
					upload_token: uploadToken,
					expires_in_seconds: PERMIT_SECONDS,
					filename: safe,
					mime_type: args.mime_type,
					file_size: args.file_size,
					privacy: { view: "disable", embed: "public", download: false },
					deletion_available: false,
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	);
}

export async function handleVimeoMediaUpload(
	request: Request,
	bindings: VimeoEnv,
	requestImpl: Fetcher = fetch,
): Promise<Response> {
	if (request.method === "OPTIONS")
		return new Response(null, { status: 204, headers: corsHeaders });
	if (request.method !== "POST") {
		return new Response("Method not allowed", {
			status: 405,
			headers: { ...corsHeaders, Allow: "POST, OPTIONS" },
		});
	}
	const auth = request.headers.get("Authorization") ?? "";
	const match = auth.match(/^Bearer ([a-f0-9]{64})$/);
	if (!match) return new Response("Unauthorized", { status: 401, headers: corsHeaders });
	const key = VIMEO_PERMIT_KEY_PREFIX + match[1];
	const raw = await bindings.OAUTH_KV.get(key);
	if (!raw)
		return new Response("Upload permit is invalid or expired.", {
			status: 401,
			headers: corsHeaders,
		});
	let permit: VimeoPermit;
	try {
		permit = JSON.parse(raw);
	} catch {
		await bindings.OAUTH_KV.delete(key);
		return new Response("Upload permit is invalid.", { status: 401, headers: corsHeaders });
	}
	if (
		!permit ||
		typeof permit.title !== "string" ||
		typeof permit.description !== "string" ||
		typeof permit.filename !== "string" ||
		!["video/mp4", "video/quicktime"].includes(permit.mime_type) ||
		!Number.isInteger(permit.file_size) ||
		permit.file_size <= 0 ||
		permit.file_size > VIMEO_MAX_VIDEO_BYTES ||
		!Number.isFinite(permit.created_at) ||
		Date.now() - permit.created_at > PERMIT_SECONDS * 1000 ||
		Date.now() < permit.created_at - 30_000
	) {
		await bindings.OAUTH_KV.delete(key);
		return new Response("Upload permit is invalid or expired.", {
			status: 401,
			headers: corsHeaders,
		});
	}
	const contentType = (request.headers.get("Content-Type") ?? "")
		.split(";")[0]
		.trim()
		.toLowerCase();
	if (contentType !== permit.mime_type)
		return new Response("Video MIME type does not match upload permit.", {
			status: 415,
			headers: corsHeaders,
		});
	const length = request.headers.get("Content-Length");
	if (length && Number(length) !== permit.file_size)
		return new Response("Video size does not match upload permit.", {
			status: 400,
			headers: corsHeaders,
		});
	const bytes = await request.arrayBuffer();
	if (bytes.byteLength !== permit.file_size)
		return new Response("Video size does not match upload permit.", {
			status: 400,
			headers: corsHeaders,
		});

	// Consume first. A network retry must not create a second Vimeo video.
	await bindings.OAUTH_KV.delete(key);
	let createdId: string | null = null;
	try {
		const folderUri = validateFolderUri(bindings.VIMEO_FOLDER_URI);
		const ticket = await vimeoRequest(
			bindings,
			"/me/videos",
			{
				method: "POST",
				body: JSON.stringify({
					upload: { approach: "tus", size: permit.file_size },
					name: permit.title,
					description: permit.description,
					privacy: { view: "disable", embed: "public", download: false },
					...(folderUri ? { folder_uri: folderUri } : {}),
				}),
			},
			requestImpl,
		);
		createdId = String(ticket?.uri ?? "").match(/^\/videos\/(\d+)$/)?.[1] ?? null;
		if (!createdId) throw new Error("Vimeo did not return a video ID.");
		const uploadLink = new URL(String(ticket?.upload?.upload_link ?? ""));
		if (
			uploadLink.protocol !== "https:" ||
			!(uploadLink.hostname === "vimeo.com" || uploadLink.hostname.endsWith(".vimeo.com")) ||
			uploadLink.username ||
			uploadLink.password
		) {
			throw new Error("Vimeo returned an invalid TUS upload destination.");
		}
		const uploaded = await requestImpl(uploadLink.toString(), {
			method: "PATCH",
			headers: {
				Accept: VIMEO_ACCEPT,
				"Tus-Resumable": "1.0.0",
				"Upload-Offset": "0",
				"Content-Type": "application/offset+octet-stream",
			},
			body: bytes,
			redirect: "manual",
			signal: AbortSignal.timeout(120_000),
		});
		if (uploaded.status >= 300 && uploaded.status < 400)
			throw new Error("Vimeo TUS redirects are refused.");
		if (!uploaded.ok) throw new Error(`Vimeo TUS upload failed (HTTP ${uploaded.status}).`);
		const verifiedUpload = await requestImpl(uploadLink.toString(), {
			method: "HEAD",
			headers: { Accept: VIMEO_ACCEPT, "Tus-Resumable": "1.0.0" },
			redirect: "manual",
			signal: AbortSignal.timeout(30_000),
		});
		if (verifiedUpload.status >= 300 && verifiedUpload.status < 400)
			throw new Error("Vimeo TUS verification redirects are refused.");
		if (!verifiedUpload.ok)
			throw new Error(`Vimeo TUS verification failed (HTTP ${verifiedUpload.status}).`);
		const uploadLength = Number(verifiedUpload.headers.get("Upload-Length"));
		const uploadOffset = Number(verifiedUpload.headers.get("Upload-Offset"));
		if (uploadLength !== permit.file_size || uploadOffset !== permit.file_size) {
			throw new Error("Vimeo did not verify the complete file.");
		}
		const video = await getVideo(bindings, createdId, requestImpl);
		if (String(video?.name ?? "") !== permit.title)
			throw new Error("Vimeo read-back name did not match the upload permit.");
		return Response.json(
			{
				uploaded: true,
				filename: permit.filename,
				file_size: permit.file_size,
				...videoSummary(video),
				read_back_verified: true,
			},
			{ headers: corsHeaders },
		);
	} catch (error) {
		console.error("Vimeo direct upload failed", {
			message: error instanceof Error ? error.message : String(error),
			createdId,
		});
		return Response.json(
			{
				uploaded: false,
				video_created: Boolean(createdId),
				video_id: createdId,
				error: error instanceof Error ? error.message : "Vimeo upload failed.",
				retry_requires_new_permit: true,
			},
			{ status: 502, headers: corsHeaders },
		);
	}
}
