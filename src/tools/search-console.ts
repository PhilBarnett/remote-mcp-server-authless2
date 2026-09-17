import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { toolError, toolResult } from "../tooling/results";

export type SearchConsoleDimension = "date" | "page" | "query";

export type SearchConsoleQueryRequest = {
	startDate: string;
	endDate: string;
	dimensions?: SearchConsoleDimension[];
	rowLimit?: number;
	startRow?: number;
	type?: "web";
	aggregationType?: "auto";
	dimensionFilterGroups?: Array<{
		groupType: "and";
		filters: Array<{
			dimension: "page" | "query";
			operator: "contains";
			expression: string;
		}>;
	}>;
};

type SearchConsoleDependencies = {
	query(request: SearchConsoleQueryRequest): Promise<any>;
	siteUrl: string;
};

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO date in YYYY-MM-DD format.");
const filterSchema = z.string().trim().min(1).max(500).optional();
const limitSchema = z.number().int().min(1).max(1000).default(250);
const reportTypeSchema = z.enum(["queries", "pages", "query_pages", "daily"]);

function filters(queryFilter?: string, pageFilter?: string) {
	const values: Array<{
		dimension: "page" | "query";
		operator: "contains";
		expression: string;
	}> = [];
	if (queryFilter)
		values.push({ dimension: "query", operator: "contains", expression: queryFilter });
	if (pageFilter)
		values.push({ dimension: "page", operator: "contains", expression: pageFilter });
	return values.length ? [{ groupType: "and" as const, filters: values }] : undefined;
}

function reportResult(
	report: any,
	startDate: string,
	endDate: string,
	dimensions: SearchConsoleDimension[],
	siteUrl: string,
) {
	const rows = (report.rows ?? []).map((row: any) => ({
		...Object.fromEntries(
			dimensions.map((dimension, index) => [dimension, row.keys?.[index] ?? ""]),
		),
		clicks: Number(row.clicks ?? 0),
		impressions: Number(row.impressions ?? 0),
		ctr: Number(row.ctr ?? 0),
		position: Number(row.position ?? 0),
	}));

	return {
		site_url: siteUrl,
		start_date: startDate,
		end_date: endDate,
		search_type: "web",
		row_count: rows.length,
		rows,
		response_aggregation_type: report.responseAggregationType,
		metadata: report.metadata,
	};
}

export function registerSearchConsoleTools(
	server: McpServer,
	dependencies: SearchConsoleDependencies,
) {
	server.registerTool(
		"get_search_console_report",
		{
			description:
				"Return Blindmotion Google Search Console performance using one parameter-driven report. Supports query, page, query+page and daily dimensions while preserving the existing filters, limits and metrics.",
			inputSchema: z.object({
				report_type: reportTypeSchema,
				start_date: dateSchema,
				end_date: dateSchema,
				limit: limitSchema,
				query_filter: filterSchema,
				page_filter: filterSchema,
			}),
		},
		async ({ report_type, start_date, end_date, limit, query_filter, page_filter }) => {
			try {
				if (start_date > end_date) {
					throw new Error("start_date must be on or before end_date.");
				}
				if (report_type === "queries" && page_filter) {
					throw new Error(
						"page_filter is only supported for pages or query_pages reports.",
					);
				}
				if (report_type === "pages" && query_filter) {
					throw new Error(
						"query_filter is only supported for queries or query_pages reports.",
					);
				}
				if (report_type === "daily" && (query_filter || page_filter)) {
					throw new Error(
						"Daily Search Console reports do not accept query or page filters.",
					);
				}

				const dimensions: SearchConsoleDimension[] =
					report_type === "queries"
						? ["query"]
						: report_type === "pages"
							? ["page"]
							: report_type === "query_pages"
								? ["query", "page"]
								: ["date"];

				const report = await dependencies.query({
					startDate: start_date,
					endDate: end_date,
					dimensions,
					rowLimit: report_type === "daily" ? 5000 : limit,
					...(report_type === "daily"
						? {}
						: { dimensionFilterGroups: filters(query_filter, page_filter) }),
				});
				const result = reportResult(
					report,
					start_date,
					end_date,
					dimensions,
					dependencies.siteUrl,
				);
				if (report_type === "daily") {
					result.rows.sort((left: any, right: any) =>
						left.date.localeCompare(right.date),
					);
				}
				return toolResult(result);
			} catch (error) {
				return toolError(error);
			}
		},
	);
}
