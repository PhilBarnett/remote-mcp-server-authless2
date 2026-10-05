import test from "node:test";
import assert from "node:assert/strict";
import { readChatgptAds } from "../src/tools/chatgpt-ads.ts";

const account = { id: "adacct_6ac4305ad094819e97ddf2ada19c5a78", timezone: "Australia/Sydney", currency_code: "AUD", status: "active" };
function setup(responses, secret = "test-secret-not-a-real-key") {
	const calls = [];
	const deps = {
		getBindings: () => ({ OPENAI_ADS_API_KEY: secret }),
		fetch: async (url, options) => {
			calls.push({ url: new URL(url), options });
			const next = responses.shift();
			return next instanceof Response ? next : new Response(JSON.stringify(next), { status: 200 });
		},
	};
	return { deps, calls };
}
test("missing key makes no request", async () => {
	const { deps, calls } = setup([], "");
	await assert.rejects(readChatgptAds(deps, { action: "account" }), /not configured/);
	assert.equal(calls.length, 0);
});
test("wrong account blocks subsequent reporting", async () => {
	const { deps, calls } = setup([{ ...account, id: "adacct_other" }]);
	await assert.rejects(readChatgptAds(deps, { action: "campaigns" }), /identity mismatch/);
	assert.equal(calls.length, 1);
});
test("inventory is authenticated, bounded and preserves incomplete pagination", async () => {
	const { deps, calls } = setup([account, { data: [], has_more: true, last_id: "cmpn_next" }]);
	const result = await readChatgptAds(deps, { action: "campaigns", limit: 10, after: "cmpn_previous" });
	assert.equal(result.page_complete, false);
	assert.equal(result.currency, "AUD");
	assert.equal(calls[1].url.searchParams.get("after"), "cmpn_previous");
	assert.equal(calls[1].url.searchParams.get("limit"), "10");
	for (const call of calls) {
		assert.equal(call.url.origin, "https://api.ads.openai.com");
		assert.equal(call.options.method, "GET");
		assert.equal(call.options.redirect, "error");
	}
});
test("upstream error bodies never expose secrets", async () => {
	const { deps } = setup([new Response("test-secret-not-a-real-key", { status: 401 })]);
	await assert.rejects(readChatgptAds(deps, { action: "account" }), error => error.message.includes("401") && !error.message.includes("test-secret"));
});
test("success responses redact an echoed credential", async () => {
	const { deps } = setup([{ ...account, unexpected: "test-secret-not-a-real-key" }]);
	const result = await readChatgptAds(deps, { action: "account" });
	assert.equal(result.account.unexpected, "[REDACTED]");
});
test("invalid identities and arbitrary request fields fail before fetching", async () => {
	const { deps, calls } = setup([]);
	await assert.rejects(readChatgptAds(deps, { action: "ad_groups", campaign_id: "../ad_account" }));
	await assert.rejects(readChatgptAds(deps, { action: "ads" }), /requires ad_group_id/);
	await assert.rejects(readChatgptAds(deps, { action: "account", url: "https://other.example" }));
	assert.equal(calls.length, 0);
});
const range = { start_unix: Date.parse("2026-10-04T00:00:00+10:00") / 1000, end_unix: Date.parse("2026-10-05T00:00:00+11:00") / 1000 };
test("delivery accepts a Sydney DST day and sends the exclusive timestamp range", async () => {
	const { deps, calls } = setup([account, { data: [], has_more: false }]);
	const result = await readChatgptAds(deps, { action: "delivery", ...range });
	assert.equal(result.end_unix_exclusive - result.start_unix, 23 * 3600);
	assert.deepEqual(JSON.parse(calls[1].url.searchParams.get("time_ranges[]")), { type: "unix_range", start: range.start_unix, end: range.end_unix });
});
test("ambiguous, reversed and overlong report windows are blocked", async () => {
	for (const input of [{}, { ...range, start_unix: range.start_unix + 3600 }, { start_unix: range.end_unix, end_unix: range.start_unix }, { start_unix: range.start_unix, end_unix: range.start_unix + 367 * 86400 }]) {
		const { deps, calls } = setup([account]);
		await assert.rejects(readChatgptAds(deps, { action: "delivery", ...input }));
		assert.equal(calls.length, 1);
	}
});
test("conversion POST is only the documented reporting query and declares attribution", async () => {
	const { deps, calls } = setup([account, { data: [], account_currency: "AUD" }]);
	const result = await readChatgptAds(deps, { action: "conversions", ...range, view_window_days: 0 });
	assert.equal(calls[1].url.pathname, "/v1/conversions/insights");
	assert.equal(calls[1].options.method, "POST");
	const body = JSON.parse(calls[1].options.body);
	assert.equal(body.group_by_entity, false);
	assert.equal(body.view_through_attribution_window_days, 0);
	assert.deepEqual(body.include, ["attributed_events"]);
	assert.equal(result.attribution.time_basis, "ad_event_time");
});
