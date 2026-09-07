import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const COMMERCIAL_START_DATE = "2024-07-01";
const GENUINE_ORDER_MIN_TOTAL = 20;

const GENUINE_STATUSES = new Set(["processing", "completed", "on-hold"]);

function getAuthHeader() {
	const workerEnv = env as unknown as Record<string, string>;
	const auth = btoa(`${workerEnv.WC_CONSUMER_KEY}:${workerEnv.WC_CONSUMER_SECRET}`);

	return `Basic ${auth}`;
}

async function wcFetch(path: string, params: Record<string, string | number | undefined> = {}) {
	const workerEnv = env as unknown as Record<string, string>;
	const url = new URL(`${workerEnv.WC_SITE}/wp-json/wc/v3/${path}`);

	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) {
			url.searchParams.set(key, String(value));
		}
	}

	const response = await fetch(url.toString(), {
		headers: {
			Authorization: getAuthHeader(),
			Accept: "application/json",
		},
	});

	if (!response.ok) {
		const body = await response.text();

		throw new Error(`WooCommerce request failed: ${response.status} ${body}`);
	}

	return response;
}

function getMetaConfig() {
	const workerEnv = env as unknown as Record<string, string | undefined>;
	const accessToken = workerEnv.META_ACCESS_TOKEN;
	const configuredAccountId = workerEnv.META_AD_ACCOUNT_ID;
	const apiVersion = workerEnv.META_API_VERSION;

	if (!accessToken || !configuredAccountId || !apiVersion) {
		throw new Error(
			"Meta Ads is not configured. Set META_ACCESS_TOKEN, META_AD_ACCOUNT_ID and META_API_VERSION in Cloudflare.",
		);
	}

	const adAccountId = configuredAccountId.startsWith("act_")
		? configuredAccountId
		: `act_${configuredAccountId}`;

	return { accessToken, adAccountId, apiVersion };
}

async function metaFetch(path: string, params: Record<string, string | number | undefined> = {}) {
	const { accessToken, apiVersion } = getMetaConfig();
	const url = new URL(`https://graph.facebook.com/${apiVersion}/${path}`);

	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) {
			url.searchParams.set(key, String(value));
		}
	}

	const response = await fetch(url.toString(), {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
		},
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Meta Marketing API request failed: ${response.status} ${body}`);
	}

	return response.json<any>();
}

async function metaPost(path: string, params: Record<string, string | number>) {
	const { accessToken, apiVersion } = getMetaConfig();
	const url = new URL(`https://graph.facebook.com/${apiVersion}/${path}`);
	const body = new URLSearchParams();

	for (const [key, value] of Object.entries(params)) body.set(key, String(value));

	const response = await fetch(url.toString(), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body,
	});

	if (!response.ok) {
		throw new Error(
			`Meta Marketing API request failed: ${response.status} ${await response.text()}`,
		);
	}

	return response.json<any>();
}

function metaDateRange(startDate: string, endDate: string) {
	return JSON.stringify({ since: startDate, until: endDate });
}

const META_INSIGHT_FIELDS = [
	"account_currency",
	"impressions",
	"reach",
	"frequency",
	"clicks",
	"inline_link_clicks",
	"spend",
	"cpm",
	"cpc",
	"ctr",
	"actions",
	"action_values",
	"purchase_roas",
	"website_purchase_roas",
	"cost_per_action_type",
].join(",");

const META_PURCHASE_ACTION_TYPES = [
	"offsite_conversion.fb_pixel_purchase",
	"onsite_web_purchase",
	"omni_purchase",
	"purchase",
];

function getMetaMetricValue(metrics: any, actionTypes: string[]) {
	if (!Array.isArray(metrics)) return null;

	for (const actionType of actionTypes) {
		const metric = metrics.find((item: any) => item?.action_type === actionType);
		if (metric === undefined) continue;

		const value = Number(metric.value);
		if (Number.isFinite(value)) return value;
	}

	return null;
}

function enrichMetaInsight(row: any) {
	const purchases = getMetaMetricValue(row.actions, META_PURCHASE_ACTION_TYPES) ?? 0;
	const purchaseConversionValue = getMetaMetricValue(
		row.action_values,
		META_PURCHASE_ACTION_TYPES,
	);
	const reportedPurchaseRoas =
		getMetaMetricValue(row.website_purchase_roas, META_PURCHASE_ACTION_TYPES) ??
		getMetaMetricValue(row.purchase_roas, META_PURCHASE_ACTION_TYPES);
	const spend = Number(row.spend ?? 0);
	const calculatedPurchaseRoas =
		purchaseConversionValue !== null && spend > 0 ? purchaseConversionValue / spend : null;

	return {
		...row,
		purchase_roas_breakdown: row.purchase_roas ?? [],
		website_purchase_roas_breakdown: row.website_purchase_roas ?? [],
		purchases,
		purchase_conversion_value: purchaseConversionValue,
		purchase_roas: reportedPurchaseRoas ?? calculatedPurchaseRoas,
		cost_per_purchase: purchases > 0 && spend > 0 ? spend / purchases : null,
		purchase_value_reported: purchaseConversionValue !== null,
	};
}

function enrichMetaInsights(rows: any[]) {
	return rows.map(enrichMetaInsight);
}

function metaBudgetAmount(value: unknown) {
	if (value === undefined || value === null || value === "") return null;
	return Number((Number(value) / 100).toFixed(2));
}

function safeMetaBudgetObject(object: any, objectType: "campaign" | "adset") {
	return {
		object_type: objectType,
		id: object.id,
		name: object.name,
		campaign_id: objectType === "adset" ? object.campaign_id : object.id,
		status: object.status,
		effective_status: object.effective_status,
		daily_budget: metaBudgetAmount(object.daily_budget),
		lifetime_budget: metaBudgetAmount(object.lifetime_budget),
		budget_remaining: metaBudgetAmount(object.budget_remaining),
	};
}

type Ga4ServiceAccount = {
	client_email: string;
	private_key: string;
	token_uri?: string;
};

type Ga4ReportRequest = {
	dateRanges: Array<{ startDate: string; endDate: string }>;
	dimensions?: Array<{ name: string }>;
	metrics: Array<{ name: string }>;
	limit?: string;
	orderBys?: Array<Record<string, unknown>>;
};

let ga4AccessTokenCache: { token: string; expiresAt: number } | undefined;

function base64UrlEncode(value: string | ArrayBuffer) {
	const bytes =
		typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemToArrayBuffer(pem: string) {
	const base64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes.buffer;
}

function getGa4Config() {
	const workerEnv = env as unknown as Record<string, string | undefined>;
	const propertyId = workerEnv.GA4_PROPERTY_ID;
	const serviceAccountJson = workerEnv.GA4_SERVICE_ACCOUNT_JSON;

	if (!propertyId || !serviceAccountJson) {
		throw new Error(
			"GA4 is not configured. Set GA4_PROPERTY_ID and GA4_SERVICE_ACCOUNT_JSON in Cloudflare.",
		);
	}

	let serviceAccount: Ga4ServiceAccount;
	try {
		serviceAccount = JSON.parse(serviceAccountJson) as Ga4ServiceAccount;
	} catch {
		throw new Error("GA4_SERVICE_ACCOUNT_JSON is not valid JSON.");
	}

	if (!serviceAccount.client_email || !serviceAccount.private_key) {
		throw new Error("GA4_SERVICE_ACCOUNT_JSON is missing client_email or private_key.");
	}

	return { propertyId, serviceAccount };
}

async function getGa4AccessToken() {
	if (ga4AccessTokenCache && ga4AccessTokenCache.expiresAt > Date.now() + 60_000) {
		return ga4AccessTokenCache.token;
	}

	const { serviceAccount } = getGa4Config();
	const now = Math.floor(Date.now() / 1000);
	const tokenUri = serviceAccount.token_uri ?? "https://oauth2.googleapis.com/token";
	const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const claims = base64UrlEncode(
		JSON.stringify({
			iss: serviceAccount.client_email,
			scope: "https://www.googleapis.com/auth/analytics.readonly",
			aud: tokenUri,
			iat: now,
			exp: now + 3600,
		}),
	);
	const unsignedToken = `${header}.${claims}`;
	const key = await crypto.subtle.importKey(
		"pkcs8",
		pemToArrayBuffer(serviceAccount.private_key),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(unsignedToken),
	);
	const assertion = `${unsignedToken}.${base64UrlEncode(signature)}`;
	const response = await fetch(tokenUri, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion,
		}),
	});

	if (!response.ok) {
		throw new Error(`Google OAuth request failed: ${response.status} ${await response.text()}`);
	}

	const tokenResponse = await response.json<{ access_token: string; expires_in?: number }>();
	ga4AccessTokenCache = {
		token: tokenResponse.access_token,
		expiresAt: Date.now() + (tokenResponse.expires_in ?? 3600) * 1000,
	};
	return tokenResponse.access_token;
}

async function ga4RunReport(request: Ga4ReportRequest) {
	const { propertyId } = getGa4Config();
	const accessToken = await getGa4AccessToken();
	const response = await fetch(
		`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({ ...request, returnPropertyQuota: true }),
		},
	);

	if (!response.ok) {
		throw new Error(
			`Google Analytics Data API request failed: ${response.status} ${await response.text()}`,
		);
	}

	return response.json<any>();
}

function ga4ReportResult(report: any, startDate: string, endDate: string) {
	const dimensionNames = (report.dimensionHeaders ?? []).map((header: any) => header.name);
	const metricNames = (report.metricHeaders ?? []).map((header: any) => header.name);
	const rows = (report.rows ?? []).map((row: any) => ({
		...Object.fromEntries(
			dimensionNames.map((name: string, index: number) => [
				name,
				row.dimensionValues?.[index]?.value ?? "",
			]),
		),
		...Object.fromEntries(
			metricNames.map((name: string, index: number) => [
				name,
				row.metricValues?.[index]?.value ?? "0",
			]),
		),
	}));

	return {
		start_date: startDate,
		end_date: endDate,
		row_count: report.rowCount ?? rows.length,
		rows,
		property_quota: report.propertyQuota,
	};
}

async function getAllOrders(startDate: string, endDate: string) {
	const allOrders: any[] = [];
	const perPage = 100;
	const maxPages = 50;

	for (let page = 1; page <= maxPages; page++) {
		const response = await wcFetch("orders", {
			after: `${startDate}T00:00:00`,
			before: `${endDate}T23:59:59`,
			per_page: perPage,
			page,
			orderby: "date",
			order: "asc",
		});

		const orders = await response.json<any[]>();

		allOrders.push(...orders);

		if (orders.length < perPage) {
			break;
		}
	}

	return allOrders;
}

function isGenuineCommercialOrder(order: any) {
	const total = Number(order.total ?? 0);

	return total > GENUINE_ORDER_MIN_TOTAL && GENUINE_STATUSES.has(order.status);
}

function safeOrder(order: any) {
	return {
		id: order.id,
		date_created: order.date_created,
		status: order.status,
		customer_id: order.customer_id,
		currency: order.currency,
		total: order.total,
		discount_total: order.discount_total,
		shipping_total: order.shipping_total,
		payment_method_title: order.payment_method_title,
		line_items: order.line_items?.map((item: any) => ({
			product_id: item.product_id,
			variation_id: item.variation_id,
			name: item.name,
			sku: item.sku,
			quantity: item.quantity,
			subtotal: item.subtotal,
			total: item.total,
		})),
		coupon_lines: order.coupon_lines?.map((coupon: any) => ({
			code: coupon.code,
			discount: coupon.discount,
		})),
	};
}

function toolResult(data: any) {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify(data, null, 2),
			},
		],
	};
}

function toolError(error: unknown) {
	return {
		content: [
			{
				type: "text" as const,
				text: error instanceof Error ? error.message : String(error),
			},
		],
		isError: true,
	};
}

function createServer() {
	const server = new McpServer({
		name: "Blindmotion WooCommerce",
		version: "2.0.0",
	});

	/*
	 * Existing test tools
	 */

	server.registerTool(
		"add",
		{
			inputSchema: z.object({
				a: z.number(),
				b: z.number(),
			}),
		},
		async ({ a, b }) => ({
			content: [
				{
					type: "text",
					text: String(a + b),
				},
			],
		}),
	);

	server.registerTool(
		"calculate",
		{
			inputSchema: z.object({
				operation: z.enum(["add", "subtract", "multiply", "divide"]),
				a: z.number(),
				b: z.number(),
			}),
		},
		async ({ operation, a, b }) => {
			let result: number;

			switch (operation) {
				case "add":
					result = a + b;
					break;

				case "subtract":
					result = a - b;
					break;

				case "multiply":
					result = a * b;
					break;

				case "divide":
					if (b === 0) {
						return {
							content: [
								{
									type: "text",
									text: "Error: Cannot divide by zero",
								},
							],
						};
					}

					result = a / b;
					break;
			}

			return {
				content: [
					{
						type: "text",
						text: String(result),
					},
				],
			};
		},
	);

	/*
	 * Existing working WooCommerce tool
	 */

	server.registerTool(
		"get_recent_orders",
		{
			description: "Return recent Blindmotion WooCommerce orders without customer PII",
			inputSchema: z.object({
				limit: z.number().int().min(1).max(20),
			}),
		},
		async ({ limit }) => {
			try {
				const response = await wcFetch("orders", {
					per_page: limit,
					orderby: "date",
					order: "desc",
				});

				const orders = await response.json<any[]>();

				return toolResult(orders.map(safeOrder));
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/*
	 * 1. Sales Summary
	 */

	server.registerTool(
		"get_sales_summary",
		{
			description:
				"Summarise genuine Blindmotion commercial orders, revenue, AOV and discounts for a date range. Orders of $20 or less and non-commercial statuses are excluded.",
			inputSchema: z.object({
				start_date: z.string(),
				end_date: z.string(),
			}),
		},
		async ({ start_date, end_date }) => {
			try {
				const orders = await getAllOrders(start_date, end_date);

				const genuineOrders = orders.filter(isGenuineCommercialOrder);

				const revenue = genuineOrders.reduce(
					(sum, order) => sum + Number(order.total ?? 0),
					0,
				);

				const discounts = genuineOrders.reduce(
					(sum, order) => sum + Number(order.discount_total ?? 0),
					0,
				);

				const shipping = genuineOrders.reduce(
					(sum, order) => sum + Number(order.shipping_total ?? 0),
					0,
				);

				const orderCount = genuineOrders.length;

				const statusCounts: Record<string, number> = {};

				for (const order of genuineOrders) {
					statusCounts[order.status] = (statusCounts[order.status] ?? 0) + 1;
				}

				const sampleOrLowValueOrders = orders.filter(
					(order) => Number(order.total ?? 0) <= GENUINE_ORDER_MIN_TOTAL,
				).length;

				return toolResult({
					start_date,
					end_date,
					commercial_start_date: COMMERCIAL_START_DATE,
					genuine_order_min_total: GENUINE_ORDER_MIN_TOTAL,
					genuine_statuses: Array.from(GENUINE_STATUSES),
					order_count: orderCount,
					revenue: Number(revenue.toFixed(2)),
					average_order_value:
						orderCount > 0 ? Number((revenue / orderCount).toFixed(2)) : 0,
					discount_total: Number(discounts.toFixed(2)),
					shipping_total: Number(shipping.toFixed(2)),
					status_counts: statusCounts,
					sample_or_low_value_orders: sampleOrLowValueOrders,
					all_orders_in_period: orders.length,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/*
	 * 2. Query Orders
	 */

	server.registerTool(
		"get_orders",
		{
			description:
				"Query Blindmotion WooCommerce orders by date range and optional status. Returns order and line-item data without customer PII.",
			inputSchema: z.object({
				start_date: z.string(),
				end_date: z.string(),
				status: z.string().optional(),
				limit: z.number().int().min(1).max(100),
			}),
		},
		async ({ start_date, end_date, status, limit }) => {
			try {
				const response = await wcFetch("orders", {
					after: `${start_date}T00:00:00`,
					before: `${end_date}T23:59:59`,
					status,
					per_page: limit,
					orderby: "date",
					order: "desc",
				});

				const orders = await response.json<any[]>();

				return toolResult(orders.map(safeOrder));
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/*
	 * 3. Products
	 */

	server.registerTool(
		"get_products",
		{
			description:
				"Return Blindmotion WooCommerce products including product ID, SKU, price, status and categories.",
			inputSchema: z.object({
				search: z.string().optional(),
				status: z.string().optional(),
				category_id: z.number().int().optional(),
				limit: z.number().int().min(1).max(100),
			}),
		},
		async ({ search, status, category_id, limit }) => {
			try {
				const response = await wcFetch("products", {
					search,
					status,
					category: category_id,
					per_page: limit,
					orderby: "title",
					order: "asc",
				});

				const products = await response.json<any[]>();

				const safeProducts = products.map((product) => ({
					id: product.id,
					name: product.name,
					slug: product.slug,
					sku: product.sku,
					status: product.status,
					type: product.type,
					price: product.price,
					regular_price: product.regular_price,
					sale_price: product.sale_price,
					on_sale: product.on_sale,
					stock_status: product.stock_status,
					categories: product.categories?.map((category: any) => ({
						id: category.id,
						name: category.name,
						slug: category.slug,
					})),
				}));

				return toolResult(safeProducts);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/*
	 * 4. Single Order
	 */

	server.registerTool(
		"get_order",
		{
			description:
				"Investigate one Blindmotion WooCommerce order by order ID without exposing billing or shipping PII.",
			inputSchema: z.object({
				order_id: z.number().int().positive(),
			}),
		},
		async ({ order_id }) => {
			try {
				const response = await wcFetch(`orders/${order_id}`);

				const order = await response.json<any>();

				return toolResult({
					...safeOrder(order),
					date_paid: order.date_paid,
					date_completed: order.date_completed,
					transaction_id: order.transaction_id,
					fee_lines: order.fee_lines?.map((fee: any) => ({
						name: fee.name,
						total: fee.total,
						tax: fee.total_tax,
					})),
					shipping_lines: order.shipping_lines?.map((shipping: any) => ({
						method_title: shipping.method_title,
						total: shipping.total,
					})),
					refunds: order.refunds?.map((refund: any) => ({
						id: refund.id,
						reason: refund.reason,
						total: refund.total,
					})),
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/*
	 * 5. Coupons
	 */

	server.registerTool(
		"get_coupons",
		{
			description:
				"Return Blindmotion WooCommerce coupon configuration and usage information.",
			inputSchema: z.object({
				search: z.string().optional(),
				limit: z.number().int().min(1).max(100),
			}),
		},
		async ({ search, limit }) => {
			try {
				const response = await wcFetch("coupons", {
					search,
					per_page: limit,
					orderby: "date",
					order: "desc",
				});

				const coupons = await response.json<any[]>();

				const safeCoupons = coupons.map((coupon) => ({
					id: coupon.id,
					code: coupon.code,
					discount_type: coupon.discount_type,
					amount: coupon.amount,
					usage_count: coupon.usage_count,
					usage_limit: coupon.usage_limit,
					usage_limit_per_user: coupon.usage_limit_per_user,
					individual_use: coupon.individual_use,
					minimum_amount: coupon.minimum_amount,
					maximum_amount: coupon.maximum_amount,
					date_created: coupon.date_created,
					date_expires: coupon.date_expires,
					free_shipping: coupon.free_shipping,
				}));

				return toolResult(safeCoupons);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/*
	 * 6. Customer Order History
	 */

	server.registerTool(
		"get_customer_order_history",
		{
			description:
				"Return commercial order history for a WooCommerce customer ID, excluding customer PII.",
			inputSchema: z.object({
				customer_id: z.number().int().positive(),
			}),
		},
		async ({ customer_id }) => {
			try {
				const allOrders: any[] = [];
				const perPage = 100;

				for (let page = 1; page <= 20; page++) {
					const response = await wcFetch("orders", {
						customer: customer_id,
						after: `${COMMERCIAL_START_DATE}T00:00:00`,
						per_page: perPage,
						page,
						orderby: "date",
						order: "asc",
					});

					const orders = await response.json<any[]>();

					allOrders.push(...orders);

					if (orders.length < perPage) {
						break;
					}
				}

				const genuineOrders = allOrders.filter(isGenuineCommercialOrder);

				const totalRevenue = genuineOrders.reduce(
					(sum, order) => sum + Number(order.total ?? 0),
					0,
				);

				return toolResult({
					customer_id,
					genuine_order_count: genuineOrders.length,
					total_revenue: Number(totalRevenue.toFixed(2)),
					average_order_value:
						genuineOrders.length > 0
							? Number((totalRevenue / genuineOrders.length).toFixed(2))
							: 0,
					first_genuine_order: genuineOrders[0] ? safeOrder(genuineOrders[0]) : null,
					most_recent_genuine_order:
						genuineOrders.length > 0
							? safeOrder(genuineOrders[genuineOrders.length - 1])
							: null,
					orders: genuineOrders.map(safeOrder),
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/*
	 * 7. Product Sales
	 */

	server.registerTool(
		"get_product_sales",
		{
			description:
				"Aggregate product quantities and line-item revenue from genuine Blindmotion commercial orders for a date range.",
			inputSchema: z.object({
				start_date: z.string(),
				end_date: z.string(),
				limit: z.number().int().min(1).max(100),
			}),
		},
		async ({ start_date, end_date, limit }) => {
			try {
				const orders = await getAllOrders(start_date, end_date);

				const genuineOrders = orders.filter(isGenuineCommercialOrder);

				const productMap = new Map<
					string,
					{
						product_id: number;
						variation_id: number;
						name: string;
						sku: string;
						quantity: number;
						revenue: number;
						order_ids: Set<number>;
					}
				>();

				for (const order of genuineOrders) {
					for (const item of order.line_items ?? []) {
						const key = `${item.product_id}:${item.variation_id ?? 0}`;

						if (!productMap.has(key)) {
							productMap.set(key, {
								product_id: item.product_id,
								variation_id: item.variation_id ?? 0,
								name: item.name,
								sku: item.sku ?? "",
								quantity: 0,
								revenue: 0,
								order_ids: new Set<number>(),
							});
						}

						const product = productMap.get(key)!;

						product.quantity += Number(item.quantity ?? 0);

						product.revenue += Number(item.total ?? 0);

						product.order_ids.add(order.id);
					}
				}

				const products = Array.from(productMap.values())
					.map((product) => ({
						product_id: product.product_id,
						variation_id: product.variation_id,
						name: product.name,
						sku: product.sku,
						quantity: product.quantity,
						revenue: Number(product.revenue.toFixed(2)),
						order_count: product.order_ids.size,
					}))
					.sort((a, b) => b.revenue - a.revenue)
					.slice(0, limit);

				return toolResult({
					start_date,
					end_date,
					genuine_order_count: genuineOrders.length,
					products,
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/* Read-only Meta Ads reporting tools */

	server.registerTool(
		"get_meta_ad_account",
		{
			description:
				"Confirm the configured Blindmotion Meta ad account and return non-sensitive account metadata.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				const { adAccountId } = getMetaConfig();
				const account = await metaFetch(adAccountId, {
					fields: "id,account_id,name,account_status,currency,timezone_name,business_name,amount_spent,balance",
				});
				return toolResult(account);
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_meta_ads_summary",
		{
			description:
				"Summarise Blindmotion Meta Ads spend, reach, clicks, purchases, purchase conversion value and purchase ROAS for a date range.",
			inputSchema: z.object({
				start_date: z.string(),
				end_date: z.string(),
			}),
		},
		async ({ start_date, end_date }) => {
			try {
				const { adAccountId } = getMetaConfig();
				const result = await metaFetch(`${adAccountId}/insights`, {
					fields: META_INSIGHT_FIELDS,
					level: "account",
					time_range: metaDateRange(start_date, end_date),
				});
				return toolResult({
					start_date,
					end_date,
					data: enrichMetaInsights(result.data ?? []),
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	const registerMetaPerformanceTool = (
		name: string,
		level: "campaign" | "adset" | "ad",
		identityFields: string,
		description: string,
	) => {
		server.registerTool(
			name,
			{
				description,
				inputSchema: z.object({
					start_date: z.string(),
					end_date: z.string(),
					limit: z.number().int().min(1).max(100).default(50),
				}),
			},
			async ({ start_date, end_date, limit }) => {
				try {
					const { adAccountId } = getMetaConfig();
					const result = await metaFetch(`${adAccountId}/insights`, {
						fields: `${identityFields},${META_INSIGHT_FIELDS}`,
						level,
						time_range: metaDateRange(start_date, end_date),
						limit,
					});
					return toolResult({
						start_date,
						end_date,
						level,
						data: enrichMetaInsights(result.data ?? []),
					});
				} catch (error) {
					return toolError(error);
				}
			},
		);
	};

	registerMetaPerformanceTool(
		"get_meta_campaign_performance",
		"campaign",
		"campaign_id,campaign_name,objective",
		"Return read-only Meta Ads campaign performance, including purchase value and ROAS, for a date range.",
	);
	registerMetaPerformanceTool(
		"get_meta_adset_performance",
		"adset",
		"campaign_id,campaign_name,adset_id,adset_name,objective",
		"Return read-only Meta Ads ad-set performance, including purchase value and ROAS, for a date range.",
	);
	registerMetaPerformanceTool(
		"get_meta_ad_performance",
		"ad",
		"campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,objective",
		"Return read-only Meta Ads ad performance, including purchase value and ROAS, for a date range.",
	);

	server.registerTool(
		"get_meta_daily_performance",
		{
			description:
				"Return daily Blindmotion Meta Ads account performance, including purchase value and ROAS, for a date range.",
			inputSchema: z.object({
				start_date: z.string(),
				end_date: z.string(),
			}),
		},
		async ({ start_date, end_date }) => {
			try {
				const { adAccountId } = getMetaConfig();
				const result = await metaFetch(`${adAccountId}/insights`, {
					fields: META_INSIGHT_FIELDS,
					level: "account",
					time_increment: 1,
					time_range: metaDateRange(start_date, end_date),
					limit: 100,
				});
				return toolResult({
					start_date,
					end_date,
					data: enrichMetaInsights(result.data ?? []),
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_meta_budget_settings",
		{
			description:
				"Inspect current Meta campaign and ad-set budgets. Read-only; use this before any budget update.",
			inputSchema: z.object({
				status: z.enum(["ACTIVE", "PAUSED", "ALL"]).default("ACTIVE"),
				limit: z.number().int().min(1).max(100).default(50),
			}),
		},
		async ({ status, limit }) => {
			try {
				const { adAccountId } = getMetaConfig();
				const params: Record<string, string | number | undefined> = {
					fields: "id,name,status,effective_status,daily_budget,lifetime_budget,budget_remaining",
					limit,
				};
				if (status !== "ALL") params.effective_status = JSON.stringify([status]);

				const [campaignResult, adsetResult] = await Promise.all([
					metaFetch(`${adAccountId}/campaigns`, params),
					metaFetch(`${adAccountId}/adsets`, {
						...params,
						fields:
							"id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,budget_remaining",
					}),
				]);

				return toolResult({
					currency: "AUD",
					campaigns: (campaignResult.data ?? []).map((item: any) =>
						safeMetaBudgetObject(item, "campaign"),
					),
					adsets: (adsetResult.data ?? []).map((item: any) =>
						safeMetaBudgetObject(item, "adset"),
					),
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"update_meta_daily_budget",
		{
			description:
				"Update only the daily budget of one Meta campaign or ad set after explicit confirmation. Increases are limited to 25% and A$500/day.",
			inputSchema: z.object({
				object_type: z.enum(["campaign", "adset"]),
				object_id: z.string().regex(/^\d+$/),
				new_daily_budget_aud: z.number().positive().max(500),
				confirmation: z.literal("CONFIRM META BUDGET UPDATE"),
			}),
		},
		async ({ object_type, object_id, new_daily_budget_aud }) => {
			try {
				const { adAccountId } = getMetaConfig();
				const configuredAccountId = adAccountId.replace(/^act_/, "");
				const current = await metaFetch(object_id, {
					fields:
						object_type === "adset"
							? "id,name,account_id,campaign_id,status,effective_status,daily_budget,lifetime_budget"
							: "id,name,account_id,status,effective_status,daily_budget,lifetime_budget",
				});

				if (String(current.account_id) !== configuredAccountId) {
					throw new Error("Refusing update: object does not belong to the configured Meta ad account.");
				}

				const currentBudget = metaBudgetAmount(current.daily_budget);
				if (currentBudget === null || currentBudget <= 0) {
					throw new Error(
						`Refusing update: ${object_type} does not have a daily budget at this level. Inspect its parent campaign or ad sets.`,
					);
				}

				const roundedBudget = Number(new_daily_budget_aud.toFixed(2));
				if (roundedBudget > currentBudget * 1.25) {
					throw new Error(
						`Refusing update: increases are capped at 25% per change. Current budget is A$${currentBudget.toFixed(2)}.`,
					);
				}

				await metaPost(object_id, { daily_budget: Math.round(roundedBudget * 100) });
				const verified = await metaFetch(object_id, {
					fields: "id,name,account_id,status,effective_status,daily_budget,lifetime_budget",
				});

				return toolResult({
					updated: true,
					object_type,
					object_id,
					name: verified.name,
					currency: "AUD",
					previous_daily_budget: currentBudget,
					requested_daily_budget: roundedBudget,
					verified_daily_budget: metaBudgetAmount(verified.daily_budget),
					unchanged_fields: ["targeting", "creative", "status", "optimisation", "bid_strategy"],
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	/* Read-only Google Analytics 4 reporting tools */

	server.registerTool(
		"get_ga4_property",
		{
			description:
				"Confirm access to the configured Blindmotion GA4 property and return a small non-sensitive activity check.",
			inputSchema: z.object({}),
		},
		async () => {
			try {
				const { propertyId, serviceAccount } = getGa4Config();
				const report = await ga4RunReport({
					dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }],
					metrics: [{ name: "sessions" }, { name: "activeUsers" }],
				});
				return toolResult({
					property_id: propertyId,
					service_account: serviceAccount.client_email,
					access_confirmed: true,
					activity_check: ga4ReportResult(report, "7daysAgo", "yesterday"),
				});
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_ga4_summary",
		{
			description:
				"Summarise Blindmotion GA4 users, sessions, engagement, ecommerce purchases and reported revenue for a date range.",
			inputSchema: z.object({ start_date: z.string(), end_date: z.string() }),
		},
		async ({ start_date, end_date }) => {
			try {
				const report = await ga4RunReport({
					dateRanges: [{ startDate: start_date, endDate: end_date }],
					metrics: [
						{ name: "totalUsers" },
						{ name: "newUsers" },
						{ name: "activeUsers" },
						{ name: "sessions" },
						{ name: "engagedSessions" },
						{ name: "engagementRate" },
						{ name: "screenPageViews" },
						{ name: "keyEvents" },
						{ name: "ecommercePurchases" },
						{ name: "purchaseRevenue" },
					],
				});
				return toolResult(ga4ReportResult(report, start_date, end_date));
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_ga4_daily_performance",
		{
			description:
				"Return daily Blindmotion GA4 traffic, engagement, ecommerce purchases and revenue for a date range.",
			inputSchema: z.object({ start_date: z.string(), end_date: z.string() }),
		},
		async ({ start_date, end_date }) => {
			try {
				const report = await ga4RunReport({
					dateRanges: [{ startDate: start_date, endDate: end_date }],
					dimensions: [{ name: "date" }],
					metrics: [
						{ name: "activeUsers" },
						{ name: "sessions" },
						{ name: "engagedSessions" },
						{ name: "screenPageViews" },
						{ name: "keyEvents" },
						{ name: "ecommercePurchases" },
						{ name: "purchaseRevenue" },
					],
					limit: "10000",
					orderBys: [{ dimension: { dimensionName: "date" } }],
				});
				return toolResult(ga4ReportResult(report, start_date, end_date));
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_ga4_traffic_acquisition",
		{
			description:
				"Return Blindmotion GA4 session acquisition performance by channel and source/medium for a date range.",
			inputSchema: z.object({
				start_date: z.string(),
				end_date: z.string(),
				limit: z.number().int().min(1).max(250).default(100),
			}),
		},
		async ({ start_date, end_date, limit }) => {
			try {
				const report = await ga4RunReport({
					dateRanges: [{ startDate: start_date, endDate: end_date }],
					dimensions: [
						{ name: "sessionDefaultChannelGroup" },
						{ name: "sessionSourceMedium" },
					],
					metrics: [
						{ name: "sessions" },
						{ name: "activeUsers" },
						{ name: "engagedSessions" },
						{ name: "engagementRate" },
						{ name: "keyEvents" },
						{ name: "ecommercePurchases" },
						{ name: "purchaseRevenue" },
					],
					limit: String(limit),
					orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
				});
				return toolResult(ga4ReportResult(report, start_date, end_date));
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_ga4_landing_pages",
		{
			description:
				"Return Blindmotion GA4 landing-page traffic, engagement, ecommerce purchases and revenue for a date range.",
			inputSchema: z.object({
				start_date: z.string(),
				end_date: z.string(),
				limit: z.number().int().min(1).max(250).default(100),
			}),
		},
		async ({ start_date, end_date, limit }) => {
			try {
				const report = await ga4RunReport({
					dateRanges: [{ startDate: start_date, endDate: end_date }],
					dimensions: [{ name: "landingPagePlusQueryString" }],
					metrics: [
						{ name: "sessions" },
						{ name: "activeUsers" },
						{ name: "engagedSessions" },
						{ name: "engagementRate" },
						{ name: "keyEvents" },
						{ name: "ecommercePurchases" },
						{ name: "purchaseRevenue" },
					],
					limit: String(limit),
					orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
				});
				return toolResult(ga4ReportResult(report, start_date, end_date));
			} catch (error) {
				return toolError(error);
			}
		},
	);

	server.registerTool(
		"get_ga4_ecommerce_performance",
		{
			description:
				"Return Blindmotion GA4 ecommerce item views, cart additions, purchases and item revenue for a date range.",
			inputSchema: z.object({
				start_date: z.string(),
				end_date: z.string(),
				limit: z.number().int().min(1).max(250).default(100),
			}),
		},
		async ({ start_date, end_date, limit }) => {
			try {
				const report = await ga4RunReport({
					dateRanges: [{ startDate: start_date, endDate: end_date }],
					dimensions: [{ name: "itemId" }, { name: "itemName" }],
					metrics: [
						{ name: "itemsViewed" },
						{ name: "itemsAddedToCart" },
						{ name: "itemsPurchased" },
						{ name: "itemRevenue" },
					],
					limit: String(limit),
					orderBys: [{ metric: { metricName: "itemRevenue" }, desc: true }],
				});
				return toolResult(ga4ReportResult(report, start_date, end_date));
			} catch (error) {
				return toolError(error);
			}
		},
	);

	return server;
}

const handler = createMcpHandler(createServer);

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return handler(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
