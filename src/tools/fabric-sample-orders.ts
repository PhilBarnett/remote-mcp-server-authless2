import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const FABRIC_SAMPLE_PRODUCT_ID = 128;
const FABRIC_SAMPLE_ORDER_CONFIRMATION = "CONFIRM CREATE FABRIC SAMPLE ORDER";
const REQUEST_META_KEY = "_blindmotion_mcp_sample_request_id";
const WAPF_META_KEY = "_wapf_meta";

type WooRequest = (
	path: string,
	params?: Record<string, string | number | undefined>,
) => Promise<Response>;

type WooCreate = (path: string, body: unknown) => Promise<Response>;

function result(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
	};
}

function errorResult(error: unknown) {
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

function parseFieldGroup(product: any) {
	const matches = (product?.meta_data ?? []).filter(
		(meta: any) => String(meta?.key) === "_wapf_fieldgroup",
	);
	if (matches.length !== 1) {
		throw new Error(
			`Fabric Sample product must contain exactly one WAPF field group; found ${matches.length}.`,
		);
	}
	const raw = matches[0]?.value;
	let group = raw;
	if (typeof raw === "string") {
		try {
			group = JSON.parse(raw);
		} catch {
			throw new Error("Fabric Sample WAPF field group is not valid JSON.");
		}
	}
	if (!group || !Array.isArray(group.fields)) {
		throw new Error("Fabric Sample WAPF field group is not readable.");
	}
	return group;
}

function fieldLabel(field: any) {
	return String(
		field?.label ?? field?.title ?? field?.name ?? field?.options?.label ?? "",
	).trim();
}

function choiceLabel(choice: any) {
	return String(choice?.label ?? choice?.name ?? "").trim();
}

function validateSelections(
	product: any,
	selections: Array<{ field_label: string; choice_labels: string[] }>,
) {
	const group = parseFieldGroup(product);
	for (const selection of selections) {
		const matchingFields = group.fields.filter(
			(field: any) => fieldLabel(field) === selection.field_label,
		);
		if (matchingFields.length !== 1) {
			throw new Error(
				`Selection field ${JSON.stringify(selection.field_label)} matched ${matchingFields.length} WAPF fields; expected exactly one.`,
			);
		}
		const choices = Array.isArray(matchingFields[0]?.options?.choices)
			? matchingFields[0].options.choices
			: [];
		for (const label of selection.choice_labels) {
			const matchCount = choices.filter(
				(choice: any) => choiceLabel(choice) === label,
			).length;
			if (matchCount !== 1) {
				throw new Error(
					`Choice ${JSON.stringify(label)} in ${JSON.stringify(selection.field_label)} matched ${matchCount} WAPF choices; expected exactly one.`,
				);
			}
		}
	}
}

function safeCreatedOrder(
	order: any,
	selections: Array<{ field_label: string; choice_labels: string[] }>,
) {
	return {
		order_id: Number(order?.id),
		status: String(order?.status ?? ""),
		total_aud: String(order?.total ?? ""),
		product_id: FABRIC_SAMPLE_PRODUCT_ID,
		product_name: String(order?.line_items?.[0]?.name ?? ""),
		selections,
		customer_pii_returned: false,
	};
}

export function registerFabricSampleOrderTool(
	server: McpServer,
	dependencies: { wcFetch: WooRequest; wcCreate: WooCreate },
) {
	const addressSchema = z.object({
		first_name: z.string().trim().min(1).max(80),
		last_name: z.string().trim().min(1).max(80),
		email: z.string().trim().email().max(254),
		phone: z
			.string()
			.trim()
			.regex(/^\+?[0-9 ()-]{8,24}$/),
		address_1: z.string().trim().min(1).max(120),
		address_2: z.string().trim().max(120).optional(),
		city: z.string().trim().min(1).max(80),
		state: z.enum(["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"]),
		postcode: z
			.string()
			.trim()
			.regex(/^\d{4}$/),
		country: z.literal("AU"),
	});
	const selectionSchema = z.object({
		field_label: z.string().trim().min(1).max(120),
		choice_labels: z.array(z.string().trim().min(1).max(120)).min(1).max(20),
	});

	server.registerTool(
		"inspect_fabric_sample_order_wapf_meta",
		{
			description: "Read only: compare WAPF line-item metadata for exactly one Fabric Sample order, excluding customer and address data.",
			inputSchema: z.object({ order_id: z.number().int().positive() }),
		},
		async ({ order_id }) => {
			try {
				const response = await dependencies.wcFetch(`orders/${order_id}`);
				if (!response.ok) throw new Error(`WooCommerce returned HTTP ${response.status}.`);
				const order = await response.json<any>();
				const lineItems = order?.line_items ?? [];
				if (lineItems.length !== 1 || Number(lineItems[0]?.product_id) !== FABRIC_SAMPLE_PRODUCT_ID) {
					throw new Error("Order must contain exactly one Fabric Sample line item.");
				}
				return result({
					order_id,
					status: order.status,
					wapf_meta: (lineItems[0].meta_data ?? [])
						.filter((meta: any) => String(meta?.key) === WAPF_META_KEY)
						.map((meta: any) => meta.value),
					visible_options: (lineItems[0].meta_data ?? [])
						.filter((meta: any) => !String(meta?.key ?? "").startsWith("_"))
						.map((meta: any) => ({ label: meta.key, value: meta.value })),
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	);

	server.registerTool(
		"create_fabric_sample_order_guarded",
		{
			description: `Create one zero-dollar guest Fabric Sample order in live Blindmotion WooCommerce after validating product 128, every requested WAPF field and choice, the Australian delivery address, and an idempotency key. Does not create an account or opt the customer into marketing. Returns no customer PII. Requires exact confirmation: ${FABRIC_SAMPLE_ORDER_CONFIRMATION}`,
			inputSchema: z.object({
				expected_product_name: z.literal("Fabric Sample"),
				request_id: z
					.string()
					.trim()
					.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{15,79}$/),
				customer: addressSchema,
				selections: z.array(selectionSchema).min(1).max(20),
				confirmation: z.literal(FABRIC_SAMPLE_ORDER_CONFIRMATION),
			}),
		},
		async ({ expected_product_name, request_id, customer, selections }) => {
			try {
				// WooCommerce REST line-item display meta does not create WAPF\u2019s hidden
				// _wapf_meta. iDempiere requires it to map selections. Fail before any
				// read or write until a parity-tested WAPF payload builder is installed.
				throw new Error("Fabric Sample API creation is temporarily disabled: the iDempiere importer requires validated _wapf_meta. No order was created.");
				const fieldLabels = selections.map((selection) => selection.field_label);
				if (new Set(fieldLabels).size !== fieldLabels.length) {
					throw new Error("Each WAPF field_label may appear only once per sample order.");
				}
				for (const selection of selections) {
					if (new Set(selection.choice_labels).size !== selection.choice_labels.length) {
						throw new Error(
							`Duplicate choices are not permitted in ${JSON.stringify(selection.field_label)}.`,
						);
					}
				}

				const [productResponse, priorOrdersResponse] = await Promise.all([
					dependencies.wcFetch(`products/${FABRIC_SAMPLE_PRODUCT_ID}`),
					dependencies.wcFetch("orders", {
						search: customer.email.toLowerCase(),
						per_page: 100,
						orderby: "date",
						order: "desc",
					}),
				]);
				const product = await productResponse.json<any>();
				const priorOrders = await priorOrdersResponse.json<any[]>();
				const duplicate = priorOrders.find((order) =>
					(order?.meta_data ?? []).some(
						(meta: any) =>
							String(meta?.key) === REQUEST_META_KEY &&
							String(meta?.value) === request_id,
					),
				);
				if (duplicate) {
					const duplicateOptions = (duplicate?.line_items?.[0]?.meta_data ?? [])
						.filter((meta: any) => !String(meta?.key ?? "").startsWith("_"))
						.map((meta: any) => ({
							field_label: String(meta?.display_key ?? meta?.key ?? "").trim(),
							choice_labels: String(meta?.display_value ?? meta?.value ?? "")
								.split(",")
								.map((value) => value.trim())
								.filter(Boolean),
						}));
					if (
						String(duplicate?.billing?.email ?? "").toLowerCase() !==
							customer.email.toLowerCase() ||
						Number(duplicate?.line_items?.[0]?.product_id) !== FABRIC_SAMPLE_PRODUCT_ID ||
						JSON.stringify(duplicateOptions) !== JSON.stringify(selections)
					) {
						throw new Error(
							"The request_id already belongs to a different sample order; use a new unique request_id.",
						);
					}
					return result({
						created: false,
						idempotent_replay: true,
						...safeCreatedOrder(duplicate, selections),
					});
				}

				if (
					Number(product?.id) !== FABRIC_SAMPLE_PRODUCT_ID ||
					product?.name !== expected_product_name ||
					product?.status !== "publish"
				) {
					throw new Error(
						"Live Fabric Sample product identity or published status did not match.",
					);
				}
				if (Number(product?.price ?? 0) !== 0) {
					throw new Error(
						"Refusing sample order creation because product 128 is not zero-priced.",
					);
				}
				validateSelections(product, selections);

				const address = {
					...customer,
					address_2: customer.address_2 ?? "",
					email: customer.email.toLowerCase(),
				};
				const createdResponse = await dependencies.wcCreate("orders", {
					status: "processing",
					set_paid: true,
					customer_id: 0,
					billing: address,
					shipping: {
						first_name: address.first_name,
						last_name: address.last_name,
						address_1: address.address_1,
						address_2: address.address_2,
						city: address.city,
						state: address.state,
						postcode: address.postcode,
						country: address.country,
					},
					line_items: [
						{
							product_id: FABRIC_SAMPLE_PRODUCT_ID,
							quantity: 1,
							subtotal: "0.00",
							total: "0.00",
							meta_data: selections.map((selection) => ({
								key: selection.field_label,
								value: selection.choice_labels.join(", "),
							})),
						},
					],
					shipping_lines: [
						{
							method_id: "free_shipping",
							method_title: "Free shipping for samples",
							total: "0.00",
						},
					],
					meta_data: [
						{ key: REQUEST_META_KEY, value: request_id },
						{ key: "_blindmotion_mcp_created", value: "fabric_sample_order_v1" },
					],
				});
				const created = await createdResponse.json<any>();
				const verificationResponse = await dependencies.wcFetch(`orders/${created.id}`);
				const verified = await verificationResponse.json<any>();
				const verifiedRequestId = (verified?.meta_data ?? []).find(
					(meta: any) => String(meta?.key) === REQUEST_META_KEY,
				)?.value;
				if (
					Number(verified?.id) !== Number(created?.id) ||
					Number(verified?.total) !== 0 ||
					verified?.line_items?.length !== 1 ||
					Number(verified.line_items[0]?.product_id) !== FABRIC_SAMPLE_PRODUCT_ID ||
					String(verifiedRequestId) !== request_id
				) {
					throw new Error(
						`Order ${created.id} was created but post-write verification failed; inspect it manually before retrying.`,
					);
				}

				return result({
					created: true,
					idempotent_replay: false,
					...safeCreatedOrder(verified, selections),
					account_created: false,
					marketing_opt_in_created: false,
					shipping_method: "Free shipping for samples",
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	);
}
