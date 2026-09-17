import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const DEFAULT_MAX_TOOLS = 95;
const maxArgumentIndex = process.argv.indexOf("--max");
const maxTools =
	maxArgumentIndex === -1 ? DEFAULT_MAX_TOOLS : Number(process.argv[maxArgumentIndex + 1]);

if (!Number.isInteger(maxTools) || maxTools < 1) {
	throw new Error("--max must be followed by a positive integer.");
}

async function walk(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await walk(path)));
		else if ([".ts", ".tsx", ".js", ".mjs"].includes(extname(entry.name))) files.push(path);
	}
	return files;
}

function domainFor(name) {
	const rules = [
		[/search_console/i, "search-console"],
		[/\bga4\b|^get_ga4_/i, "ga4"],
		[/google_ads|pmax|zipgrip.*asset/i, "google-ads"],
		[/meta_|facebook/i, "meta-ads"],
		[/omnisend/i, "omnisend"],
		[/woocommerce|woo_|wc_|product|order/i, "woocommerce"],
		[/wapf/i, "wapf"],
		[/wordpress|wp_|elementor|media/i, "wordpress"],
		[/github|pull_request|\bpr\b/i, "github"],
	];
	for (const [pattern, domain] of rules) if (pattern.test(name)) return domain;
	return "other";
}

function consolidationStem(name) {
	return name
		.replace(
			/^(get|list|inspect|preview|apply|create|update|delete|copy|clone|link|activate|pause|import|install|replace|repair|set)_/i,
			"",
		)
		.replace(/_(guarded|readonly|read_only|preview)$/i, "")
		.replace(/_(queries|pages|query_pages|daily_performance|summary|performance)$/i, "")
		.replace(/_(text|image|youtube)_assets?$/i, "_assets")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "");
}

const files = await walk(SRC);
const tools = [];
const registerToolPattern = /\bregisterTool\s*\(\s*["'`]([^"'`]+)["'`]/g;

for (const file of files) {
	const source = await readFile(file, "utf8");
	for (const match of source.matchAll(registerToolPattern)) {
		const before = source.slice(0, match.index);
		const line = before.split("\n").length;
		tools.push({
			name: match[1],
			file: relative(ROOT, file),
			line,
			domain: domainFor(match[1]),
			stem: consolidationStem(match[1]),
		});
	}
}

tools.sort((a, b) => a.name.localeCompare(b.name));

const byDomain = new Map();
for (const tool of tools) {
	const values = byDomain.get(tool.domain) ?? [];
	values.push(tool);
	byDomain.set(tool.domain, values);
}

const byStem = new Map();
for (const tool of tools) {
	const values = byStem.get(tool.stem) ?? [];
	values.push(tool);
	byStem.set(tool.stem, values);
}

const candidates = [...byStem.entries()]
	.filter(([, values]) => values.length > 1)
	.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

console.log(`# MCP tool surface audit`);
console.log(`\nTotal exposed tools: ${tools.length}`);
console.log(`Maximum allowed tools: ${maxTools}`);
console.log(`Source files scanned: ${files.length}`);
console.log("\n## Tools by domain");
for (const [domain, values] of [...byDomain.entries()].sort(
	(a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
)) {
	console.log(`- ${domain}: ${values.length}`);
}

console.log("\n## Likely consolidation candidates");
if (!candidates.length) console.log("- None detected automatically.");
for (const [stem, values] of candidates) {
	console.log(`- ${stem} (${values.length}): ${values.map((value) => value.name).join(", ")}`);
}

console.log("\n## Full exposed tool inventory");
for (const tool of tools)
	console.log(`- ${tool.name} — ${tool.file}:${tool.line} [${tool.domain}]`);

const duplicateNames = [...new Set(tools.map((tool) => tool.name))].filter(
	(name) => tools.filter((tool) => tool.name === name).length > 1,
);
if (duplicateNames.length) {
	console.error(`\nDuplicate tool names: ${duplicateNames.join(", ")}`);
	process.exitCode = 1;
}
if (tools.length > maxTools) {
	console.error(`\nTool ceiling exceeded: ${tools.length} registered, maximum ${maxTools}.`);
	process.exitCode = 1;
}
