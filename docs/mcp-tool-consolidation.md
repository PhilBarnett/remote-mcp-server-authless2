# Blindmotion MCP tool consolidation

## Baseline

The current `src/index.ts` exposes **186** `server.registerTool(...)` registrations.

This is a tool-surface problem, not simply a source-file-size problem. The objective is to reduce the number of top-level tools presented to MCP clients while preserving the existing domain logic, validation, confirmation phrases, preview hashes, rollback behaviour and read/write separation.

## Principles

1. **Parameterise repeated read tools first.** Read-only reporting families are the lowest-risk consolidation targets.
2. **Preserve guarded writes.** Consolidating tool names must not weaken exact confirmation phrases, identity checks, expected hashes, paused/draft-state requirements, preflights or rollback behaviour.
3. **Prefer domain-level tools over operation-level tools.** Use an enum such as `report`, `action` or `asset_type` rather than another top-level MCP tool whenever operations share the same backend and safety boundary.
4. **Do not hard-code new product-specific families.** Existing generic/product-level implementations should absorb legacy product-specific variants where their safety guarantees are equivalent.
5. **Make every consolidation measurable.** `npm run audit:mcp-tools` is the before/after check for each PR.
6. **Keep migrations small.** One domain family per PR where practical, with type-check/lint validation before merge.

## First consolidation sequence

### 1. Search Console reporting — first code migration

Current surface includes separate tools for query, page, query+page and daily reports. Replace them with one read-only `get_search_console_report` tool using a `report_type` enum and the existing optional query/page filters.

Expected reduction: **4 tools -> 1 tool** (net -3).

This is the first target because all variants already call the same Search Console query and result helpers and do not perform writes.

### 2. GA4 reporting

Collapse the existing GA4 summary, daily, traffic-acquisition, event, landing-page and ecommerce report tools behind one parameter-driven read-only reporting tool. Keep report-specific validation in internal handlers rather than widening arbitrary GA4 API access.

Expected reduction for the currently visible core family: **6 tools -> 1 tool** (net -5), subject to final inventory validation.

### 3. Google Ads asset operations

Consolidate text/image/YouTube asset-linking tools by campaign/product workflow where the same safety boundary is already enforced. Prefer an `asset_type` / `operation` enum and retain `validateOnly` preflight, campaign/asset-group identity checks and paused-state guards.

A separate follow-up should compare older ZipGrip-specific tools with the newer reusable product-level PMax workflow and retire duplicated product-specific exposure only where the generic implementation provides equal or stronger validation.

### 4. WAPF / WooCommerce guarded operations

Group preview/apply families only after the read-only consolidations are proven. Preview and write modes may share one top-level domain tool, but write requests must continue to require the exact preview hash and confirmation phrase. No generic arbitrary WooCommerce write endpoint should be exposed.

### 5. Meta Ads

Consolidate read/report tools independently from guarded mutation tools. Mutations such as campaign pausing should remain tightly scoped and explicit even if they share a parameterised action tool.

## Source modularisation

Tool-count consolidation and source modularisation are related but separate goals. `src/index.ts` is now large enough that domain registration modules will improve maintainability, but moving code between files does not itself reduce the MCP tool surface. Do not combine a broad file split with behavioural tool migrations in the same PR unless required.

A later structural pass should move domain registration into modules such as:

- `src/tools/search-console.ts`
- `src/tools/ga4.ts`
- `src/tools/google-ads.ts`
- `src/tools/meta-ads.ts`
- `src/tools/woocommerce.ts`
- `src/tools/wapf.ts`

## Definition of done for each consolidation PR

- Lower exposed tool count reported by `npm run audit:mcp-tools`.
- No expansion of write authority.
- Existing guard conditions preserved or strengthened.
- Type-check and lint pass.
- Read results remain semantically equivalent for the supported report/action modes.
- Obsolete tool registrations are removed rather than kept indefinitely as aliases, otherwise the MCP surface count does not improve.
