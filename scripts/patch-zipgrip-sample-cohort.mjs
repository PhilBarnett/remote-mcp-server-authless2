import fs from "node:fs";

const file = "src/index.ts";
let source = fs.readFileSync(file, "utf8");

if (source.includes('"get_zipgrip_sample_to_purchase_cohort"')) {
	console.log("ZipGrip cohort tool already present; nothing to patch.");
	process.exit(0);
}

const helperAnchor = "function safeOrderAttribution(order: any) {";
if (!source.includes(helperAnchor)) throw new Error("safeOrderAttribution anchor not found");

const helpers = String.raw`
function normaliseCohortEmail(value: unknown) {
	if (typeof value !== "string") return null;
	const email = value.trim().toLowerCase();
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function normaliseCohortPhone(value: unknown) {
	if (typeof value !== "string" && typeof value !== "number") return null;
	const digits = String(value).replace(/\D/g, "");
	if (digits.length < 8) return null;
	return digits.startsWith("61") && digits.length >= 10 ? digits.slice(2) : digits.replace(/^0/, "");
}

function zipGripTextMatches(value: unknown) {
	const text = String(value ?? "").toLowerCase();
	return (
		text.includes("zipgrip") ||
		text.includes("zip-grip") ||
		text.includes("zip sided") ||
		text.includes("zip-sided") ||
		text.includes("zipsided") ||
		text.includes("zip guided") ||
		text.includes("zip-guided") ||
		text.includes("zipscreen") ||
		text.includes("zip screen")
	);
}

function isSampleLineItem(item: any) {
	return /sample/i.test(String(item?.name ?? "")) || /sample/i.test(String(item?.sku ?? ""));
}

function isZipGripSampleOrder(order: any) {
	if (!GENUINE_STATUSES.has(String(order?.status ?? ""))) return false;
	const lineItems = Array.isArray(order?.line_items) ? order.line_items : [];
	const explicitZipSample = lineItems.some(
		(item: any) => isSampleLineItem(item) && zipGripTextMatches(`${item?.name ?? ""} ${item?.sku ?? ""}`),
	);
	if (explicitZipSample) return true;

	const hasGenericSample = lineItems.some((item: any) => isSampleLineItem(item));
	return hasGenericSample && safeOrderAttribution(order).sample_intent === "ZipGrip";
}

function zipGripPurchaseLineRevenue(order: any) {
	return (Array.isArray(order?.line_items) ? order.line_items : []).reduce(
		(total: number, item: any) => {
			if (isSampleLineItem(item)) return total;
			if (!zipGripTextMatches(`${item?.name ?? ""} ${item?.sku ?? ""}`)) return total;
			return total + Number(item?.total ?? 0);
		},
		0,
	);
}

function isZipGripPurchaseOrder(order: any) {
	return isGenuineCommercialOrder(order) && zipGripPurchaseLineRevenue(order) > 0;
}

function cohortDateMs(value: unknown) {
	const date = String(value ?? "").slice(0, 10);
	const ms = Date.parse(`${date}T00:00:00Z`);
	return Number.isFinite(ms) ? ms : null;
}

function cohortMedian(values: number[]) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? sorted[middle]
		: (sorted[middle - 1] + sorted[middle]) / 2;
}

function cohortDaysBetween(start: unknown, end: unknown) {
	const startMs = cohortDateMs(start);
	const endMs = cohortDateMs(end);
	if (startMs === null || endMs === null) return null;
	return Math.floor((endMs - startMs) / 86_400_000);
}

`;

source = source.replace(helperAnchor, helpers + helperAnchor);

const toolAnchors = [
	'\tserver.registerTool(\n\t\t"get_orders",',
	'\tserver.registerTool(\n\t\t"get_sales_summary",',
	'\tserver.registerTool(\n\t\t"get_meta_ad_account",',
];
const toolAnchor = toolAnchors.find((anchor) => source.includes(anchor));
if (!toolAnchor) throw new Error("Could not find a safe tool-registration anchor");

const tool = String.raw`
	server.registerTool(
		"get_zipgrip_sample_to_purchase_cohort",
		{
			description:
				"Measure ZipGrip sample-to-purchase conversion using privacy-safe first-party WooCommerce matching. Email/phone matching occurs only inside the Worker; no customer PII is returned.",
			inputSchema: z.object({
				start_date: z.string().date(),
				end_date: z.string().date(),
				as_of_date: z.string().date().optional(),
				windows_days: z
					.array(z.number().int().min(7).max(365))
					.min(1)
					.max(8)
					.default([30, 60, 90, 180]),
				gross_margin_pct: z.number().min(0).max(100).default(51),
			}),
		},
		async ({ start_date, end_date, as_of_date, windows_days, gross_margin_pct }) => {
			try {
				const asOfDate = as_of_date ?? new Date().toISOString().slice(0, 10);
				const startMs = cohortDateMs(start_date);
				const endMs = cohortDateMs(end_date);
				const asOfMs = cohortDateMs(asOfDate);
				if (startMs === null || endMs === null || asOfMs === null) {
					throw new Error("Invalid cohort date supplied.");
				}
				if (startMs > endMs) throw new Error("start_date must be on or before end_date.");
				if (endMs > asOfMs) throw new Error("end_date cannot be after as_of_date.");
				if ((asOfMs - startMs) / 86_400_000 > 730) {
					throw new Error("Cohort analysis is capped at 730 days per request.");
				}

				const windows = [...new Set(windows_days)].sort((a, b) => a - b);
				const orders = await getAllOrders(start_date, asOfDate);
				const sampleOrders = orders.filter((order) => {
					const orderMs = cohortDateMs(order?.date_created);
					return (
						orderMs !== null &&
						orderMs >= startMs &&
						orderMs <= endMs &&
						isZipGripSampleOrder(order)
					);
				});
				const purchaseOrders = orders.filter(isZipGripPurchaseOrder);

				type CohortCustomer = {
					identity_key: string;
					matchable: boolean;
					email: string | null;
					phone: string | null;
					customer_id: number | null;
					first_sample_order_id: number;
					first_sample_date: string;
					sample_order_ids: number[];
				};

				const customers = new Map<string, CohortCustomer>();
				for (const order of [...sampleOrders].sort(
					(a, b) => Number(cohortDateMs(a?.date_created)) - Number(cohortDateMs(b?.date_created)),
				)) {
					const email = normaliseCohortEmail(order?.billing?.email);
					const phone = normaliseCohortPhone(order?.billing?.phone);
					const customerId = Number(order?.customer_id ?? 0) > 0 ? Number(order.customer_id) : null;
					const identityKey = email
						? `email:${email}`
						: phone
							? `phone:${phone}`
							: customerId
								? `customer:${customerId}`
								: `unmatchable:${order.id}`;
					const existing = customers.get(identityKey);
					if (existing) {
						existing.sample_order_ids.push(Number(order.id));
						continue;
					}
					customers.set(identityKey, {
						identity_key: identityKey,
						matchable: Boolean(email || phone || customerId),
						email,
						phone,
						customer_id: customerId,
						first_sample_order_id: Number(order.id),
						first_sample_date: String(order.date_created).slice(0, 10),
						sample_order_ids: [Number(order.id)],
					});
				}

				const customerRecords = [...customers.values()];
				const matchableCustomers = customerRecords.filter((customer) => customer.matchable);

				function purchaseMatchMethod(customer: CohortCustomer, order: any) {
					const purchaseEmail = normaliseCohortEmail(order?.billing?.email);
					if (customer.email && purchaseEmail === customer.email) return "email" as const;
					const purchasePhone = normaliseCohortPhone(order?.billing?.phone);
					if (customer.phone && purchasePhone === customer.phone) return "phone" as const;
					if (
						customer.customer_id &&
						Number(order?.customer_id ?? 0) === customer.customer_id
					) {
						return "customer_id" as const;
					}
					return null;
				}

				const windowResults = windows.map((windowDays) => {
					const matured = matchableCustomers.filter((customer) => {
						const sampleMs = cohortDateMs(customer.first_sample_date)!;
						return sampleMs + windowDays * 86_400_000 <= asOfMs;
					});
					const conversions: any[] = [];
					for (const customer of matured) {
						const sampleMs = cohortDateMs(customer.first_sample_date)!;
						const windowEndMs = sampleMs + windowDays * 86_400_000;
						const matched = purchaseOrders
							.map((order) => ({ order, match_method: purchaseMatchMethod(customer, order) }))
							.filter(({ order, match_method }) => {
								if (!match_method) return false;
								const purchaseMs = cohortDateMs(order?.date_created);
								return purchaseMs !== null && purchaseMs > sampleMs && purchaseMs <= windowEndMs;
							})
							.sort(
								(a, b) =>
									Number(cohortDateMs(a.order?.date_created)) -
									Number(cohortDateMs(b.order?.date_created)),
							);
						if (!matched.length) continue;
						const first = matched[0];
						const orderRevenue = matched.reduce(
							(total, row) => total + Number(row.order?.total ?? 0),
							0,
						);
						const zipGripRevenue = matched.reduce(
							(total, row) => total + zipGripPurchaseLineRevenue(row.order),
							0,
						);
						conversions.push({
							first_sample_order_id: customer.first_sample_order_id,
							sample_order_ids: customer.sample_order_ids,
							first_sample_date: customer.first_sample_date,
							match_method: first.match_method,
							first_purchase_order_id: Number(first.order.id),
							first_purchase_date: String(first.order.date_created).slice(0, 10),
							days_to_first_purchase: cohortDaysBetween(
								customer.first_sample_date,
								first.order.date_created,
							),
							purchase_order_ids: matched.map((row) => Number(row.order.id)),
							qualifying_order_revenue_aud: orderRevenue,
							zipgrip_line_revenue_aud: zipGripRevenue,
						});
					}

					const totalOrderRevenue = conversions.reduce(
						(total, conversion) => total + conversion.qualifying_order_revenue_aud,
						0,
					);
					const totalZipGripRevenue = conversions.reduce(
						(total, conversion) => total + conversion.zipgrip_line_revenue_aud,
						0,
					);
					const maturedCount = matured.length;
					const convertedCount = conversions.length;
					const matchMethodCounts = conversions.reduce(
						(counts, conversion) => {
							counts[conversion.match_method] = (counts[conversion.match_method] ?? 0) + 1;
							return counts;
						},
						{} as Record<string, number>,
					);
					const expectedOrderRevenue = maturedCount ? totalOrderRevenue / maturedCount : null;
					const expectedZipGripRevenue = maturedCount ? totalZipGripRevenue / maturedCount : null;
					return {
						window_days: windowDays,
						matured_matchable_sample_customers: maturedCount,
						converted_customers: convertedCount,
						conversion_rate: maturedCount ? convertedCount / maturedCount : null,
						match_methods: matchMethodCounts,
						purchase_order_count: conversions.reduce(
							(total, conversion) => total + conversion.purchase_order_ids.length,
							0,
						),
						qualifying_order_revenue_aud: totalOrderRevenue,
						zipgrip_line_revenue_aud: totalZipGripRevenue,
						average_qualifying_order_revenue_per_converted_customer_aud: convertedCount
							? totalOrderRevenue / convertedCount
							: null,
						median_qualifying_order_revenue_per_converted_customer_aud: cohortMedian(
							conversions.map((conversion) => conversion.qualifying_order_revenue_aud),
						),
						median_days_to_first_purchase: cohortMedian(
							conversions
								.map((conversion) => conversion.days_to_first_purchase)
								.filter((value): value is number => typeof value === "number"),
						),
						expected_qualifying_order_revenue_per_matured_sample_customer_aud:
							expectedOrderRevenue,
						expected_zipgrip_line_revenue_per_matured_sample_customer_aud:
							expectedZipGripRevenue,
						expected_gross_profit_per_matured_sample_customer_aud:
							expectedOrderRevenue === null
								? null
								: expectedOrderRevenue * (gross_margin_pct / 100),
						matches: conversions,
					};
				});

				return toolResult({
					cohort: {
						start_date,
						end_date,
						as_of_date: asOfDate,
						gross_margin_pct,
					},
					sample_order_count: sampleOrders.length,
					unique_sample_customers: customerRecords.length,
					matchable_sample_customers: matchableCustomers.length,
					unmatchable_sample_customers: customerRecords.length - matchableCustomers.length,
					identity_coverage_rate: customerRecords.length
						? matchableCustomers.length / customerRecords.length
						: null,
					windows: windowResults,
					privacy: {
						billing_email_returned: false,
						billing_phone_returned: false,
						matching_performed_inside_worker: true,
						match_priority: ["email", "phone", "customer_id"],
					},
					methodology: {
						sample_definition:
							"Zip-labelled sample product, or a generic sample order whose native Woo attribution is classified as ZipGrip intent.",
						purchase_definition:
							"Later genuine commercial WooCommerce order containing non-sample ZipGrip/Zip Sided/zip-guided line-item revenue.",
						denominator:
							"Unique matchable sample customers mature enough to have completed each requested conversion window.",
					},
					read_only: true,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

`;

source = source.replace(toolAnchor, tool + toolAnchor);
fs.writeFileSync(file, source);
console.log("Patched src/index.ts with ZipGrip sample-to-purchase cohort tool.");
