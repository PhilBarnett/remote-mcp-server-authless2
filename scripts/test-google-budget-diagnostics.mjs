import test from "node:test";
import assert from "node:assert/strict";
import { googleBudgetDiagnostics as run } from "../src/tools/google-budget-diagnostics.ts";
const input = {
	campaign_id: "123",
	expected_campaign_name: "High Bid",
	start_date: "2026-10-20",
	end_date: "2026-10-26",
};
function setup() {
	const calls = [];
	const member = (id) => ({
		campaign: {
			id,
			resourceName: `customers/6610097637/campaigns/${id}`,
			name: id === "123" ? "High Bid" : "Other",
			status: "ENABLED",
		},
	});
	const state = {
		account: [
			{ customer: { id: "6610097637", currencyCode: "AUD", timeZone: "Australia/Sydney" } },
		],
		inventory: [
			{
				...member("123"),
				campaignBudget: {
					resourceName: "customers/6610097637/campaignBudgets/456",
					id: "456",
					name: "Shared",
					period: "DAILY",
					amountMicros: "30000000",
					explicitlyShared: true,
					referenceCount: "2",
				},
			},
		],
		members: [member("123"), member("124")],
		daily: [
			{
				campaign: { id: "123" },
				segments: { date: "2026-10-20" },
				metrics: { costMicros: "15000000" },
			},
			{
				campaign: { id: "124" },
				segments: { date: "2026-10-20" },
				metrics: { costMicros: "20000000" },
			},
		],
		shares: [
			{
				campaign: { id: "123" },
				metrics: {
					searchBudgetLostImpressionShare: 0.25,
					searchRankLostImpressionShare: 0,
				},
			},
		],
	};
	Object.assign(state.inventory[0].campaign, {
		campaignBudget: "customers/6610097637/campaignBudgets/456",
		primaryStatus: "LIMITED",
		primaryStatusReasons: ["BUDGET_CONSTRAINED"],
	});
	const search = async (q) => {
		calls.push(q);
		if (q.endsWith("FROM customer")) return state.account;
		if (q.includes("campaign_budget.amount_micros")) return state.inventory;
		if (q.includes("WHERE campaign.campaign_budget")) return state.members;
		if (q.includes("segments.date,")) return state.daily;
		if (state.shares instanceof Error) throw state.shares;
		return state.shares;
	};
	return { state, calls, search };
}
test("shared group includes all members, converts micros and returns distinct current/historical evidence", async () => {
	const s = setup(),
		r = await run(s.search, input);
	assert.equal(r.budget.daily_amount_aud, 30);
	assert.equal(r.selected_campaign.spend_aud, 15);
	assert.equal(r.group_spend_aud, 35);
	assert.equal(r.daily_group_spend.length, 7);
	assert.equal(r.daily_group_spend[0].spend_aud, 35);
	assert.equal(r.daily_group_spend[1].spend_aud, 0);
	assert.equal(r.current_explicit_budget_constraint, true);
	assert.equal(r.historical_budget_loss_observed, true);
	assert.equal(r.members.length, 2);
	assert.ok(s.calls.every((q) => q.startsWith("SELECT ")));
	assert.equal(s.calls.length, 5);
});
test("missing shares stay null; measured zero is retained; API failure preserves spend with warning", async () => {
	for (const v of [undefined, 0]) {
		const s = setup();
		s.state.shares = [
			{ campaign: { id: "123" }, metrics: { searchBudgetLostImpressionShare: v } },
		];
		const r = await run(s.search, input);
		assert.equal(r.impression_share.search_budget_lost_impression_share, v ?? null);
		assert.equal(r.historical_budget_loss_observed, v === 0 ? false : null);
	}
	const s = setup();
	s.state.shares = new Error("secret details");
	const r = await run(s.search, input);
	assert.equal(r.group_spend_aud, 35);
	assert.equal(r.impression_share, null);
	assert.ok(!r.impression_share_warning.includes("secret"));
});
test("no explicit reason does not assert there is no constraint; lifetime budget has no daily utilisation", async () => {
	const s = setup();
	delete s.state.inventory[0].campaign.primaryStatusReasons;
	s.state.inventory[0].campaignBudget.period = "CUSTOM_PERIOD";
	const r = await run(s.search, input);
	assert.equal(r.current_explicit_budget_constraint, null);
	assert.equal(r.indicative_current_budget_utilisation, null);
});
test("invalid dates and query injection fail before any query", async () => {
	for (const bad of [
		{ campaign_id: "123 OR 1=1" },
		{ start_date: "2026-02-30" },
		{ end_date: "2027-10-26" },
		{ end_date: "2026-10-19" },
	]) {
		const s = setup();
		await assert.rejects(run(s.search, { ...input, ...bad }));
		assert.equal(s.calls.length, 0);
	}
});
test("wrong identity/currency, missing members, unsafe budget resource and truncated groups fail closed", async () => {
	for (const change of [
		(s) => (s.inventory[0].campaign.name = "Wrong"),
		(s) => (s.account[0].customer.currencyCode = "USD"),
		(s) => (s.inventory[0].campaign.campaignBudget = "x' OR 1=1"),
		(s) => (s.members = []),
		(s) => (s.members = Array(2001).fill(s.members[0])),
		(s) => (s.daily[0].metrics.costMicros = undefined),
	]) {
		const s = setup();
		change(s.state);
		await assert.rejects(run(s.search, input));
	}
});
