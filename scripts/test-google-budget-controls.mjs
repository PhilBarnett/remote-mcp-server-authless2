import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";
import { z } from "zod";
import { googleExactBudgetSchema, prepareExactBudget, verifyExactBudget } from "../src/tools/google-budget-controls.ts";

const customerId = "6610097637";
const change = {
	action: "SET_DAILY_BUDGET_AUD", budget_id: "456", expected_budget_name: "Shared Shopping",
	expected_current_daily_budget_aud: 22, new_daily_budget_aud: 32,
	expected_member_campaigns: [
		{ campaign_id: "123", expected_campaign_name: "High Bid" },
		{ campaign_id: "124", expected_campaign_name: "Low Bid" },
	],
};
function setup() {
	const state = {
		account: [{ customer: { id: customerId, currencyCode: "AUD", timeZone: "Australia/Sydney" } }],
		budget: [{ campaignBudget: { id: "456", resourceName: `customers/${customerId}/campaignBudgets/456`,
			name: "Shared Shopping", status: "ENABLED", period: "DAILY", amountMicros: "22000000", explicitlyShared: true } }],
		members: change.expected_member_campaigns.map((c, i) => ({ campaign: { id: c.campaign_id,
			name: c.expected_campaign_name, resourceName: `customers/${customerId}/campaigns/${c.campaign_id}`,
			campaignBudget: `customers/${customerId}/campaignBudgets/456`, status: i ? "PAUSED" : "ENABLED" } })),
	};
	const calls = [];
	const search = async (q) => {
		calls.push(q);
		return structuredClone(q.endsWith("FROM customer") ? state.account : q.includes("FROM campaign_budget") ? state.budget : state.members);
	};
	return { state, search, calls };
}
test("exact shared $22 to $32 is one amount-only mutation, includes paused members, with exact rollback", async () => {
	const s = setup(), p = await prepareExactBudget(s.search, customerId, change);
	assert.equal(p.planned.after_daily_budget_aud, 32);
	assert.equal(p.planned.budget.members.length, 2);
	assert.deepEqual(p.operations, [{ campaignBudgetOperation: { update: {
		resourceName: `customers/${customerId}/campaignBudgets/456`, amountMicros: "32000000",
	}, updateMask: "amount_micros" } }]);
	assert.equal(p.rollback[0].campaignBudgetOperation.update.amountMicros, "22000000");
	assert.ok(s.calls.every((q) => q.startsWith("SELECT ")));
	s.state.budget[0].campaignBudget.amountMicros = "32000000";
	await verifyExactBudget(s.search, customerId, p.planned, true);
	s.state.budget[0].campaignBudget.amountMicros = "22000000";
	await verifyExactBudget(s.search, customerId, p.planned, false);
});
test("same generic path supports decreases, cents, individual budgets, deterministic no-op", async () => {
	for (const amount of [12.34, 22, 32, 500]) {
		const s = setup();
		s.state.budget[0].campaignBudget.explicitlyShared = false;
		s.state.members.pop();
		const p = await prepareExactBudget(s.search, customerId, { ...change,
			expected_member_campaigns: change.expected_member_campaigns.slice(0, 1), new_daily_budget_aud: amount });
		assert.equal(p.planned.after_daily_budget_aud, amount);
		assert.equal(p.operations.length, amount === 22 ? 0 : 1);
	}
});
test("invalid amounts, unrecognised fields, injection and incomplete expected membership are rejected", async () => {
	for (const edits of [
		{ new_daily_budget_aud: 0 }, { new_daily_budget_aud: -1 }, { new_daily_budget_aud: 500.01 },
		{ new_daily_budget_aud: 32.001 }, { new_daily_budget_aud: NaN }, { new_daily_budget_aud: Infinity },
		{ budget_id: "456 OR 1=1" }, { status: "ENABLED" },
		{ expected_member_campaigns: [] },
	]) assert.equal(googleExactBudgetSchema.safeParse({ ...change, ...edits }).success, false);
	for (const members of [change.expected_member_campaigns.slice(0, 1), [change.expected_member_campaigns[0], change.expected_member_campaigns[0]],
		[{ campaign_id: "123", expected_campaign_name: "Wrong" }, change.expected_member_campaigns[1]]]) {
		const s = setup();
		await assert.rejects(prepareExactBudget(s.search, customerId, { ...change, expected_member_campaigns: members }));
	}
});
test("currency, ownership, period, missing values, stale amount and truncated/duplicate membership fail closed", async () => {
	for (const edit of [
		(s) => { s.account[0].customer.currencyCode = "USD"; },
		(s) => { s.account[0].customer.id = "9999999999"; },
		(s) => { s.budget[0].campaignBudget.resourceName = "customers/9999999999/campaignBudgets/456"; },
		(s) => { s.budget[0].campaignBudget.name = "Different"; },
		(s) => { s.budget[0].campaignBudget.period = "CUSTOM_PERIOD"; },
		(s) => { s.budget[0].campaignBudget.status = "REMOVED"; },
		(s) => { delete s.budget[0].campaignBudget.explicitlyShared; },
		(s) => { delete s.budget[0].campaignBudget.amountMicros; },
		(s) => { s.budget[0].campaignBudget.amountMicros = "23000000"; },
		(s) => { s.members[0].campaign.campaignBudget = "wrong"; },
		(s) => { s.members = []; },
		(s) => { s.members.push(s.members[0]); },
		(s) => { s.members = Array(2001).fill(s.members[0]); },
	]) {
		const s = setup(); edit(s.state);
		await assert.rejects(prepareExactBudget(s.search, customerId, change));
	}
});
test("post-write membership/name/status drift is never reported as verified", async () => {
	for (const edit of [
		(s) => { s.members[0].campaign.name = "Changed"; },
		(s) => { s.members[0].campaign.status = "PAUSED"; },
		(s) => { s.budget[0].campaignBudget.explicitlyShared = false; },
		(s) => { s.budget[0].campaignBudget.amountMicros = "33000000"; },
	]) {
		const s = setup(), p = await prepareExactBudget(s.search, customerId, change);
		s.state.budget[0].campaignBudget.amountMicros = "32000000"; edit(s.state);
		await assert.rejects(verifyExactBudget(s.search, customerId, p.planned, true));
	}
});

// Exercise the real server schema, plan builder and verifier, not a test copy.
const source = await readFile("src/index.ts", "utf8");
const schemaText = source.slice(source.indexOf("const googleAdsCampaignChangeSchema ="), source.indexOf("async function getGoogleAdsCampaignControlSnapshot("));
const functions = source.slice(source.indexOf("async function buildGoogleAdsCampaignChangePlan("), source.indexOf("const ZIPGRIP_ASSET_REQUIREMENTS ="));
const compiled = await transform(schemaText + functions + "\nreturn { schema: googleAdsCampaignChangeSchema, build: buildGoogleAdsCampaignChangePlan, verify: verifyGoogleAdsCampaignChangePlan };", { loader: "ts", format: "cjs", target: "es2022" });
function integrated(s) {
	return new Function("z", "googleExactBudgetSchema", "prepareExactBudget", "verifyExactBudget", "googleAdsSearch", "getGoogleAdsConfig", "sha256Hex", compiled.code)(
		z, googleExactBudgetSchema, prepareExactBudget, verifyExactBudget, s.search,
		() => ({ customerId }), (bytes) => createHash("sha256").update(bytes).digest("hex"));
}
test("real tool plan accepts exact increase over25%, hashes member state, verifies and rejects duplicate budget writes", async () => {
	const s = setup(), api = integrated(s);
	const args = api.schema.parse({ changes: [change] });
	const before = await api.build(args);
	assert.equal(before.mutateOperations.length, 1);
	s.state.members.reverse();
	assert.equal((await api.build(args)).planSha256, before.planSha256, "API row ordering must not invalidate a preview");
	s.state.members[0].campaign.status = "ENABLED";
	assert.notEqual((await api.build(args)).planSha256, before.planSha256, "status drift invalidates approved hash");
	await assert.rejects(api.build({ changes: [change, change] }), /once/);
	s.state.members[0].campaign.status = "PAUSED";
	s.state.budget[0].campaignBudget.amountMicros = "32000000";
	await api.verify(before.plannedChanges, true);
	assert.equal(api.schema.safeParse({ changes: [{ action: "INCREASE_DAILY_BUDGET_PERCENT", campaign_id: "123", expected_campaign_name: "High Bid", increase_percent: 45.45 }] }).success, false);
});

const registrations = source.slice(source.indexOf('\tserver.registerTool(\n\t\t"preview_google_ads_campaign_changes"'), source.indexOf('\tserver.registerTool(\n\t\t"preview_google_ads_product_pmax_paused"'));
const flowCode = await transform(schemaText + functions + registrations + "\nreturn handlers;", { loader: "ts", format: "cjs", target: "es2022" });
function flow(s, mutate) {
	const handlers = {};
	return new Function("z", "googleExactBudgetSchema", "prepareExactBudget", "verifyExactBudget", "googleAdsSearch", "getGoogleAdsConfig", "sha256Hex", "server", "handlers", "googleAdsMutate", "toolResult", "toolError", "GOOGLE_ADS_CAMPAIGN_CHANGE_CONFIRMATION", "GOOGLE_ADS_CAMPAIGN_MAX_DAILY_BUDGET_AUD", flowCode.code)(
		z, googleExactBudgetSchema, prepareExactBudget, verifyExactBudget, s.search,
		() => ({ customerId }), (bytes) => createHash("sha256").update(bytes).digest("hex"),
		{ registerTool: (name, config, fn) => { handlers[name] = (args) => fn(config.inputSchema.parse(args)); } },
		handlers, mutate, (x) => x, (e) => ({ error: e.message }), "CONFIRM APPLY GOOGLE ADS CAMPAIGN CHANGES", 500);
}
test("actual preview/apply callbacks validateOnly, require confirmation/hash and verify $32; replay refuses a second write", async () => {
	const s = setup(), calls = [];
	const api = flow(s, async (ops, validateOnly) => {
		calls.push({ ops, validateOnly });
		if (!validateOnly) s.state.budget[0].campaignBudget.amountMicros = ops[0].campaignBudgetOperation.update.amountMicros;
	});
	const preview = await api.preview_google_ads_campaign_changes({ changes: [change] });
	assert.equal(preview.write_performed, false);
	assert.equal(calls.length, 1); assert.equal(calls[0].validateOnly, true);
	const args = { changes: [change], expected_plan_sha256: preview.plan_sha256, confirmation: "CONFIRM APPLY GOOGLE ADS CAMPAIGN CHANGES" };
	assert.throws(() => api.apply_google_ads_campaign_changes_guarded({ ...args, confirmation: "yes" }));
	const wrongHash = await api.apply_google_ads_campaign_changes_guarded({ ...args, expected_plan_sha256: "0".repeat(64) });
	assert.match(wrongHash.error, /changed after preview/);
	assert.equal(calls.length, 1);
	const applied = await api.apply_google_ads_campaign_changes_guarded(args);
	assert.equal(applied.verified, true); assert.equal(applied.updated, true);
	assert.equal(calls.filter((c) => !c.validateOnly).length, 1);
	assert.match((await api.apply_google_ads_campaign_changes_guarded(args)).error, /Current budget changed/);
	assert.equal(calls.filter((c) => !c.validateOnly).length, 1);
});
test("changed membership after preview and validation failure cannot write", async () => {
	for (const failure of ["member", "validation"]) {
		const s = setup(); let failValidation = false, writes = 0;
		const api = flow(s, async (_ops, validateOnly) => {
			if (validateOnly && failValidation) throw new Error("Validation failed");
			if (!validateOnly) writes++;
		});
		const p = await api.preview_google_ads_campaign_changes({ changes: [change] });
		if (failure === "member") s.state.members[1].campaign.status = "ENABLED";
		else failValidation = true;
		const r = await api.apply_google_ads_campaign_changes_guarded({ changes: [change], expected_plan_sha256: p.plan_sha256, confirmation: "CONFIRM APPLY GOOGLE ADS CAMPAIGN CHANGES" });
		assert.ok(r.error); assert.equal(writes, 0);
	}
});
test("post-write read failure restores exact original budget, but concurrent external change is never overwritten", async () => {
	for (const concurrent of [false, true]) {
		const s = setup(), baseSearch = s.search; let failRead = false, writes = 0;
		s.search = async (q) => {
			if (failRead) { failRead = false; throw new Error("Temporary verification failure"); }
			return baseSearch(q);
		};
		const api = flow(s, async (ops, validateOnly) => {
			if (validateOnly) return;
			writes++;
			s.state.budget[0].campaignBudget.amountMicros = ops[0].campaignBudgetOperation.update.amountMicros;
			if (writes === 1) {
				failRead = true;
				if (concurrent) s.state.budget[0].campaignBudget.amountMicros = "35000000";
			}
		});
		const p = await api.preview_google_ads_campaign_changes({ changes: [change] });
		const result = await api.apply_google_ads_campaign_changes_guarded({ changes: [change], expected_plan_sha256: p.plan_sha256, confirmation: "CONFIRM APPLY GOOGLE ADS CAMPAIGN CHANGES" });
		assert.match(result.error, concurrent ? /rollback could not be verified/ : /exact rollback succeeded/);
		assert.equal(writes, concurrent ? 1 : 2);
		assert.equal(s.state.budget[0].campaignBudget.amountMicros, concurrent ? "35000000" : "22000000");
	}
});
