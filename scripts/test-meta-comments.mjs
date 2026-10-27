import test from "node:test";
import assert from "node:assert/strict";
import {
	readMetaComments,
	createCommentReader,
	metaCommentsSchema,
} from "../src/tools/meta-comments.ts";
const page = "10",
	ig = "20",
	post = "10_30",
	media = "40",
	comment = "50";
const config = { adAccountId: "act_99", apiVersion: "v25.0", accessToken: "SECRET_SYSTEM_TOKEN" };
function setup(overrides = {}) {
	const calls = [];
	const responses = {
		"act_99/promote_pages": { data: [{ id: page, name: "Our page" }] },
		10: {
			id: page,
			access_token: "SECRET_PAGE_TOKEN",
			instagram_business_account: { id: ig, username: "our_ig" },
		},
		"10/posts": {
			data: [
				{
					id: post,
					message: "Post",
					permalink_url: "https://www.facebook.com/10/posts/30",
				},
			],
		},
		"10_30": {
			id: post,
			from: { id: page },
			permalink_url: "https://www.facebook.com/10/posts/30",
		},
		"10_30/comments": {
			data: [
				{
					id: comment,
					message: "How much?",
					from: { id: "60", name: "Customer" },
					comment_count: 1,
				},
			],
		},
		50: { id: comment, object: { id: post }, media: { id: media } },
		"50/comments": { data: [{ id: "51", message: "A reply", parent: { id: comment } }] },
		"20/media": {
			data: [
				{
					id: media,
					media_product_type: "REELS",
					media_type: "VIDEO",
					caption: "Our reel",
				},
			],
		},
		40: {
			id: media,
			owner: { id: ig },
			permalink: "https://www.instagram.com/reel/example/",
			media_product_type: "REELS",
		},
		"40/comments": { data: [{ id: comment, text: "Can you quote?", username: "customer" }] },
		"50/replies": { data: [{ id: "51", text: "Thread reply" }] },
		"me/permissions": { data: [{ permission: "pages_read_engagement", status: "granted" }] },
		"act_99/adcreatives": {
			data: [
				{ id: "70", effective_object_story_id: post, effective_instagram_media_id: media },
				{ id: "71", effective_object_story_id: "11_31" },
			],
		},
		...overrides,
	};
	const get = async (path, params, token) => {
		calls.push({ path, params, token });
		const body = responses[path];
		if (body instanceof Error) throw body;
		if (typeof body === "function") return body(params);
		assert.ok(body, `unexpected path ${path}`);
		return structuredClone(body);
	};
	return { calls, run: (args) => readMetaComments(get, config, { limit: 25, ...args }) };
}
test("strict bounded schema rejects writes, path injection, and unbounded limits", () => {
	for (const input of [
		{ action: "reply" },
		{ action: "inventory", limit: 51 },
		{ action: "inventory", limit: 0 },
		{ action: "facebook_comments", object_id: "40/likes" },
		{ action: "inventory", after: "https://evil.test/?access_token=x" },
		{ action: "inventory", token: "secret" },
	])
		assert.equal(metaCommentsSchema.safeParse(input).success, false);
});
test("inventory returns only approved metadata and safe pagination, never upstream next URL", async () => {
	const s = setup({
		"act_99/promote_pages": {
			data: [{ id: page, name: "Our page", access_token: "LEAK" }],
			paging: {
				next: "https://graph.facebook.com/?access_token=SECRET",
				cursors: { after: "NEXT==" },
			},
		},
	});
	const r = await s.run({ action: "inventory" });
	assert.equal(r.next_after, "NEXT==");
	assert.equal(r.has_more, true);
	assert.equal(r.data[0].access_token, undefined);
	assert.ok(!JSON.stringify(r).includes("SECRET"));
	assert.equal(s.calls.length, 1);
});
test("malformed cursor makes incomplete coverage explicit, never fetches arbitrary next URL", async () => {
	const s = setup({
		"act_99/promote_pages": {
			data: [],
			paging: { next: "https://evil.test", cursors: { after: "https://evil.test" } },
		},
	});
	const r = await s.run({ action: "inventory" });
	assert.equal(r.pagination_blocked, true);
	assert.equal(r.next_after, null);
	assert.equal(s.calls.length, 1);
});
test("Facebook ordinary posts and comments use Page token and bind ownership", async () => {
	const s = setup();
	const p = await s.run({ action: "facebook_posts", page_id: page });
	assert.equal(p.data[0].id, post);
	const r = await s.run({
		action: "facebook_comments",
		page_id: page,
		object_id: post,
		after: "NEXT",
	});
	assert.equal(r.data[0].message, "How much?");
	assert.equal(r.writes_performed, false);
	assert.equal(s.calls.find((c) => c.path === "10_30/comments").token, "SECRET_PAGE_TOKEN");
	assert.equal(s.calls.find((c) => c.path === "10_30/comments").params.after, "NEXT");
	assert.ok(!JSON.stringify(r).includes("TOKEN"));
});
test("missing Page token refuses Facebook reads rather than silently using advertising token", async () => {
	const s = setup({ 10: { id: page } });
	await assert.rejects(s.run({ action: "facebook_posts", page_id: page }), /No Page token/);
	assert.ok(!s.calls.some((c) => c.path === "10/posts"));
});
test("cross-page posts are rejected before comments are fetched", async () => {
	const s = setup({ "10_30": { id: post, from: { id: "11" } } });
	await assert.rejects(
		s.run({ action: "facebook_comments", page_id: page, object_id: post }),
		/does not match/,
	);
	assert.ok(!s.calls.some((c) => c.path === "10_30/comments"));
});
test("ownership scan is bounded and rejects repeated pagination", async () => {
	const s = setup({
		"act_99/promote_pages": {
			data: [],
			paging: { next: "present", cursors: { after: "REPEAT" } },
		},
	});
	await assert.rejects(
		s.run({ action: "facebook_posts", page_id: page }),
		/ownership was not established/,
	);
	assert.equal(s.calls.length, 2);
	const n = setup({
		"act_99/promote_pages": (params) => ({
			data: [],
			paging: { next: "present", cursors: { after: String(Number(params.after ?? 0) + 1) } },
		}),
	});
	await assert.rejects(n.run({ action: "facebook_posts", page_id: page }), /ownership/);
	assert.equal(n.calls.length, 10);
});
test("Facebook replies verify their post relationship", async () => {
	const s = setup();
	const r = await s.run({
		action: "facebook_replies",
		page_id: page,
		object_id: post,
		comment_id: comment,
	});
	assert.equal(r.data[0].id, "51");
	const bad = setup({ 50: { id: comment, object: { id: "11_31" } } });
	await assert.rejects(
		bad.run({
			action: "facebook_replies",
			page_id: page,
			object_id: post,
			comment_id: comment,
		}),
		/relationship/,
	);
});
test("Instagram media retains REELS identity; comment reads bind media to linked professional account", async () => {
	const s = setup();
	const list = await s.run({ action: "instagram_media", page_id: page });
	assert.equal(list.data[0].media_product_type, "REELS");
	const r = await s.run({ action: "instagram_comments", page_id: page, object_id: media });
	assert.equal(r.data[0].text, "Can you quote?");
	assert.equal(r.media_product_type, "REELS");
	const bad = setup({ 40: { id: media, owner: { id: "21" } } });
	await assert.rejects(
		bad.run({ action: "instagram_comments", page_id: page, object_id: media }),
		/ownership/,
	);
});
test("ad placement identity alone cannot authorise Instagram reads", async () => {
	const s = setup({ 10: { id: page, connected_instagram_account: { id: ig } } });
	await assert.rejects(
		s.run({ action: "instagram_media", page_id: page }),
		/professional Instagram/,
	);
});
test("Instagram replies are separate bounded reads and verify parent media", async () => {
	const s = setup();
	const r = await s.run({
		action: "instagram_replies",
		page_id: page,
		object_id: media,
		comment_id: comment,
	});
	assert.equal(r.data[0].id, "51");
	const bad = setup({ 50: { id: comment, media: { id: "41" } } });
	await assert.rejects(
		bad.run({
			action: "instagram_replies",
			page_id: page,
			object_id: media,
			comment_id: comment,
		}),
		/relationship/,
	);
});
test("ad-source mapping filters to selected Page and never claims complete ad coverage", async () => {
	const s = setup();
	const r = await s.run({ action: "ad_sources", page_id: page });
	assert.equal(r.data.length, 1);
	assert.equal(r.data[0].effective_object_story_id, post);
	assert.match(r.coverage, /no claim of complete ad coverage/);
});
test("diagnostics disclose uncertainty without tokens or publishing permissions", async () => {
	const s = setup();
	const r = await s.run({ action: "diagnostics", page_id: page });
	assert.equal(r.checks.page_token.available, true);
	assert.equal(r.checks.facebook_posts.comments_verified, false);
	assert.ok(!JSON.stringify(r).includes("SECRET"));
	const scopes = await s.run({ action: "diagnostics" });
	assert.equal(scopes.data[0].status, "granted");
});
test("oversized and malformed list results are refused", async () => {
	for (const data of [null, [null], [[]], Array.from({ length: 26 }, () => ({ id: "1" }))]) {
		const s = setup({ "act_99/promote_pages": { data } });
		await assert.rejects(s.run({ action: "inventory" }), /Unexpected Meta list/);
	}
});
test("transport is fixed-origin GET-only, bearer header only, and rejects redirect following", async () => {
	let seen;
	const get = createCommentReader(
		() => config,
		async (url, options) => {
			seen = { url, options };
			return Response.json({ data: [] });
		},
	);
	await get("10/posts", { fields: "id", after: "abc" }, "PAGE_SECRET");
	assert.match(seen.url, /^https:\/\/graph.facebook.com\/v25.0\/10\/posts/);
	assert.ok(!seen.url.includes("SECRET"));
	assert.equal(seen.options.method, "GET");
	assert.equal(seen.options.redirect, "manual");
	assert.equal(seen.options.headers.Authorization, "Bearer PAGE_SECRET");
	await assert.rejects(get("https://evil.test"), /Invalid Meta read path/);
});
test("transport sanitises API bodies, parse errors, network failures and HTTP-200 Graph errors", async () => {
	for (const response of [
		Response.json(
			{
				error: {
					code: 190,
					error_subcode: 463,
					message: "SECRET_SYSTEM_TOKEN https://secret",
				},
			},
			{ status: 400 },
		),
		Response.json({ error: { code: 10, message: "SECRET" } }),
		new Response("<html>SECRET</html>", { status: 502 }),
	]) {
		const get = createCommentReader(
			() => config,
			async () => response,
		);
		await assert.rejects(
			get("me/permissions"),
			(e) =>
				!e.message.includes("SECRET") &&
				!e.message.includes("https://secret") &&
				/Meta comment read failed/.test(e.message),
		);
	}
	const get = createCommentReader(
		() => config,
		async () => {
			throw Error("SECRET_SYSTEM_TOKEN");
		},
	);
	await assert.rejects(get("me/permissions"), (e) => !e.message.includes("SECRET"));
});
test("transport rejects oversized advertised and streamed responses", async () => {
	const get = createCommentReader(
		() => config,
		async () => new Response("{}", { headers: { "content-length": "2000001" } }),
	);
	await assert.rejects(get("me/permissions"), /safe read size/);
	const stream = createCommentReader(
		() => config,
		async () => new Response("x".repeat(2000001)),
	);
	await assert.rejects(stream("me/permissions"), /safe read size/);
});

test("redirect response is blocked before any follow-up request", async () => {
	let calls = 0;
	const get = createCommentReader(
		() => config,
		async () => {
			calls++;
			return Response.redirect("https://credential-sink.invalid", 302);
		},
	);
	await assert.rejects(get("me/permissions"), /redirect was blocked/);
	assert.equal(calls, 1);
});
