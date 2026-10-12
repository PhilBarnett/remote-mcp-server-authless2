type Product = Record<string, any>;

export function assertProductImageEditAllowed(environment: string, product: Product, key: string, path: string) {
	if (environment === "live") return;
	if (environment !== "staging" || product.catalog_visibility !== "hidden") {
		throw new Error("Staging image edits require a hidden product; no write performed.");
	}
	if (product.status === "draft") return;
	if (product.status === "publish" && key === "_wapf_fieldgroup" &&
		/^_wapf_fieldgroup\.fields\[\d+\]\.options\.choices\[\d+\]\.image$/.test(path)) return;
	throw new Error("Published staging image edits require a hidden product and an exact WAPF choice-image path; no write performed.");
}

export function sameOptionValue(left: unknown, right: unknown): boolean {
	const canonical = (value: any): any => {
		if (Array.isArray(value)) return value.map(canonical);
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
		return value;
	};
	const parse = (value: any) => typeof value === "string" && /^[{[]/.test(value.trim()) ? JSON.parse(value) : value;
	return JSON.stringify(canonical(parse(left))) === JSON.stringify(canonical(parse(right)));
}

export function assertSameProductImageState(before: Product, after: Product) {
	for (const key of ["id", "name", "status", "catalog_visibility", "regular_price", "sale_price", "price"]) {
		if (before[key] !== after[key]) throw new Error("Product image edit state changed: " + key);
	}
}

export function changeWapfChoiceLabels(group: Product, selections: Array<{field_id: string; choice_slug?: string; expected_label: string; new_label: string}>) {
	const changed = structuredClone(group);
	const keys = selections.map(item => item.field_id + ":" + (item.choice_slug ?? ""));
	if (new Set(keys).size !== keys.length) throw new Error("Duplicate selected WAPF label target.");
	const results = selections.map(item => {
		if (item.expected_label === item.new_label) throw new Error("Selected label is unchanged.");
		const fields = changed.fields.filter((field: Product) => String(field.id ?? "") === item.field_id);
		if (fields.length !== 1) throw new Error("Selected field ID is missing or ambiguous: " + item.field_id);
		const field = fields[0];
		let target = field;
		if (item.choice_slug !== undefined) {
			if (!["radio", "image-swatch", "select"].includes(field.type)) throw new Error("Selected field is not a choice field.");
			const choices = (field.options?.choices ?? []).filter((choice: Product) => choice.slug === item.choice_slug);
			if (choices.length !== 1) throw new Error("Selected choice slug is missing or ambiguous.");
			target = choices[0];
		} else if (field.type !== "number") throw new Error("Field-label edits require number type.");
		if (target.label !== item.expected_label) throw new Error("Exact old label no longer matches: " + item.field_id);
		target.label = item.new_label;
		return {field_id: item.field_id, ...(item.choice_slug === undefined ? {} : {choice_slug: item.choice_slug}), before: item.expected_label, after: item.new_label};
	});
	return {changed, results};
}
