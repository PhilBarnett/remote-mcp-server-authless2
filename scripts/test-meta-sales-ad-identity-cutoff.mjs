import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";

const source = fs.readFileSync(new URL("../src/meta-ecommerce-toolkit.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source.replace(/^import .*;[ \t]*$/gm, ""), {
	compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const account = "123", campaign = "234", adset = "345", page = "456", ad = "567", video = "678", vertical = "679", creative = "789";
const landing = "https://example.test/everyday/";
const cutoff = "2099-11-30T23:59:00+11:00", canonical = "2099-11-30T12:59:00Z";
const thumbnailUrl = "https://scontent.example.fbcdn.net/thumbnail.jpg?signature=fixture";
const thumbnailHash = "ab".repeat(16);
const thumbnailBytes = Uint8Array.of(255, 216, 255, 217);
const createName = "Scoped sale once";
const providerAd = (data = {}) => ({ id: ad, account_id: account, name: createName, adset_id: adset, campaign_id: campaign,
	status: "PAUSED", effective_status: "PAUSED", creative: { id: creative, object_story_spec: { video_data: { video_id: video, call_to_action: { value: { link: landing } } } } }, ...data });
const parents = [
	{ id: adset, account_id: account, name: "Warm audience", campaign_id: campaign, status: "ACTIVE", destination_type: "WEBSITE", optimization_goal: "OFFSITE_CONVERSIONS", promoted_object: { pixel_id: "876" } },
	{ id: campaign, account_id: account, name: "Existing sales", status: "ACTIVE", objective: "OUTCOME_SALES" },
];
const createInput = {
	adset_id: adset, video_id: video, expected_video_title: "Owned sales video", page_id: page, name: createName,
	primary_text: "20% off for this event", headline: "20% off", cta_type: "SHOP_NOW", destination_url: landing, utm: {},
	ad_schedule_end_time: cutoff, confirmation: "CONFIRM CREATE PAUSED META ECOMMERCE AD",
};
const statusInput = { ad_id: ad, expected_ad_name: createName, expected_adset_id: adset, expected_adset_name: parents[0].name,
	expected_campaign_id: campaign, expected_campaign_name: parents[1].name, expected_current_status: "PAUSED", new_status: "ACTIVE",
	expected_ad_schedule_end_time: cutoff, confirmation: "CONFIRM META AD STATUS CHANGE" };

function harness(options = {}) {
	const calls = [], tools = {};
	let state = options.status ?? "PAUSED", created = false, scheduleReads = 0, placements;
	const mockFetch = async (url, opts) => {
		const u = new URL(url);
		if (u.hostname.endsWith(".fbcdn.net")) {
			assert.equal(url, thumbnailUrl);
			if (opts.redirect === "error") throw new TypeError("Workers does not support redirect error mode");
			assert.equal(opts.redirect, "manual");
			assert.equal(opts.credentials, "omit");
			assert.equal(opts.headers, undefined);
			calls.push({ method: "GET", path: "cdn-thumbnail" });
			if (options.cdnRedirect) return {
				status: options.cdnRedirect, ok: false,
				get headers() { throw new Error("Must not inspect redirect headers"); },
				get body() { throw new Error("Must not inspect redirect body"); },
			};
			if (options.cdnMime) return new Response(thumbnailBytes, { headers: { "content-type": options.cdnMime } });
			if (options.cdnOversize) return new Response(thumbnailBytes, { headers: { "content-type": "image/jpeg", "content-length": String(4 * 1024 * 1024 + 1) } });
			if (options.badDownload) return new Response("not an image", { headers: { "content-type": "image/jpeg" } });
			return new Response(thumbnailBytes, { headers: { "content-type": "image/jpeg" } });
		}
		const method = opts.method, path = u.pathname.slice(7);
		const params = Object.fromEntries(method === "GET" ? u.searchParams : opts.body);
		calls.push({ method, path, params });
		assert.equal(String(url).startsWith("https://graph.facebook.com/v27.0/"), true);
		if (method === "POST") {
			if (options.validationMode && path === `act_${account}/ads`) {
				assert.deepEqual(JSON.parse(params.execution_options), ["validate_only"]);
				assert.equal(params.status, "PAUSED");
				return options.validationMode(params);
			}
			if (options.failedPost === path) return Response.json({ error: { message: "signed CDN and token unsafe fixture", code: 100, error_subcode: 1443226 } }, { status: 400 });
			if (path === `act_${account}/adimages`) return Response.json({ images: options.invalidHash ? {} : { bytes: { hash: thumbnailHash } } });
			if (path === `act_${account}/adcreatives`) { placements = params.asset_feed_spec ? JSON.parse(params.asset_feed_spec) : undefined; return Response.json({ id: creative }); }
			if (path === `act_${account}/ads`) { created = true; return Response.json({ id: ad }); }
			if (path === ad) { state = params.status; return Response.json({ success: true }); }
			throw new Error("Unexpected POST " + path);
		}
		if (path === adset) return Response.json(parents[0]);
		if (path === campaign) return Response.json(parents[1]);
		if (path === `act_${account}/promote_pages`) return Response.json({ data: [{ id: page }] });
		if (path === `act_${account}/advideos`) return Response.json({ data: [{ id: video, title: "Owned sales video", created_time: "2099-01-01T00:00:00Z", length: 30, format: [{ width: 1080, height: 1350 }] }, { id: vertical, title: "Owned vertical video", created_time: "2099-01-01T00:00:00Z", length: 30, format: [{ width: 1080, height: 1920 }] }] });
		if (path === `${video}/thumbnails`) return Response.json({ data: options.badThumbnail
			? [{ uri: "https://evilfbcdn.net/wrong.jpg", width: 1080, height: 1920 }, { uri: thumbnailUrl, width: 160, height: 160 }]
			: [{ uri: thumbnailUrl, width: 1080, height: 1920, is_preferred: true }] });
		if (path === page) return Response.json({ instagram_business_account: { id: "876" } });
		if (path === `act_${account}/ads`) return Response.json(options.inventory?.(params.after) ?? { data: [] });
		if (options.story && path === page + "_123") return Response.json(options.story);
		if (options.validationMode && path === creative) {
			return Response.json({ id: creative, account_id: account, name: createName, ...providerAd().creative, ...options.validationCreative });
		}
		if (options.validationMode && path === "987") {
			return Response.json(providerAd({ id: "987", status: "ACTIVE", conversion_domain: options.siblingDomain ?? "example.test" }));
		}
		if (path === ad) {
			if (created && options.failedReadback) return Response.json({ error: { message: "Forbidden", code: 200 } }, { status: 403 });
			if (options.invisible) return Response.json({ error: { message: "Unsupported get request", code: 100, error_subcode: 33 } }, { status: 400 });
			if (options.wrongOwner) return Response.json(providerAd({ account_id: "000" }));
			if (options.mismatchedParent) return Response.json(providerAd({ adset_id: "000" }));
			if (params.fields?.split(",").includes("ad_schedule_end_time")) {
				if (options.legacyNoField) return Response.json({ error: { message: "Tried accessing nonexisting field (ad_schedule_end_time) on node type (Ad)", code: 100 } }, { status: 400 });
				++scheduleReads;
				const value = options.cutoff?.({ created, scheduleReads, state }) ?? (options.noCutoff ? undefined : "2099-11-30T23:59:00+1100");
				const actualPlacements = options.swapPlacementIds && placements ? { ...placements, videos: placements.videos.map((v, i) => ({ ...v, video_id: placements.videos[1 - i].video_id })) } : placements;
				return Response.json(providerAd({ status: state, ad_schedule_end_time: value, ...(actualPlacements ? { creative: { id: creative, asset_feed_spec: actualPlacements } } : {}) }));
			}
			return Response.json(providerAd({ status: state }));
		}
		throw new Error("Unexpected GET " + path);
	};
	const exports = {};
	new Function("exports", "env", "z", "fetch", "console", js)(
		exports, { META_ACCESS_TOKEN: "fixture-not-a-secret", META_AD_ACCOUNT_ID: account, META_API_VERSION: "v27.0", WC_SITE: landing }, z, mockFetch, { error() {} },
	);
	exports.registerMetaEcommerceToolkit({ registerTool(name, options, run) { tools[name] = [options.inputSchema, run]; } });
	return {
		calls, posts: () => calls.filter(c => c.method === "POST"),
		async run(name, params) { const [schema, run] = tools[name]; return run(schema.parse(params)); },
	};
}
const create = "create_meta_website_sales_video_ad_paused", update = "set_meta_ad_status_guarded", inspect = "inspect_meta_ecommerce_campaign_prelaunch";
const readArgs = { ad_id: ad, expected_adset_id: adset, campaign_id: campaign, expected_campaign_name: parents[1].name };
const errorText = (r) => r.content[0].text;
const failedStage = (r, stage) => {
	assert.equal(r.isError, undefined);
	const value = JSON.parse(errorText(r));
	assert.equal(value.ok, false);
	assert.equal(value.stage, stage);
	assert.equal(value.do_not_retry, true);
	return value;
};

test("reads exact owned published ad and normalized provider-supplied fields without changes", async () => {
	const h = harness(), r = await h.run(inspect, readArgs);
	const result = JSON.parse(r.content[0].text);
	assert.equal(result.ad.id, ad); assert.deepEqual(result.ad.video_ids, [video]);
	assert.equal(result.ad.ad_schedule_end_time, "2099-11-30T23:59:00+1100");
	assert.deepEqual(h.posts(), []);
});
test("unpublished or unavailable id never becomes permission to create", async () => {
	const h = harness({ invisible: true }), r = await h.run(inspect, readArgs);
	assert.equal(r.isError, true); assert.match(errorText(r), /Unsupported get request/);
	const rr = await h.run(create, { ...createInput, known_existing_ad_id: ad });
	assert.equal(failedStage(rr, "input").ad_id, ad);
	assert.deepEqual(h.posts(), []);
});
test("rejects mismatched parent and ownership before any write", async () => {
	for (const options of [{ wrongOwner: true }, { mismatchedParent: true }]) {
		const h = harness(options);
		assert.equal((await h.run(inspect, readArgs)).isError, true);
		assert.equal((await h.run(update, statusInput)).isError, true);
		assert.deepEqual(h.posts(), []);
	}
});
test("validates dates before any provider calls", async () => {
	for (const date of ["2099-11-30T23:59:00", "2099-02-31T23:59:00Z", "2020-01-01T00:00:00Z"]) {
		const h = harness();
		failedStage(await h.run(create, { ...createInput, ad_schedule_end_time: date }), "input");
		assert.deepEqual(h.calls, []);
	}
});
test("creates and verifies exactly one paused ad with equivalent cutoff", async () => {
	const h = harness(), r = await h.run(create, createInput);
	assert.equal(r.isError, undefined);
	assert.deepEqual(h.posts().map(p => p.path), [`act_${account}/adimages`, `act_${account}/adcreatives`, `act_${account}/ads`]);
	assert.equal(h.posts()[0].params.bytes, Buffer.from(thumbnailBytes).toString("base64"));
	const creativeData = JSON.parse(h.posts()[1].params.object_story_spec).video_data;
	assert.equal(creativeData.image_hash, thumbnailHash); assert.equal(creativeData.image_url, undefined);
	const post = h.posts()[2].params;
	assert.equal(post.status, "PAUSED"); assert.equal(post.ad_schedule_end_time, canonical);
	assert.equal(JSON.parse(r.content[0].text).ad.id, ad);
});
test("reports exact created id and forbids activation/retry when provider drops cutoff", async () => {
	const h = harness({ noCutoff: true }), r = await h.run(create, createInput);
	assert.equal(failedStage(r, "ad_readback").ad_id, ad);
	assert.equal(h.posts().length, 3); assert.equal(h.posts().some(p => p.params.status === "ACTIVE"), false);
});
test("refuses renamed same video on later page even with new UTM; no creation", async () => {
	const h = harness({ inventory: (cursor) => cursor === undefined
		? { data: [], paging: { next: "https://ignored.invalid/?sensitive=fixture", cursors: { after: "page2" } } }
		: { data: [providerAd({ name: "Other title", status: "ACTIVE" })] } });
	const r = await h.run(create, { ...createInput, destination_url: landing + "?utm_source=facebook" });
	assert.equal(failedStage(r, "duplicate_inventory").ad_id, ad);
	assert.deepEqual(h.posts(), []);
});
test("rejects partial inventory or a repeated pagination cursor", async () => {
	for (const inventory of [() => ({ data: [], paging: { next: "next" } }),
		() => ({ data: [], paging: { next: "next", cursors: { after: "same" } } }),
		() => ({ data: [{ id: "999", name: "unreadable", adset_id: adset }] }),
	]) {
		const h = harness({ inventory }), r = await h.run(create, createInput);
		failedStage(r, "duplicate_inventory"); assert.deepEqual(h.posts(), []);
	}
});
test("requires reviewed matching cutoff before activating a timed ad", async () => {
	for (const [options, expected] of [[{}, undefined], [{}, "2099-12-02T00:00:00Z"], [{ noCutoff: true }, cutoff], [{ legacyNoField: true }, cutoff]]) {
		const h = harness(options), r = await h.run(update, { ...statusInput, expected_ad_schedule_end_time: expected });
		assert.equal(r.isError, true); assert.deepEqual(h.posts(), []);
	}
});
test("activates exact owned ad only and leaves ordinary untimed activation compatible", async () => {
	for (const [options, expected] of [[{}, cutoff], [{ noCutoff: true }, undefined], [{ legacyNoField: true }, undefined]]) {
		const h = harness(options), r = await h.run(update, { ...statusInput, expected_ad_schedule_end_time: expected });
		assert.equal(r.isError, undefined);
		assert.deepEqual(h.posts(), [{ method: "POST", path: ad, params: { status: "ACTIVE" } }]);
	}
});
test("cutoff drift at readback rolls back only the previously validated ad", async () => {
	const h = harness({ cutoff: ({ scheduleReads }) => scheduleReads <= 1 ? "2099-11-30T23:59:00+1100" : "2099-12-01T00:59:00+1100" });
	const r = await h.run(update, statusInput);
	assert.equal(r.isError, true); assert.match(errorText(r), /rollback verified PAUSED/);
	assert.deepEqual(h.posts().map(p => [p.path, p.params.status]), [[ad, "ACTIVE"], [ad, "PAUSED"]]);
});

test("timed placement exact campaign, cutoff and source videos verify; swapped IDs fail", async () => {
	const place = "create_meta_website_sales_placement_video_ad_paused";
	const spec = { ...createInput, video_4x5_id: video, video_4x5_expected_name: "Owned sales video", video_4x5_expected_created_time: "2099-01-01T00:00:00Z",
		video_4x5_expected_length_seconds: 30, video_4x5_expected_width: 1080, video_4x5_expected_height: 1350,
		video_9x16_id: vertical, video_9x16_expected_name: "Owned vertical video", video_9x16_expected_created_time: "2099-01-01T00:00:00Z",
		video_9x16_expected_length_seconds: 30, video_9x16_expected_width: 1080, video_9x16_expected_height: 1920 };
	for (const swapPlacementIds of [false, true]) {
		const h = harness({ swapPlacementIds }), r = await h.run(place, spec);
		assert.equal(h.posts()[1].params.ad_schedule_end_time, canonical);
		assert.equal(h.posts()[1].params.status, "PAUSED");
		if (swapPlacementIds) { assert.equal(r.isError, true); assert.match(errorText(r), /Ad 567 did not verify both exact labeled placement videos/); }
		else { assert.equal(r.isError, undefined); assert.equal(JSON.parse(r.content[0].text).ad.campaign_id, campaign); }
	}
});
test("after successful POST, even when GET is forbidden preserve created ID in error", async () => {
	const h = harness({ failedReadback: true }), r = await h.run(create, createInput);
	const failure = failedStage(r, "ad_readback");
	assert.equal(failure.ad_id, ad); assert.equal(failure.creative_id, creative); assert.equal(failure.created, null);
	assert.equal(failure.provider_http_status, 403); assert.equal(failure.provider_code, 200);
	assert.deepEqual(h.posts().map(p => p.path), [`act_${account}/adimages`, `act_${account}/adcreatives`, `act_${account}/ads`]);
});

test("reports owned thumbnail dimensions without showing URI, downloading or creating it", async () => {
	const h = harness();
	const r = await h.run(inspect, { campaign_id: campaign, expected_campaign_name: parents[1].name, thumbnail_video_id: video });
	assert.deepEqual(JSON.parse(errorText(r)), { video_id: video, thumbnail_available: true, width: 1080, height: 1920 });
	assert.equal(h.calls.some(c => c.path === "cdn-thumbnail"), false);
	assert.deepEqual(h.posts(), []);
});
test("rejects missing, small or untrusted thumbnail and bad image bytes before any writes", async () => {
	for (const options of [{ badThumbnail: true }, { badDownload: true }]) {
		const h = harness(options);
		const r = await h.run(create, createInput);
		failedStage(r, options.badThumbnail ? "thumbnail_metadata" : "thumbnail_bytes");
		assert.doesNotMatch(errorText(r), /signature=|fbcdn|https:/);
		assert.deepEqual(h.posts(), []);
	}
});
test("does not create creative or ad if Graph returns no usable owned image hash", async () => {
	const h = harness({ invalidHash: true });
	const r = await h.run(create, createInput);
	failedStage(r, "thumbnail_image_registration");
	assert.deepEqual(h.posts().map(c => c.path), [`act_${account}/adimages`]);
});

test("inspect-only resolves exact duplicate inventory, bounded thumbnail bytes and cutoff without POST", async () => {
	const h = harness(), r = await h.run(inspect, { campaign_id: campaign, expected_campaign_name: parents[1].name, paused_ad_preflight: createInput });
	assert.equal(JSON.parse(errorText(r)).read_only_checks_passed, true);
	assert.match(errorText(r), /2099-11-30T12:59:00Z/);
	assert.equal(h.calls.filter(c => c.path === "cdn-thumbnail").length, 1);
	assert.ok(h.calls.some(c => c.path === `act_${account}/ads`));
	assert.deepEqual(h.posts(), []);
	const bad = harness({ badDownload: true });
	failedStage(await bad.run(inspect, { campaign_id: campaign, expected_campaign_name: parents[1].name, paused_ad_preflight: createInput }), "thumbnail_bytes");
	assert.deepEqual(bad.posts(), []);
});
test("preserves numeric provider errors on each POST without raw message or false certainty", async () => {
	for (const [edge, stage] of [["adimages", "thumbnail_image_registration"], ["adcreatives", "creative_create"], ["ads", "ad_create"]]) {
		const h = harness({ failedPost: `act_${account}/${edge}` });
		const r = await h.run(create, createInput);
		const result = failedStage(r, stage);
		assert.equal(result.provider_code, 100);
		assert.equal(result.provider_subcode, 1443226);
		assert.equal(result.may_have_created_ad, edge === "ads");
		assert.equal(h.posts().at(-1).path, `act_${account}/${edge}`);
		assert.doesNotMatch(errorText(r), /token unsafe fixture|signature|fbcdn/);
	}
});
test("Worker manual mode rejects redirects without reading their headers/body or following them", async () => {
	for (const status of [301, 302, 303, 304, 307, 308]) {
		const h = harness({ cdnRedirect: status });
		const r = await h.run(inspect, { campaign_id: campaign, expected_campaign_name: parents[1].name, paused_ad_preflight: createInput });
		const result = failedStage(r, "thumbnail_bytes");
		assert.equal(result.thumbnail_failure, "redirect_refused");
		assert.equal(result.thumbnail_http_status, status);
		assert.deepEqual(h.posts(), []);
		assert.equal(h.calls.filter(c => c.path === "cdn-thumbnail").length, 1);
	}
});
test("retains and safely distinguishes MIME, signature and size failures", async () => {
	for (const [options, reason] of [
		[{ cdnMime: "text/html" }, "unsupported_mime"],
		[{ badDownload: true }, "signature_mismatch"],
		[{ cdnOversize: true }, "size_limit"],
	]) {
		const h = harness(options);
		const r = await h.run(create, createInput);
		assert.equal(failedStage(r, "thumbnail_bytes").thumbnail_failure, reason);
		assert.doesNotMatch(errorText(r), /signature=|fbcdn|https:/);
		assert.deepEqual(h.posts(), []);
	}
});
const validateInput = { adset_id: adset, creative_id: creative, video_id: video, name: createName,
	destination_url: landing, ad_schedule_end_time: cutoff };

test("diagnoses exact existing creative through provider validate_only, with only the verified sibling domain as a variant", async () => {
	const h = harness({ validationMode: params => params.conversion_domain
		? Response.json({ success: true })
		: Response.json({ error: { code: 100, error_subcode: 3858351, message: "signed URL fixture",
			error_data: { blame_field_specs: [["conversion_domain", "signed URL fixture"]] } } }, { status: 400 }) });
	const args = { campaign_id: campaign, expected_campaign_name: parents[1].name };
	const baseline = JSON.parse(errorText(await h.run(inspect, { ...args, validate_existing_paused_ad: validateInput })));
	assert.equal(baseline.validation_only, true); assert.equal(baseline.validated, false);
	assert.equal(baseline.provider_subcode, 3858351); assert.deepEqual(baseline.blame_fields, ["conversion_domain"]);
	assert.doesNotMatch(JSON.stringify(baseline), /signed URL/);
	const variant = JSON.parse(errorText(await h.run(inspect, { ...args,
		validate_existing_paused_ad: { ...validateInput, conversion_domain_reference_ad_id: "987" } })));
	assert.equal(variant.validated, true); assert.equal(variant.conversion_domain, "example.test");
	assert.deepEqual(h.posts().map(x => x.path), [`act_${account}/ads`, `act_${account}/ads`]);
	const [a, b] = h.posts().map(x => x.params);
	assert.deepEqual(b, { ...a, conversion_domain: "example.test" });
	assert.equal(a.ad_schedule_end_time, canonical);
	assert.deepEqual(JSON.parse(a.creative), { creative_id: creative });
});

test("rejects wrong creative, sibling domain and duplicate before any POST, and never falls back after an unexpected response", async () => {
	const args = { campaign_id: campaign, expected_campaign_name: parents[1].name };
	for (const [options, extra] of [
		[{ validationCreative: { account_id: "999" } }, {}],
		[{ validationCreative: { name: "Wrong creative" } }, {}],
		[{ siblingDomain: "other.test" }, { conversion_domain_reference_ad_id: "987" }],
		[{ inventory: () => ({ data: [providerAd()] }) }, {}],
	]) {
		const h = harness({ ...options, validationMode: () => assert.fail("No POST expected") });
		const out = JSON.parse(errorText(await h.run(inspect, { ...args, validate_existing_paused_ad: { ...validateInput, ...extra } })));
		assert.equal(out.local_scope_check_failed, true);
		assert.deepEqual(h.posts(), []);
	}
	const h = harness({ validationMode: () => Response.json({ id: "123456" }) });
	const out = JSON.parse(errorText(await h.run(inspect, { ...args, validate_existing_paused_ad: validateInput })));
	assert.equal(out.unexpected_response, true); assert.equal(out.validated, false);
	assert.equal(h.posts().length, 1);
});

test("registered exact creative inspection keeps provider IDs distinct and returns sanitized reasons without POST", async () => {
	const name = "BLKFRI26 | Video 03 | Everyday & Premium Roller Blinds | ROLLER20";
	const fullName = name + " | Creative 2026-11-25-f826cbeafe567e1dc4032ab2a3c5ea8e";
	const post = page + "_123";
	const story = { id: post, attachments: { data: [{ media_type: "video", target: { id: video } }] } };
	for (const [extra, reason] of [
		[{}, "source_video_matches"],
		[{ id: "999" }, "creative_read_or_scope_failed"],
		[{ name: fullName + " other" }, "creative_name_mismatch"],
		[{ object_story_spec: {}, video_id: video }, "missing_source_lineage"],
		[{ video_id: vertical }, "conflicting_video_ids"],
		[{ object_story_spec: { video_data: { video_id: vertical } } }, "source_video_mismatch"],
		[{ object_story_spec: {}, effective_object_story_id: post }, "source_video_matches"],
		[{ effective_object_story_id: "999_123" }, "effective_story_page_mismatch"],
	]) {
		const h = harness({ validationMode: () => assert.fail("unexpected POST"), story,
			validationCreative: { name: fullName, ...extra } });
		const args = { campaign_id: campaign, expected_campaign_name: parents[1].name,
			inspect_existing_creative: { creative_id: creative, name, page_id: page, video_id: video } };
		const output = errorText(await h.run(inspect, args));
		assert.equal(JSON.parse(output).reason, reason);
		assert.doesNotMatch(output, /https?:|signature|access_token/);
		assert.deepEqual(h.posts(), []);
	}
});
