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
	"cost_per_action_type",
].join(",");

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
				"Summarise Blindmotion Meta Ads spend, reach, clicks and reported conversion actions for a date range.",
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
				return toolResult({ start_date, end_date, data: result.data ?? [] });
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
					return toolResult({ start_date, end_date, level, data: result.data ?? [] });
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
		"Return read-only Meta Ads campaign performance for a date range.",
	);
	registerMetaPerformanceTool(
		"get_meta_adset_performance",
		"adset",
		"campaign_id,campaign_name,adset_id,adset_name,objective",
		"Return read-only Meta Ads ad-set performance for a date range.",
	);
	registerMetaPerformanceTool(
		"get_meta_ad_performance",
		"ad",
		"campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,objective",
		"Return read-only Meta Ads ad performance for a date range.",
	);

	server.registerTool(
		"get_meta_daily_performance",
		{
			description: "Return daily Blindmotion Meta Ads account performance for a date range.",
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
				return toolResult({ start_date, end_date, data: result.data ?? [] });
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
