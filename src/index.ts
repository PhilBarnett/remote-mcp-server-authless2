import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

function createServer() {
	const server = new McpServer({
		name: "Authless Calculator",
		version: "1.0.0",
	});

	server.registerTool(
		"add",
		{ inputSchema: z.object({ a: z.number(), b: z.number() }) },
		async ({ a, b }) => ({
			content: [{ type: "text", text: String(a + b) }],
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
					if (b === 0)
						return {
							content: [
								{
									type: "text",
									text: "Error: Cannot divide by zero",
								},
							],
						};
					result = a / b;
					break;
			}
			return { content: [{ type: "text", text: String(result) }] };
		},
	);
	server.registerTool(
		"get_recent_orders",
		{
			description: "Return the most recent Blindmotion WooCommerce orders",
			inputSchema: z.object({
				limit: z.number().int().min(1).max(20).default(5),
			}),
		},
		async ({ limit }) => {
			const auth = btoa(
				`${env.WP_USERNAME}:${env.WP_APP_PASSWORD}`
			);

			const response = await fetch(
				`${env.WC_SITE}/wp-json/wc/v3/orders?per_page=${limit}&orderby=date&order=desc`,
				{
					headers: {
						Authorization: `Basic ${auth}`,
						Accept: "application/json",
					},
				},
			);

			if (!response.ok) {
				const body = await response.text();

				return {
					content: [
						{
							type: "text",
							text: `WooCommerce request failed: ${response.status} ${body}`,
						},
					],
				};
			}

			const orders = await response.json<any[]>();

			const safeOrders = orders.map((order) => ({
				id: order.id,
				date_created: order.date_created,
				status: order.status,
				currency: order.currency,
				total: order.total,
				discount_total: order.discount_total,
				shipping_total: order.shipping_total,
				line_items: order.line_items?.map((item: any) => ({
					product_id: item.product_id,
					name: item.name,
					quantity: item.quantity,
					total: item.total,
				})),
			}));

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(safeOrders, null, 2),
					},
				],
			};
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
