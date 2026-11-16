import { z } from "zod";
import { createCommentReader } from "./meta-comments";

const graphId = z.string().regex(/^\d{1,30}(?:_\d{1,30})?$/);
const pageId = z.enum(["495035137016242", "1383784325241628"]);
const target = { page_id: pageId, post_id: graphId, comment_id: graphId };

export const facebookPricingReplySchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("status") }).strict(),
	z.object({ action: z.literal("preview"), ...target }).strict(),
	z.object({ action: z.literal("publish"), ...target }).strict(),
]);

type Input = z.infer<typeof facebookPricingReplySchema>;
type Config = ReturnType<Parameters<typeof createCommentReader>[0]>;
type Ledger = { reserve(): Promise<boolean>; save(replyId: string): Promise<void> };
type Result = Record<string, unknown>;

const products = [
	{ pattern: /\bstraight[ -]drop\b/i, name: "Straight Drop", path: "straightdrop-outdoor-blinds" },
	{ pattern: /\b(?:zip[ -]?(?:grip|glide|sided|guided)|zipsided)\b/i, name: "ZipGrip", path: "zipsided-outdoor-blinds" },
	{ pattern: /\bcable[ -]guid(?:e|ed)\b/i, name: "Cable Guide", path: "cableguide-outdoor-blinds" },
];

function priceEnquiry(message: string) {
	const text = message.replace(/[’‘]/g, "'").replace(/[×]/g, "x").trim();
	// Only short, standalone pricing requests. Everything else stays in the review queue.
	const size = "\\d+(?:\\.\\d+)?\\s*(?:mm|cm|m)?";
	const dimensions = size + "\\s*x\\s*" + size;
	return new RegExp(
		"^(?:hi[,! ]+)?(?:how much(?: is (?:it|this|one))?|what(?: is|'s) the price|price|cost)" +
		"(?:\\s+(?:for\\s+)?" + dimensions + ")?(?:\\s+please)?[?.! ]*$",
		"i",
	).test(text);
}

function skip(reason: string): Result {
	return { outcome: "review", posted: false, reason };
}

export async function runFacebookPricingReply(
	input: Input,
	config: Config,
	commentToken: string | undefined,
	ledger: Ledger | undefined,
	fetcher: typeof fetch = fetch,
): Promise<Result> {
	if (!commentToken) return skip("Dedicated Meta comments credential is missing.");
	const social = createCommentReader(() => ({ ...config, accessToken: commentToken }), fetcher);
	const permissions = await social("me/permissions", { fields: "permission,status", limit: 100 });
	const granted = Array.isArray(permissions.data) && permissions.data.some(
		(row: { permission?: string; status?: string }) =>
			row.permission === "pages_manage_engagement" && row.status === "granted",
	);
	if (input.action === "status") return { publish_permission_reported: granted, posted: false };
	if (input.action === "publish" && (!granted || !ledger))
		return skip("Facebook publishing permission or the reply ledger is unavailable.");

	const page = await social(input.page_id, { fields: "id,access_token" });
	if (page.id !== input.page_id || typeof page.access_token !== "string" || !page.access_token)
		return skip("Meta did not return a token for the selected Page.");
	const pageToken: string = page.access_token;
	const post = await social(input.post_id, { fields: "id,from{id},permalink_url" }, pageToken);
	if (post.id !== input.post_id || post.from?.id !== input.page_id)
		return skip("The selected Page could not be verified as the post author.");

	// A supplied comment ID alone cannot establish membership. Meta video and post
	// objects can use different IDs, so use the verified parent object's comments edge.
	let after: string | undefined;
	let comment;
	for (let batch = 0; batch < 3; batch++) {
		const edge = await social(input.post_id + "/comments", {
			fields: "id,message,created_time,comment_count,can_comment,from{id},parent{id},permalink_url",
			filter: "toplevel", order: "reverse_chronological", limit: 50, after,
		}, pageToken);
		if (!Array.isArray(edge.data)) return skip("Meta returned an unrecognised comments list.");
		comment = edge.data.find((row: { id?: string }) => row.id === input.comment_id);
		const next = edge.paging?.next && edge.paging?.cursors?.after;
		if (comment || typeof next !== "string" || !/^[A-Za-z0-9_+=/.-]{1,2048}$/.test(next) || next === after) break;
		after = next;
	}
	if (!comment || comment.parent || comment.from?.id === input.page_id)
		return skip("A top-level customer comment on the selected post could not be verified.");
	const age = Date.now() - Date.parse(comment.created_time);
	if (!Number.isFinite(age) || age < 0 || age > 72 * 60 * 60 * 1000)
		return skip("Only comments from the past 72 hours are eligible for automatic replies.");
	if (comment.comment_count !== 0 || comment.can_comment !== true)
		return skip("The comment already has replies or Meta did not confirm that it can be answered.");
	if (typeof comment.message !== "string" || !priceEnquiry(comment.message))
		return skip("The comment is outside the automatic pricing reply rules.");

	// Facebook Page posts expose message and videos expose description.
	const contentField = post.permalink_url?.includes("/reel/") && !input.post_id.includes("_")
		? "description" : "message";
	const content = await social(input.post_id, { fields: contentField }, pageToken);
	const caption = content[contentField];
	const matches = typeof caption === "string" ? products.filter(product => product.pattern.test(caption)) : [];
	if (matches.length !== 1) return skip("A single product could not be identified from the original post.");
	const product = matches[0];
	const message = "Hi! Our " + product.name + " outdoor blinds are made to measure. Enter your width and drop and choose your options to see your price here: https://online.blindmotion.com.au/" + product.path + "/";
	if (input.action === "preview") return { outcome: "eligible", posted: false, message, publish_permission_reported: granted };

	// Recheck immediately before claiming the write. Reservation is atomic across Worker
	// isolates, including calls addressing the same parent via different post identifiers.
	const latest = await social(input.comment_id, { fields: "id,message,comment_count,can_comment" }, pageToken);
	if (latest.id !== input.comment_id || latest.message !== comment.message ||
		latest.comment_count !== 0 || latest.can_comment !== true)
		return skip("The comment changed or received a reply before publication.");
	if (!await ledger!.reserve())
		return { outcome: "already_attempted", posted: false, reason: "Inspect the existing thread before any manual retry." };

	const url = new URL("https://graph.facebook.com/" + config.apiVersion + "/" + input.comment_id + "/comments");
	let replyId: string;
	try {
		const response = await fetcher(url, {
			method: "POST",
			redirect: "error",
			headers: { Authorization: "Bearer " + pageToken, Accept: "application/json" },
			body: new URLSearchParams({ message }),
			signal: AbortSignal.timeout(15000),
		});
		const result = await response.json() as { id?: unknown; error?: { code?: unknown } };
		if (!response.ok || result.error || typeof result.id !== "string" || !graphId.safeParse(result.id).success)
			return { outcome: "unconfirmed", posted: null, meta_code: Number.isInteger(result.error?.code) ? result.error?.code : null };
		replyId = result.id;
	} catch {
		return { outcome: "unconfirmed", posted: null };
	}
	try {
		await ledger!.save(replyId);
		const reply = await social(replyId, { fields: "id,from{id},parent{id},message,permalink_url" }, pageToken);
		const verified = reply.id === replyId && reply.from?.id === input.page_id &&
			reply.parent?.id === input.comment_id && reply.message === message;
		return { outcome: verified ? "published" : "unconfirmed", posted: true, reply_id: replyId, permalink: verified ? reply.permalink_url ?? null : null };
	} catch {
		return { outcome: "unconfirmed", posted: true, reply_id: replyId };
	}
}
