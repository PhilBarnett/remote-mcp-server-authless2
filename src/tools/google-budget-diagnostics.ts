// Fixed read-only GAQL queries. No caller-supplied query, customer or mutation path.
export async function googleBudgetDiagnostics(
	search: (query: string) => Promise<any[]>,
	input: {
		campaign_id: string;
		expected_campaign_name: string;
		start_date: string;
		end_date: string;
	},
) {
	const {
		campaign_id: id,
		expected_campaign_name: name,
		start_date: start,
		end_date: end,
	} = input;
	if (!/^\d{1,20}$/.test(id) || !name.trim())
		throw new Error("Exact campaign ID/name are required.");
	const date = (v: string) =>
		/^\d{4}-\d{2}-\d{2}$/.test(v) &&
		Number.isFinite(Date.parse(v)) &&
		new Date(v).toISOString().slice(0, 10) === v;
	if (
		!date(start) ||
		!date(end) ||
		start > end ||
		(Date.parse(end) - Date.parse(start)) / 86400000 > 92
	)
		throw new Error("Use a valid ordered date range of at most 93 days.");
	const customers = await search(
		"SELECT customer.id, customer.currency_code, customer.time_zone FROM customer",
	);
	if (customers.length !== 1 || !/^\d{10}$/.test(String(customers[0].customer?.id)))
		throw new Error("Cannot establish configured customer identity.");
	const customer = customers[0].customer;
	if (customer.currencyCode !== "AUD")
		throw new Error("Budget diagnostics currently support AUD only.");
	const inventory = await search(
		`SELECT campaign.id, campaign.resource_name, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.campaign_budget, campaign.primary_status, campaign.primary_status_reasons, campaign.bidding_strategy_type, campaign.target_roas.target_roas, campaign.maximize_conversion_value.target_roas, campaign_budget.resource_name, campaign_budget.id, campaign_budget.name, campaign_budget.status, campaign_budget.period, campaign_budget.amount_micros, campaign_budget.total_amount_micros, campaign_budget.explicitly_shared, campaign_budget.reference_count FROM campaign WHERE campaign.id = ${id} LIMIT 2`,
	);
	if (inventory.length !== 1) throw new Error("Expected exactly one campaign.");
	const row = inventory[0],
		c = row.campaign,
		b = row.campaignBudget;
	if (
		String(c?.id) !== id ||
		c?.name !== name ||
		c.resourceName !== `customers/${customer.id}/campaigns/${id}`
	)
		throw new Error("Campaign identity mismatch.");
	const budget = c.campaignBudget;
	if (
		!budget ||
		!new RegExp(`^customers/${customer.id}/campaignBudgets/\\d+$`).test(budget) ||
		b?.resourceName !== budget
	)
		throw new Error("Campaign budget identity is missing or invalid.");
	const members = await search(
		`SELECT campaign.id, campaign.resource_name, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign WHERE campaign.campaign_budget = '${budget}' AND campaign.status IN ('ENABLED', 'PAUSED', 'REMOVED') LIMIT 2001`,
	);
	if (members.length >= 2001)
		throw new Error(
			"Budget membership exceeds safe reporting limit; refusing partial group totals.",
		);
	if (!members.some((r) => String(r.campaign?.id) === id))
		throw new Error("Selected campaign missing from budget group.");
	for (const r of members)
		if (
			!/^\d{1,20}$/.test(String(r.campaign?.id)) ||
			r.campaign.resourceName !== `customers/${customer.id}/campaigns/${r.campaign.id}`
		)
			throw new Error("Budget member identity mismatch.");
	const money = (v: unknown) => {
		if (
			v === undefined ||
			v === null ||
			!/^\d+$/.test(String(v)) ||
			!Number.isSafeInteger(Number(v))
		)
			return null;
		return Number(v) / 1_000_000;
	};
	const ids = members.map((r) => String(r.campaign.id));
	const dailyRows = await search(
		`SELECT campaign.id, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks FROM campaign WHERE campaign.id IN (${ids.join(",")}) AND segments.date BETWEEN '${start}' AND '${end}' AND campaign.status IN ('ENABLED', 'PAUSED', 'REMOVED') ORDER BY segments.date ASC`,
	);
	if (dailyRows.length >= 10000)
		throw new Error("Daily data may be truncated; refusing partial totals.");
	const daily = new Map<string, number>(),
		totals = new Map(ids.map((x) => [x, 0]));
	for (let t = Date.parse(start); t <= Date.parse(end); t += 86400000)
		daily.set(new Date(t).toISOString().slice(0, 10), 0);
	for (const r of dailyRows) {
		const cid = String(r.campaign?.id),
			day = r.segments?.date,
			cost = money(r.metrics?.costMicros);
		if (!totals.has(cid) || !daily.has(day) || cost === null)
			throw new Error("Incomplete or unexpected daily spend row.");
		daily.set(day, daily.get(day)! + cost);
		totals.set(cid, totals.get(cid)! + cost);
	}
	let share: any = null,
		shareError: string | null = null;
	try {
		const rows = await search(
			`SELECT campaign.id, metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share FROM campaign WHERE campaign.id = ${id} AND segments.date BETWEEN '${start}' AND '${end}'`,
		);
		if (rows.length > 1 || rows.some((r) => String(r.campaign?.id) !== id))
			throw new Error("Unexpected impression-share rows.");
		const fraction = (v: unknown) =>
			v === undefined ||
			v === null ||
			typeof v === "boolean" ||
			v === "" ||
			!Number.isFinite(Number(v)) ||
			Number(v) < 0 ||
			Number(v) > 1
				? null
				: Number(v);
		share = {
			search_impression_share: fraction(rows[0]?.metrics?.searchImpressionShare),
			search_budget_lost_impression_share: fraction(
				rows[0]?.metrics?.searchBudgetLostImpressionShare,
			),
			search_rank_lost_impression_share: fraction(
				rows[0]?.metrics?.searchRankLostImpressionShare,
			),
		};
	} catch {
		shareError =
			"Impression-share metrics unavailable for this campaign/date range or API query. Missing is not zero.";
	}
	const amount = money(b.amountMicros),
		totalAmount = money(b.totalAmountMicros);
	const dailyBudget = b.period === "DAILY" ? amount : null;
	const groupSpend = [...totals.values()].reduce((a, v) => a + v, 0);
	const reasons = Array.isArray(c.primaryStatusReasons) ? c.primaryStatusReasons : null;
	return {
		read_only: true,
		customer_id: String(customer.id),
		currency: customer.currencyCode,
		timezone: customer.timeZone ?? null,
		start_date: start,
		end_date: end,
		selected_campaign: {
			id,
			name: c.name,
			status: c.status,
			channel: c.advertisingChannelType,
			primary_status: c.primaryStatus ?? null,
			primary_status_reasons: reasons,
			bidding_strategy_type: c.biddingStrategyType ?? null,
			target_roas: c.targetRoas?.targetRoas ?? c.maximizeConversionValue?.targetRoas ?? null,
			spend_aud: totals.get(id),
		},
		budget: {
			id: b.id,
			name: b.name,
			status: b.status,
			period: b.period ?? null,
			daily_amount_aud: dailyBudget,
			total_amount_aud: totalAmount,
			explicitly_shared: typeof b.explicitlyShared === "boolean" ? b.explicitlyShared : null,
			reference_count: b.referenceCount ?? null,
		},
		members: members.map((r) => ({
			...r.campaign,
			spend_aud: totals.get(String(r.campaign.id)),
		})),
		group_spend_aud: groupSpend,
		average_group_daily_spend_aud: groupSpend / daily.size,
		indicative_current_budget_utilisation:
			dailyBudget && dailyBudget > 0 ? groupSpend / (dailyBudget * daily.size) : null,
		daily_group_spend: [...daily].map(([date, spend_aud]) => ({ date, spend_aud })),
		impression_share: share,
		impression_share_warning: shareError,
		current_explicit_budget_constraint: reasons?.includes("BUDGET_CONSTRAINED") ? true : null,
		historical_budget_loss_observed:
			share?.search_budget_lost_impression_share == null
				? null
				: share.search_budget_lost_impression_share > 0,
		interpretation:
			"Status and membership are current snapshots; spend and impression share cover the requested account-local dates. Current members may have moved budgets during this period. Utilisation uses today's daily budget, not historical budget changes, and is indicative only. Daily overdelivery and underspend alone do not prove budget constraint. Impression shares are Google estimates and can be bounded; unavailable fields remain null. Shared budgets affect every member; this diagnostic never validates or performs a budget mutation.",
	};
}
