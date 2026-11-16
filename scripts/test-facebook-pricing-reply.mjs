import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const bundle = await build({
	entryPoints: ["src/tools/facebook-pricing-reply.ts"],
	bundle: true,
	write: false,
	format: "esm",
	platform: "node",
});
const { runFacebookPricingReply, facebookPricingReplySchema } = await import(
	"data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);

const pageId = "495035137016242";
const postId = "1732342868000642";
const commentId = "122200693178604315_1413041074146181";
const replyId = "122200693178604315_1012260561218556";
const input = { action: "publish", page_id: pageId, post_id: postId, comment_id: commentId };
const config = { apiVersion: "v25.0", adAccountId: "act_99", accessToken: "ads-token" };
const comment = {
	id: commentId, message: "how much for 2mx2m?", comment_count: 0,
	can_comment: true, created_time: new Date(Date.now() - 60_000).toISOString(),
};

function setup({ granted = true, found = comment, latest = found, caption = "Straight Drop Outdoor Blinds", failure = false, owner = pageId } = {}) {
	const writes = [];
	let reserved = false;
	let saved;
	const ledger = {
		async reserve() {
			if (reserved) return false;
			reserved = true;
			return true;
		},
		async save(id) { saved = id; },
	};
	const fetcher = async (url, options) => {
		const request = new URL(url);
		assert.equal(request.origin, "https://graph.facebook.com");
		assert.equal(request.searchParams.has("access_token"), false);
		const path = request.pathname.replace("/v25.0/", "");
		if (path === "me/permissions") {
			assert.equal(options.headers.Authorization, "Bearer social-token");
			return Response.json({ data: granted ? [{ permission: "pages_manage_engagement", status: "granted" }] : [] });
		}
		if (path === pageId) return Response.json({ id: pageId, access_token: "page-token" });
		assert.equal(options.headers.Authorization, "Bearer page-token");
		if (options.method === "POST") {
			assert.equal(path, commentId + "/comments");
			assert.equal(options.redirect, "error");
			writes.push(options.body.get("message"));
			if (failure) throw new Error("Uncertain write");
			return Response.json({ id: replyId });
		}
		if (path === postId + "/comments") return Response.json({ data: [found] });
		if (path === postId) {
			return Response.json({ id: postId, from: { id: owner }, permalink_url: "https://www.facebook.com/reel/" + postId + "/", description: caption });
		}
		if (path === commentId) return Response.json(latest);
		if (path === replyId) {
			return Response.json({ id: replyId, parent: { id: commentId }, from: { id: pageId }, message: writes[0] });
		}
		assert.fail("Unexpected path " + path);
	};
	return {
		run: (action = "publish") => runFacebookPricingReply({ ...input, action }, config, "social-token", ledger, fetcher),
		writes,
		saved: () => saved,
	};
}

test("refuses arbitrary message content and unknown Pages", () => {
	assert.equal(facebookPricingReplySchema.safeParse({ ...input, message: "Write this" }).success, false);
	assert.equal(facebookPricingReplySchema.safeParse({ ...input, page_id: "44" }).success, false);
});

test("previews a Straight Drop reply without attempting to publish", async () => {
	const mock = setup({ granted: false });
	const result = await mock.run("preview");
	assert.equal(result.outcome, "eligible");
	assert.match(result.message, /straightdrop-outdoor-blinds/);
	assert.equal(result.publish_permission_reported, false);
	assert.equal(mock.writes.length, 0);
});

test("publishes once for concurrent invocations and verifies the reply author and parent", async () => {
	const mock = setup();
	const results = await Promise.all([mock.run(), mock.run()]);
	assert.deepEqual(results.map(result => result.outcome).sort(), ["already_attempted", "published"]);
	assert.equal(mock.writes.length, 1);
	assert.equal(mock.saved(), replyId);
});

test("never repeats a write after a timeout or ambiguous result", async () => {
	const mock = setup({ failure: true });
	assert.equal((await mock.run()).outcome, "unconfirmed");
	assert.equal((await mock.run()).outcome, "already_attempted");
	assert.equal(mock.writes.length, 1);
});

test("skips missing permission, mismatched ownership, replies, changed text and ambiguous or unrelated enquiries", async () => {
	for (const options of [
		{ granted: false },
		{ owner: "22" },
		{ found: { ...comment, id: "44" } },
		{ found: { ...comment, comment_count: 1 } },
		{ latest: { ...comment, comment_count: 1 } },
		{ latest: { ...comment, message: "Changed" } },
		{ found: { ...comment, message: "How much, and can you check my existing order?" } },
		{ caption: "Straight Drop or ZipGrip" },
	]) {
		const mock = setup(options);
		assert.equal((await mock.run()).outcome, "review");
		assert.equal(mock.writes.length, 0);
	}
});
