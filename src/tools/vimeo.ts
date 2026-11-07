import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export const VIMEO_UPLOAD_PATH = "/media-intake/vimeo-video";
export const VIMEO_PERMIT_KEY_PREFIX = "vimeo-media-intake-upload:";
export const VIMEO_MAX_VIDEO_BYTES = 80_000_000;
export const VIMEO_UPLOAD_CONFIRMATION = "CONFIRM UPLOAD VIMEO VIDEO";

const VIMEO_API = "https://api.vimeo.com";
const VIMEO_ACCEPT = "application/vnd.vimeo.*+json;version=3.4";
const PERMIT_SECONDS = 600;

export interface VimeoEnv {
	OAUTH_KV: KVNamespace;
	VIMEO_ACCESS_TOKEN?: string;
	VIMEO_FOLDER_URI?: string;
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

export function registerVimeoTools(server: McpServer, getBindings: () => VimeoEnv) {
	server.registerTool(
		"manage_vimeo_video",
		{
			description:
				"Connect, inspect and upload Blindmotion website videos to Vimeo. CONNECTION and VIDEO are read-only. PERMIT creates a short-lived, single-use direct upload for one MP4/MOV; new videos are hidden on Vimeo (privacy.view=disable), embeddable on websites, non-downloadable and read back after upload. No delete, publish-to-feed or replacement capability.",
			inputSchema: z.discriminatedUnion("action", [
				z.object({ action: z.literal("connection") }),
				z.object({
					action: z.literal("video"),
					video_id: z.string().regex(/^\d+$/),
					expected_name: z.string().trim().min(1).max(255),
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
