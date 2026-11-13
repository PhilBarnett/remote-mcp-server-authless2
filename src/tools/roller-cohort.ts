// Exact sample selections, independent of landing-page attribution.
function text(value: unknown): string {
	return typeof value === "string" ? value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().toLowerCase() : "";
}
function meta(item: any, key: string): string {
	const values = (Array.isArray(item?.meta_data) ? item.meta_data : []).filter((m: any) => text(m.key) === key.toLowerCase());
	return values.length === 1 ? text(values[0].value) : "";
}
export function isRollerOnlySampleOrder(order: any): boolean {
	if (!["processing", "completed"].includes(order?.status) || Number(order?.total) !== 0) return false;
	const items = Array.isArray(order?.line_items) ? order.line_items : [];
	if (!items.length || items.some((item: any) => Number(item?.product_id) !== 128)) return false;
	let selected = false;
	for (const item of items) {
		const product = meta(item, "Product");
		const rollerSelections = (Array.isArray(item?.meta_data) ? item.meta_data : []).filter(
			(m: any) => ["type of indoor blinds", "type of roller blinds"].includes(text(m.key)),
		);
		const roller = rollerSelections.length === 1 ? text(rollerSelections[0].value) : "";
		const outdoor = meta(item, "Type of Outdoor Blinds");
		if (!product && !rollerSelections.length && !outdoor && !(item.meta_data ?? []).some((m: any) => ["product", "type of outdoor blinds"].includes(text(m.key)))) continue;
		if (product !== "indoor blinds" || outdoor || !["everyday roller blinds", "premium roller blinds"].includes(roller)) return false;
		selected = true;
	}
	return selected;
}
export function rollerPurchaseLineRevenue(order: any): number {
	return (Array.isArray(order?.line_items) ? order.line_items : []).reduce((sum: number, item: any) => {
		if (![3839, 4788].includes(Number(item?.product_id))) return sum;
		const amount = Number(item.total);
		return Number.isFinite(amount) && amount > 0 ? sum + amount : sum;
	}, 0);
}
export function isRollerPurchaseOrder(order: any): boolean {
	return ["processing", "completed"].includes(order?.status) && Number(order?.total) > 20 && rollerPurchaseLineRevenue(order) > 0;
}
