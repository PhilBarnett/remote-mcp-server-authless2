import { z } from "zod";

const id = z.string().regex(/^\d{1,20}$/);
const aud = z.number().finite().min(0.01).max(500).multipleOf(0.01);
export const googleExactBudgetSchema = z.object({
	action: z.literal("SET_DAILY_BUDGET_AUD"),
	budget_id: id,
	expected_budget_name: z.string().min(1).max(255),
	expected_current_daily_budget_aud: aud,
	new_daily_budget_aud: aud,
	expected_member_campaigns: z.array(z.object({
		campaign_id: id,
		expected_campaign_name: z.string().min(1).max(255),
	}).strict()).min(1).max(2000),
}).strict();

type Search = (query: string) => Promise<any[]>;
type Change = z.infer<typeof googleExactBudgetSchema>;

// Exact amounts use cents, never compounded percentage calls. Both shared and
// individual DAILY budgets use the same identity/complete-membership safeguards.
export async function readExactBudget(search: Search, customerId: string, input: Change) {
	const change = googleExactBudgetSchema.parse(input);
	if (!/^\d{10}$/.test(customerId)) throw new Error("Invalid configured Google customer.");
	const account = await search("SELECT customer.id, customer.currency_code, customer.time_zone FROM customer");
	if (account.length !== 1 || String(account[0].customer?.id) !== customerId ||
		account[0].customer.currencyCode !== "AUD") throw new Error("Configured customer must match and use AUD.");
	const resource = `customers/${customerId}/campaignBudgets/${change.budget_id}`;
	const rows = await search(`SELECT campaign_budget.id, campaign_budget.resource_name, campaign_budget.name, campaign_budget.status, campaign_budget.period, campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign_budget WHERE campaign_budget.id = ${change.budget_id} LIMIT 2`);
	const b = rows[0]?.campaignBudget;
	if (rows.length !== 1 || String(b?.id) !== change.budget_id || b.resourceName !== resource ||
		b.name !== change.expected_budget_name || b.status !== "ENABLED" || b.period !== "DAILY" ||
		typeof b.explicitlyShared !== "boolean") throw new Error("Budget identity, DAILY period, status or sharing could not be verified.");
	if (!/^\d+$/.test(String(b.amountMicros)) || !Number.isSafeInteger(Number(b.amountMicros)) ||
		Number(b.amountMicros) <= 0 || Number(b.amountMicros) % 10000 !== 0) throw new Error("Current budget must be a positive whole-cent amount.");
	const members = await search(`SELECT campaign.id, campaign.resource_name, campaign.name, campaign.status, campaign.campaign_budget FROM campaign WHERE campaign.campaign_budget = '${resource}' AND campaign.status IN ('ENABLED', 'PAUSED', 'REMOVED') LIMIT 2001`);
	if (members.length === 0 || members.length >= 2001) throw new Error("Cannot verify complete budget membership.");
	const seen = new Set<string>();
	const campaigns = members.map((r) => {
		const c = r.campaign, cid = String(c?.id);
		if (!/^\d{1,20}$/.test(cid) || seen.has(cid) || c.resourceName !== `customers/${customerId}/campaigns/${cid}` ||
			c.campaignBudget !== resource || typeof c.name !== "string" ||
			!["ENABLED", "PAUSED", "REMOVED"].includes(c.status)) throw new Error("Invalid or duplicate budget member.");
		seen.add(cid);
		return { campaign_id: cid, expected_campaign_name: c.name, status: c.status };
	}).sort((a, b) => a.campaign_id.localeCompare(b.campaign_id));
	const expectedIds = new Set(change.expected_member_campaigns.map((c) => c.campaign_id));
	if (expectedIds.size !== change.expected_member_campaigns.length || campaigns.length !== expectedIds.size ||
		campaigns.some((c) => !change.expected_member_campaigns.some((e) => e.campaign_id === c.campaign_id && e.expected_campaign_name === c.expected_campaign_name))) {
		throw new Error("Budget membership differs from the exact approved campaign list.");
	}
	if (!b.explicitlyShared && campaigns.filter((c) => c.status !== "REMOVED").length > 1) throw new Error("Unexpected non-shared budget membership.");
	return {
		customer_id: customerId, currency: "AUD", timezone: account[0].customer.timeZone ?? null,
		budget_id: change.budget_id, resource_name: resource, name: b.name,
		status: b.status, period: b.period, explicitly_shared: b.explicitlyShared,
		amount_micros: String(b.amountMicros), members: campaigns,
	};
}

export async function prepareExactBudget(search: Search, customerId: string, input: Change) {
	const change = googleExactBudgetSchema.parse(input);
	const snapshot = await readExactBudget(search, customerId, change);
	const before = Math.round(change.expected_current_daily_budget_aud * 100) * 10000;
	const after = Math.round(change.new_daily_budget_aud * 100) * 10000;
	if (Number(snapshot.amount_micros) !== before) throw new Error("Current budget changed; preview again with the exact existing amount.");
	const operation = (amount: number) => ({ campaignBudgetOperation: {
		update: { resourceName: snapshot.resource_name, amountMicros: String(amount) }, updateMask: "amount_micros",
	} });
	return {
		planned: {
			action: change.action, budget: snapshot, requested: change,
			before_daily_budget_aud: before / 1000000, after_daily_budget_aud: after / 1000000,
			before_amount_micros: String(before), after_amount_micros: String(after), mutation_required: before !== after,
		},
		operations: before === after ? [] : [operation(after)],
		rollback: before === after ? [] : [operation(before)],
	};
}

export async function verifyExactBudget(search: Search, customerId: string, planned: any, after: boolean) {
	const snapshot = await readExactBudget(search, customerId, planned.requested);
	const expected = { ...planned.budget, amount_micros: after ? planned.after_amount_micros : planned.before_amount_micros };
	if (JSON.stringify(snapshot) !== JSON.stringify(expected)) throw new Error("Budget amount, identity or membership changed during verification.");
	return snapshot;
}
