export const EQUINOX_PRICING_PATHS = [
	"/blindmotion-mcp/v1/wapf-pricing-storage",
	"/blindmotion-mcp/v1/wapf-pricing-details",
] as const;

export function assertEquinoxPricingReadOnly(path: string, method: string, body?: unknown, media?: unknown) {
	if (EQUINOX_PRICING_PATHS.some(allowed => allowed === path) &&
		(method !== "GET" || body !== undefined || media !== undefined)) {
		throw new Error("Equinox pricing inspection routes are read-only.");
	}
}

export function verifyEquinoxPricing(data: any, names: string[], details: boolean) {
	if (data?.read_only !== true || data?.write_performed !== false ||
		data?.plugin?.slug !== "blindmotion-wapf-pricing-bridge") {
		throw new Error("Equinox pricing bridge did not satisfy its read-only contract.");
	}
	if (details && (data.unrelated_values_returned !== false ||
		JSON.stringify(data.requested_lookup_names) !== JSON.stringify(names) ||
		JSON.stringify(Object.keys(data.lookups ?? {}).sort()) !== JSON.stringify([...names].sort()))) {
		throw new Error("Equinox pricing bridge returned a different lookup selection.");
	}
	if (!details && data.raw_values_returned !== false) {
		throw new Error("Equinox storage discovery unexpectedly returned raw values.");
	}
	return data;
}
