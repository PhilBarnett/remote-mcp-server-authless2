type SampleAttributionFilter = {
	source?: string;
	medium?: string;
	campaign?: string;
};

type WooAttribution = {
	utm_source: unknown;
	utm_medium: unknown;
	utm_campaign: unknown;
};

export function matchesSampleAttribution(
	attribution: WooAttribution,
	filter: SampleAttributionFilter,
): boolean {
	return (["source", "medium", "campaign"] as const).every((field) => {
		const expected = filter[field];
		if (expected === undefined) return true;
		const recorded = attribution[`utm_${field}`];
		return typeof recorded === "string" && recorded.trim() === expected;
	});
}
