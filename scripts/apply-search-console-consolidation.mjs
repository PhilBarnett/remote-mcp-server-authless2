import fs from "node:fs";

const path = "src/index.ts";
const source = fs.readFileSync(path, "utf8");

const startMarker = "\t/* Read-only Google Search Console reporting tools */";
const endMarker = "\t/* Read-only Google Analytics 4 reporting tools */";
const oldTools = [
  "get_search_console_queries",
  "get_search_console_pages",
  "get_search_console_query_pages",
  "get_search_console_daily_performance",
];
const newTool = "get_search_console_report";

const oldCounts = Object.fromEntries(
  oldTools.map((name) => [name, source.split(`\"${name}\"`).length - 1]),
);
const newCount = source.split(`\"${newTool}\"`).length - 1;

if (oldTools.every((name) => oldCounts[name] === 0) && newCount === 1) {
  console.log("Search Console tools are already consolidated.");
  process.exit(0);
}

for (const name of oldTools) {
  if (oldCounts[name] !== 1) {
    throw new Error(`Expected exactly one ${name} registration before consolidation; found ${oldCounts[name]}.`);
  }
}
if (newCount !== 0) {
  throw new Error(`Expected no existing ${newTool} registration before consolidation; found ${newCount}.`);
}

const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker);
if (start < 0 || end < 0 || end <= start) {
  throw new Error("Could not locate the exact Search Console tool block markers.");
}

const replacement = `\t/* Read-only Google Search Console reporting tool */

\tconst searchConsoleDateSchema = z
\t\t.string()
\t\t.regex(/^\\d{4}-\\d{2}-\\d{2}$/, "Use an ISO date in YYYY-MM-DD format.");
\tconst searchConsoleFilterSchema = z.string().trim().min(1).max(500).optional();
\tconst searchConsoleLimitSchema = z.number().int().min(1).max(1000).default(250);
\tconst searchConsoleReportTypeSchema = z.enum([
\t\t"queries",
\t\t"pages",
\t\t"query_pages",
\t\t"daily",
\t]);

\tserver.registerTool(
\t\t"get_search_console_report",
\t\t{
\t\t\tdescription:
\t\t\t\t"Return Blindmotion Google Search Console performance using one parameter-driven report. Supports query, page, query+page and daily dimensions while preserving the existing filters, limits and metrics.",
\t\t\tinputSchema: z.object({
\t\t\t\treport_type: searchConsoleReportTypeSchema,
\t\t\t\tstart_date: searchConsoleDateSchema,
\t\t\t\tend_date: searchConsoleDateSchema,
\t\t\t\tlimit: searchConsoleLimitSchema,
\t\t\t\tquery_filter: searchConsoleFilterSchema,
\t\t\t\tpage_filter: searchConsoleFilterSchema,
\t\t\t}),
\t\t},
\t\tasync ({ report_type, start_date, end_date, limit, query_filter, page_filter }) => {
\t\t\ttry {
\t\t\t\tassertSearchConsoleDateRange(start_date, end_date);

\t\t\t\tif (report_type === "queries" && page_filter) {
\t\t\t\t\tthrow new Error("page_filter is only supported for pages or query_pages reports.");
\t\t\t\t}
\t\t\t\tif (report_type === "pages" && query_filter) {
\t\t\t\t\tthrow new Error("query_filter is only supported for queries or query_pages reports.");
\t\t\t\t}
\t\t\t\tif (report_type === "daily" && (query_filter || page_filter)) {
\t\t\t\t\tthrow new Error("Daily Search Console reports do not accept query or page filters.");
\t\t\t\t}

\t\t\t\tconst dimensions: SearchConsoleDimension[] =
\t\t\t\t\treport_type === "queries"
\t\t\t\t\t\t? ["query"]
\t\t\t\t\t\t: report_type === "pages"
\t\t\t\t\t\t\t? ["page"]
\t\t\t\t\t\t\t: report_type === "query_pages"
\t\t\t\t\t\t\t\t? ["query", "page"]
\t\t\t\t\t\t\t\t: ["date"];

\t\t\t\tconst report = await searchConsoleQuery({
\t\t\t\t\tstartDate: start_date,
\t\t\t\t\tendDate: end_date,
\t\t\t\t\tdimensions,
\t\t\t\t\trowLimit: report_type === "daily" ? 5000 : limit,
\t\t\t\t\t...(report_type === "daily"
\t\t\t\t\t\t? {}
\t\t\t\t\t\t: { dimensionFilterGroups: searchConsoleFilters(query_filter, page_filter) }),
\t\t\t\t});
\t\t\t\tconst result = searchConsoleReportResult(report, start_date, end_date, dimensions);
\t\t\t\tif (report_type === "daily") {
\t\t\t\t\tresult.rows.sort((left: any, right: any) => left.date.localeCompare(right.date));
\t\t\t\t}
\t\t\t\treturn toolResult(result);
\t\t\t} catch (error) {
\t\t\t\treturn toolError(error);
\t\t\t}
\t\t},
\t);

`;

const updated = source.slice(0, start) + replacement + source.slice(end);
const registerToolCountBefore = (source.match(/server\\.registerTool\\(/g) ?? []).length;
const registerToolCountAfter = (updated.match(/server\\.registerTool\\(/g) ?? []).length;
if (registerToolCountAfter !== registerToolCountBefore - 3) {
  throw new Error(
    `Expected tool count to fall by exactly 3; before=${registerToolCountBefore}, after=${registerToolCountAfter}.`,
  );
}
for (const name of oldTools) {
  if (updated.includes(`\"${name}\"`)) {
    throw new Error(`Legacy Search Console tool ${name} remains after consolidation.`);
  }
}
if ((updated.split(`\"${newTool}\"`).length - 1) !== 1) {
  throw new Error(`Expected exactly one ${newTool} registration after consolidation.`);
}

fs.writeFileSync(path, updated);
console.log(`Search Console consolidated: ${registerToolCountBefore} -> ${registerToolCountAfter} registered tools.`);
