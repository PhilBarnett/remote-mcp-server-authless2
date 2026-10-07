import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const content = z
	.object({
		description: z.string().max(50000).optional(),
		short_description: z.string().max(50000).optional(),
	})
	.strict()
	.refine((x) => Object.keys(x).length > 0);
const product = { product_id: z.number().int().positive() };
const edit = { ...product, expected_sha256: digest, changes: content };
export const stagingWorkSchemas = [
	z
		.object({
			action: z.literal("read_source"),
			plugin_slug: z.enum([
				"blindmotion-plugin-deployment-bridge",
				"blindmotion-measurement-guarantee",
				"blindmotion-motor-selection-guide",
				"blindmotion-product-promotion-bridge",
				"blindmotion-wapf-pricing-bridge",
				"blindmotion-cro-suite",
				"blindmotion-visualizer",
			]),
			relative_path: z.string().min(1).max(200),
		})
		.strict(),
	z
		.object({
			action: z.literal("inspect_routing"),
			order_ids: z.array(z.number().int().positive()).max(20),
		})
		.strict(),
	z.object({ action: z.literal("inspect_content"), ...product }).strict(),
	z.object({ action: z.literal("preview_content"), ...edit }).strict(),
	z
		.object({
			action: z.literal("apply_content"),
			...edit,
			plan_sha256: digest,
			confirmation: z.literal("CONFIRM APPLY STAGING PRODUCT CONTENT"),
		})
		.strict(),
] as const;
export const stagingWorkSchema = z.discriminatedUnion("action", stagingWorkSchemas);
export async function runStagingWork(
	request: (body: unknown) => Promise<any>,
	input: unknown,
	write: boolean,
) {
	try {
		const result = await request(input);
		if (
			result.environment !== "staging" ||
			result.host !== "staging-online.blindmotion.com.au" ||
			result.write_performed !== write
		)
			throw new Error("Staging response identity or write-state mismatch.");
		if (write && (result.verified !== true || result.rollback_protected !== true))
			throw new Error("Staging content verification missing.");
		return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
	} catch (error) {
		return {
			isError: true,
			content: [
				{
					type: "text" as const,
					text: error instanceof Error ? error.message : "Staging operation failed",
				},
			],
		};
	}
}
