// Reporting normalization only: raw events and Merchant Center IDs are unchanged.
export function canonicalItemReporting(rows: Array<Record<string, any>>, rowCount: number) {
	const groups = new Map<string, any>();
	for (const row of rows) {
		const raw = String(row.itemId ?? "");
		const match = /^(?:gla_)?([1-9]\d*)$/.exec(raw);
		const key = match ? match[1] : `raw:${raw}`;
		let group = groups.get(key);
		if (!group) {
			group = { canonical_item_id: match ? key : null, raw_item_ids: [], item_names: [], product_group: key === "128" ? "fabric_sample" : ["3839", "4788"].includes(key) ? "roller_blind" : "other_or_unknown", itemsViewed: 0, itemsAddedToCart: 0, itemsPurchased: 0, itemRevenue: 0 };
			groups.set(key, group);
		}
		if (!group.raw_item_ids.includes(raw)) group.raw_item_ids.push(raw);
		const name = String(row.itemName ?? "");
		if (!group.item_names.includes(name)) group.item_names.push(name);
		for (const metric of ["itemsViewed", "itemsAddedToCart", "itemsPurchased", "itemRevenue"]) {
			const value = Number(row[metric]);
			if (Number.isFinite(value)) group[metric] += value;
		}
	}
	return {
		rows: [...groups.values()],
		source_rows_truncated: rowCount > rows.length,
		methodology: "Only numeric and gla_<numeric> IDs are grouped. Metric sums are reported item quantities/events, not deduplicated orders or unique customers. Fabric Sample 128 is separate from roller products 3839/4788. Raw rows and advertising feed IDs remain unchanged; transaction-level collection and WooCommerce reconciliation are still required.",
	};
}
