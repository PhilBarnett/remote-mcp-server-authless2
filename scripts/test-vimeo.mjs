import assert from "node:assert/strict";
import test from "node:test";
import {
	handleVimeoMediaUpload,
	registerVimeoTools,
	VIMEO_PERMIT_KEY_PREFIX,
	VIMEO_UPLOAD_CONFIRMATION,
	ZIPGRIP_VIDEO_PLACEMENT_CONFIRMATION,
} from "../src/tools/vimeo.ts";

class MemoryKv {
	values = new Map();
	async get(key) {
		return this.values.get(key) ?? null;
	}
	async put(key, value) {
		this.values.set(key, value);
	}
	async delete(key) {
		this.values.delete(key);
	}
}

function registered(bindings) {
	const tools = new Map();
	registerVimeoTools(
		{
			registerTool(name, definition, handler) {
				tools.set(name, { definition, handler });
			},
		},
		() => bindings,
	);
	return tools.get("manage_vimeo_video");
}

function parsed(result) {
	assert.equal(result.isError, undefined, result.content[0].text);
	return JSON.parse(result.content[0].text);
}

test("connection reports the one missing secret without exposing credentials", async () => {
	const tool = registered({ OAUTH_KV: new MemoryKv() });
	const value = parsed(await tool.handler({ action: "connection" }));
	assert.deepEqual(value, {
		configured: false,
		upload_ready: false,
		required_secret: "VIMEO_ACCESS_TOKEN",
	});
});

test("connection and exact video inspection are read-only and sanitized", async () => {
	const calls = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		assert.equal(init.headers.Authorization, "Bearer secret-vimeo-token");
		if (String(url).includes("/me?"))
			return Response.json({
				uri: "/users/7",
				name: "Blindmotion",
				link: "https://vimeo.com/blindmotion",
				account: "pro",
				upload_quota: { space: { free: 1000 } },
			});
		return Response.json({
			uri: "/videos/123",
			name: "ZipGrip product page",
			status: "available",
			transcode: { status: "complete" },
			privacy: { view: "disable", embed: "public", download: false },
			embed: { html: '<iframe src="https://player.vimeo.com/video/123"></iframe>' },
		});
	};
	try {
		const tool = registered({
			OAUTH_KV: new MemoryKv(),
			VIMEO_ACCESS_TOKEN: "secret-vimeo-token",
		});
		const connection = parsed(await tool.handler({ action: "connection" }));
		assert.equal(connection.account.name, "Blindmotion");
		assert.equal(connection.access_token_exposed, false);
		assert.ok(!JSON.stringify(connection).includes("secret-vimeo-token"));
		const video = parsed(
			await tool.handler({
				action: "video",
				video_id: "123",
				expected_name: "ZipGrip product page",
			}),
		);
		assert.equal(video.video_id, "123");
		assert.equal(video.embed_url, "https://player.vimeo.com/video/123");
		assert.equal(video.read_only, true);
		assert.equal(calls.length, 2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("permit is single-purpose, short-lived and idempotent by exact title", async () => {
	const kv = new MemoryKv();
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => Response.json({ data: [] });
	try {
		const tool = registered({ OAUTH_KV: kv, VIMEO_ACCESS_TOKEN: "token" });
		const value = parsed(
			await tool.handler({
				action: "permit",
				title: "ZipGrip product page",
				description: "Product demonstration",
				filename: "ZipGrip final.MP4",
				mime_type: "video/mp4",
				file_size: 4,
				confirmation: VIMEO_UPLOAD_CONFIRMATION,
			}),
		);
		assert.equal(value.action, "permit");
		assert.equal(value.filename, "ZipGrip final.mp4");
		assert.deepEqual(value.privacy, { view: "disable", embed: "public", download: false });
		assert.match(value.upload_token, /^[a-f0-9]{64}$/);
		const saved = JSON.parse(await kv.get(VIMEO_PERMIT_KEY_PREFIX + value.upload_token));
		assert.equal(saved.title, "ZipGrip product page");
	} finally {
		globalThis.fetch = originalFetch;
	}

	globalThis.fetch = async () =>
		Response.json({
			data: [
				{
					uri: "/videos/123",
					name: "ZipGrip product page",
					status: "available",
					transcode: { status: "complete" },
				},
			],
		});
	try {
		const tool = registered({ OAUTH_KV: kv, VIMEO_ACCESS_TOKEN: "token" });
		const existing = parsed(
			await tool.handler({
				action: "permit",
				title: "ZipGrip product page",
				description: "",
				filename: "x.mp4",
				mime_type: "video/mp4",
				file_size: 4,
				confirmation: VIMEO_UPLOAD_CONFIRMATION,
			}),
		);
		assert.equal(existing.action, "existing");
		assert.equal(existing.video_id, "123");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("ZipGrip placement is previewed, hash-locked, applied and publicly verified", async () => {
	let templateRaw = JSON.stringify([
		{ id: "intro", elType: "section", settings: { filler: "x".repeat(1100) }, elements: [] },
		{ id: "features", elType: "section", settings: { css_classes: "feat-ben-sec" }, elements: [] },
	]);
	let writes = 0;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init = {}) => {
		const value = String(url);
		if (value.startsWith("https://api.vimeo.com/videos/1244573300?")) {
			return Response.json({
				uri: "/videos/1244573300",
				name: "ZipGrip Outdoor Blinds — Koolewong Case Study",
				status: "available",
				transcode: { status: "complete" },
				privacy: { view: "disable", embed: "public", download: false },
				embed: { html: '<iframe src="https://player.vimeo.com/video/1244573300"></iframe>' },
			});
		}
		if (value.startsWith("https://online.blindmotion.com.au/wp-json/wc/v3/products/1301?")) {
			return Response.json({ id: 1301, name: "Zip Sided Outdoor Blinds", status: "publish" });
		}
		if (value === "https://online.blindmotion.com.au/wp-json/wp/v2/elementor_library/557?context=edit") {
			assert.match(init.headers.Authorization, /^Basic /);
			return Response.json({
				id: 557,
				title: { raw: "Single Product Template" },
				status: "publish",
				meta: { _elementor_data: templateRaw },
			});
		}
		if (value === "https://online.blindmotion.com.au/wp-json/wp/v2/elementor_library/557") {
			assert.equal(init.method, "POST");
			const body = JSON.parse(init.body);
			assert.equal(body.meta._elementor_element_cache, "");
			templateRaw = body.meta._elementor_data;
			writes += 1;
			return Response.json({ id: 557 });
		}
		if (value.startsWith("https://online.blindmotion.com.au/zipsided-outdoor-blinds/?bm_verify=")) {
			return new Response(
				'<section class="elementor-element elementor-element-a1244f0"><h2>See ZipGrip in a real waterfront installation</h2><iframe src="https://player.vimeo.com/video/1244573300"></iframe></section>',
				{ status: 200 },
			);
		}
		throw new Error(`Unexpected fetch: ${value}`);
	};
	try {
		const tool = registered({
			OAUTH_KV: new MemoryKv(),
			VIMEO_ACCESS_TOKEN: "vimeo",
			WC_SITE: "https://online.blindmotion.com.au",
			WC_CONSUMER_KEY: "key",
			WC_CONSUMER_SECRET: "secret",
			WP_USERNAME: "wp-user",
			WP_APPLICATION_PASSWORD: "wp-password",
		});
		const preview = parsed(
			await tool.handler({
				action: "preview_placement",
				video_id: "1244573300",
				expected_name: "ZipGrip Outdoor Blinds — Koolewong Case Study",
			}),
		);
		assert.equal(preview.write_performed, false);
		assert.equal(preview.template.insert_before_css_class, "feat-ben-sec");
		assert.match(preview.expected_plan_sha256, /^[a-f0-9]{64}$/);
		const applied = parsed(
			await tool.handler({
				action: "apply_placement",
				video_id: "1244573300",
				expected_name: "ZipGrip Outdoor Blinds — Koolewong Case Study",
				expected_template_sha256: preview.template.expected_template_sha256,
				expected_plan_sha256: preview.expected_plan_sha256,
				confirmation: ZIPGRIP_VIDEO_PLACEMENT_CONFIRMATION,
			}),
		);
		assert.equal(applied.verified, true);
		assert.equal(applied.public_render_verified, true);
		assert.equal(writes, 1);
		const nodes = JSON.parse(templateRaw);
		assert.equal(nodes[1].id, "a1244f0");
		assert.equal(nodes[1].isInner, false);
		assert.equal(nodes[1].elements[0].isInner, false);
		assert.equal(nodes[1].elements[0].elements[0].isInner, false);
		assert.equal(nodes[2].id, "features");
		assert.ok(templateRaw.includes("player.vimeo.com/video/1244573300"));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("direct intake creates a private-website Vimeo video, uploads bytes and verifies read-back", async () => {
	const kv = new MemoryKv();
	const uploadToken = "a".repeat(64);
	await kv.put(
		VIMEO_PERMIT_KEY_PREFIX + uploadToken,
		JSON.stringify({
			title: "ZipGrip product page",
			description: "Product demonstration",
			filename: "zipgrip.mp4",
			mime_type: "video/mp4",
			file_size: 4,
			created_at: Date.now(),
		}),
	);
	const calls = [];
	const requestImpl = async (url, init) => {
		calls.push({ url: String(url), init });
		if (String(url) === "https://api.vimeo.com/me/videos") {
			const body = JSON.parse(init.body);
			assert.deepEqual(body.upload, { approach: "tus", size: 4 });
			assert.deepEqual(body.privacy, { view: "disable", embed: "public", download: false });
			assert.equal(init.headers.Authorization, "Bearer secret");
			return Response.json({
				uri: "/videos/123",
				upload: { upload_link: "https://files.tus.vimeo.com/files/abc" },
			});
		}
		if (String(url) === "https://files.tus.vimeo.com/files/abc") {
			assert.equal(init.headers["Tus-Resumable"], "1.0.0");
			if (init.method === "PATCH") {
				assert.deepEqual([...new Uint8Array(init.body)], [1, 2, 3, 4]);
				return new Response(null, { status: 204, headers: { "Upload-Offset": "4" } });
			}
			assert.equal(init.method, "HEAD");
			return new Response(null, {
				status: 200,
				headers: { "Upload-Length": "4", "Upload-Offset": "4" },
			});
		}
		assert.match(String(url), /^https:\/\/api\.vimeo\.com\/videos\/123\?fields=/);
		return Response.json({
			uri: "/videos/123",
			name: "ZipGrip product page",
			link: "https://vimeo.com/123",
			status: "available",
			transcode: { status: "in_progress" },
			privacy: { view: "disable", embed: "public", download: false },
			embed: { html: '<iframe src="https://player.vimeo.com/video/123"></iframe>' },
		});
	};
	const request = new Request("https://worker.example/media-intake/vimeo-video", {
		method: "POST",
		headers: { Authorization: `Bearer ${uploadToken}`, "Content-Type": "video/mp4" },
		body: new Uint8Array([1, 2, 3, 4]),
	});
	const response = await handleVimeoMediaUpload(
		request,
		{ OAUTH_KV: kv, VIMEO_ACCESS_TOKEN: "secret" },
		requestImpl,
	);
	assert.equal(response.status, 200);
	const result = await response.json();
	assert.equal(result.uploaded, true);
	assert.equal(result.video_id, "123");
	assert.equal(result.read_back_verified, true);
	assert.equal(result.embed_url, "https://player.vimeo.com/video/123");
	assert.equal(await kv.get(VIMEO_PERMIT_KEY_PREFIX + uploadToken), null);
	assert.equal(calls.length, 4);
	const replay = await handleVimeoMediaUpload(
		request,
		{ OAUTH_KV: kv, VIMEO_ACCESS_TOKEN: "secret" },
		requestImpl,
	);
	assert.equal(replay.status, 401);
});

test("intake refuses mismatched content and reports a created video if TUS fails", async () => {
	const kv = new MemoryKv();
	const wrongToken = "b".repeat(64);
	await kv.put(
		VIMEO_PERMIT_KEY_PREFIX + wrongToken,
		JSON.stringify({
			title: "x",
			description: "",
			filename: "x.mp4",
			mime_type: "video/mp4",
			file_size: 4,
			created_at: Date.now(),
		}),
	);
	const wrong = await handleVimeoMediaUpload(
		new Request("https://worker.example/media-intake/vimeo-video", {
			method: "POST",
			headers: { Authorization: `Bearer ${wrongToken}`, "Content-Type": "video/quicktime" },
			body: new Uint8Array(4),
		}),
		{ OAUTH_KV: kv, VIMEO_ACCESS_TOKEN: "secret" },
	);
	assert.equal(wrong.status, 415);
	assert.notEqual(await kv.get(VIMEO_PERMIT_KEY_PREFIX + wrongToken), null);

	const failToken = "c".repeat(64);
	await kv.put(
		VIMEO_PERMIT_KEY_PREFIX + failToken,
		JSON.stringify({
			title: "x",
			description: "",
			filename: "x.mp4",
			mime_type: "video/mp4",
			file_size: 4,
			created_at: Date.now(),
		}),
	);
	const failed = await handleVimeoMediaUpload(
		new Request("https://worker.example/media-intake/vimeo-video", {
			method: "POST",
			headers: { Authorization: `Bearer ${failToken}`, "Content-Type": "video/mp4" },
			body: new Uint8Array(4),
		}),
		{ OAUTH_KV: kv, VIMEO_ACCESS_TOKEN: "secret" },
		async (url) => {
			if (String(url).endsWith("/me/videos"))
				return Response.json({
					uri: "/videos/999",
					upload: { upload_link: "https://files.tus.vimeo.com/files/fail" },
				});
			return new Response("failed", { status: 500 });
		},
	);
	assert.equal(failed.status, 502);
	const result = await failed.json();
	assert.equal(result.video_created, true);
	assert.equal(result.video_id, "999");
	assert.equal(result.retry_requires_new_permit, true);
	assert.equal(await kv.get(VIMEO_PERMIT_KEY_PREFIX + failToken), null);
});
