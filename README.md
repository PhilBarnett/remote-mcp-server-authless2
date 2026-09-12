# Building a Remote MCP Server on Cloudflare (Without Auth)

This example allows you to deploy a stateless remote MCP server that doesn't require authentication on Cloudflare Workers. It implements the MCP 2026-07-28 specification while remaining compatible with legacy clients for ordinary tool calls.

## Get started:

[![Deploy to Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-authless)

This will deploy your MCP server to a URL like: `remote-mcp-server-authless.<your-account>.workers.dev/mcp`

Alternatively, you can use the command line below to get the remote MCP Server created on your local machine:

```bash
npm create cloudflare@latest -- my-mcp-server --template=cloudflare/ai/demos/remote-mcp-authless
```

## Customizing your MCP Server

To add your own [tools](https://developers.cloudflare.com/agents/model-context-protocol/protocol/tools/) to the MCP server, register each tool on the `McpServer` created in the `createServer()` function in `src/index.ts` using `server.registerTool(...)`.

## Reusable guarded product Performance Max builder

The reusable Google Ads workflow removes product-specific campaign code while
retaining paused-first safety. It remains fixed to Blindmotion customer
`6610097637`, Merchant Center `5320593492`, Australia and English.

- `preview_google_ads_product_pmax_paused` verifies the exact published
  WooCommerce product, derives its canonical product URL and `gla_<product ID>`
  Merchant Center item, rejects duplicate campaign names and runs the complete
  Google Ads request with `validateOnly: true`.
- `create_google_ads_product_pmax_paused` repeats those checks and creates one
  campaign, one asset group and a one-product listing partition, all PAUSED.
  Final URL expansion is disabled and the budget is limited to A$5–A$50/day.
- `inspect_google_ads_product_pmax_asset_group` revalidates the WooCommerce
  identity, campaign and asset-group IDs, canonical landing page, one-product
  listing tree, live assets and completeness.
- `bootstrap_google_ads_product_pmax_asset_group_guarded` accepts reviewed text,
  existing Google Ads assets or exact image URLs below Blindmotion's WordPress
  uploads directory. It validates image bytes, dimensions, ratios and size,
  then uses a `validateOnly` preflight before one atomic asset mutation.
- `link_google_ads_product_pmax_youtube_assets_guarded` safely adds reviewed
  YouTube assets to the same validated paused asset group.

The generic workflow derives campaign and asset-group names from a constrained
campaign label, requires exact confirmation phrases for every write, and has no
generic activation method. Launch remains a separate reviewed operation because
exclusive product removal from existing Shopping/PMax partition trees can alter
live campaign eligibility.

The original ZipGrip-specific tools remain temporarily available for backwards
compatibility and post-launch inspection of the existing ZipGrip campaign.

## Reusable guarded Fabric Sample setup

The Fabric Sample workflow uses the existing `clone_product_as_draft_guarded`
tool to make a draft, hidden copy of any exactly identified sample product. The
live sample product is never used as the write target.

- `preview_product_fabric_sample_setup` accepts source and destination product
  IDs/names plus the exact source fabric selector, destination product selector
  and destination multi-select colour template field IDs. It validates a
  one-to-one fabric-range/colour-field structure and returns source,
  destination and deterministic plan SHA-256 hashes without writing.
- `apply_product_fabric_sample_setup_guarded` requires those exact hashes and
  `CONFIRM APPLY FABRIC SAMPLE SETUP`. It appends one product choice, a
  remapped fabric selector and multi-select colour swatches only to the named
  draft/hidden destination. IDs and choice slugs are deterministically
  remapped, all copied pricing is disabled, unrelated product data is verified,
  and a failed write is rolled back to the exact original WAPF value.

No product IDs, product names, WAPF field IDs or fabric names are hardcoded in
the reusable setup tools. Publishing the completed sample product remains a
separate manual review decision.

## Guarded ZipGrip Performance Max builder

The server includes two narrowly scoped Google Ads tools for customer `6610097637`:

- `preview_google_ads_zipgrip_pmax_paused` checks for a duplicate campaign and sends the complete request to Google Ads with `validateOnly: true`.
- `create_google_ads_zipgrip_pmax_paused` requires the exact confirmation phrase `CONFIRM CREATE PAUSED ZIPGRIP PMAX`, repeats validation, and atomically creates a paused campaign skeleton restricted to Merchant Center item `gla_1301`.

The campaign name, account, Merchant Center account, AU feed label, product item, Australia/English targeting, landing page, and paused statuses are fixed. Daily budget is limited to A$5–A$50. Final URL expansion is opted out, all non-ZipGrip products are excluded, and no activation tool is provided.

## Google Search Console reporting

The server includes read-only Search Console tools for the fixed URL-prefix property
`https://online.blindmotion.com.au/`. They report organic-search queries, landing pages,
query/page pairs, and daily clicks, impressions, CTR, and average position.

Search Console reuses `GA4_SERVICE_ACCOUNT_JSON` and requests only the
`webmasters.readonly` OAuth scope. Enable the Google Search Console API in the
same Google Cloud project and add the service account email as a user of the
Blindmotion Search Console property before calling these tools.

## Outdoor SEO page inspection

`inspect_outdoor_seo_pages` is a read-only diagnostic locked to the Outdoor Blinds
landing page and the Straight Drop and Zip Sided outdoor-blind products. It compares
stored WordPress/WooCommerce content with the final rendered HTML, reports search
metadata and headings, inventories relevant Elementor/SEO-plugin metadata, and flags
known duplicated, placeholder, or incorrect indoor-product template text. It cannot
change WordPress content or metadata.

`inspect_outdoor_seo_elementor_templates` is locked to the six Elementor documents
rendered by those outdoor pages. It reports their identities, display conditions,
heading tags, responsive visibility and suspicious widget content without exposing a
write path.

`apply_outdoor_seo_fixes_guarded` applies one fixed cleanup after exact hashes, product
identities and Elementor source values match the reviewed state. It removes only two
sections already hidden on every device, replaces known placeholder content, updates
the three locked outdoor products and attempts rollback if a write fails.

## Repository-scoped GitHub App

The Worker can authenticate as GitHub App `4894554`, installation `160530258`, using
the encrypted `GITHUB_APP_PRIVATE_KEY` Cloudflare secret. Every installation token is
further restricted to repository ID `1359135665`
(`PhilBarnett/remote-mcp-server-authless2`) and expires automatically.

- `get_blindmotion_github_app_status` verifies the installation without exposing a
  credential or token.
- `get_blindmotion_mcp_source_file` reads only `src/index.ts` or `README.md` from
  the exact current `main` commit and returns the blob SHA needed for review-safe
  draft PR creation.
- `create_blindmotion_mcp_draft_pr_guarded` atomically creates a branch, commit and
  draft PR from an exact reviewed `main` SHA. It can replace only `src/index.ts`
  and/or `README.md`, checks each expected blob SHA, and cannot touch workflows,
  dependencies or `main`.
- `inspect_blindmotion_mcp_pull_request` reports PR state and changed files but cannot
  approve or merge.

No MCP tool can merge a PR or push directly to `main`. Production deployment remains
limited to the existing GitHub Actions workflow after an externally reviewed merge.

## Guarded TotalBlock featured image

`replace_totalblock_featured_image_guarded` is locked to draft product `9413`, verifies
the product identity and reviewed current featured attachment `6704`, uploads or reuses
one JPEG/PNG/WebP attachment, preserves the complete gallery and all other product
configuration, and records the prior featured attachment for rollback. It requires the
exact phrase `CONFIRM REPLACE TOTALBLOCK FEATURED IMAGE` and never deletes media.

`replace_totalblock_gallery_images_guarded` is locked to the reviewed five-image
TotalBlock state. It preserves featured attachment `9417`, replaces exactly the four
legacy outdoor gallery attachments with four distinct approved JPEG/PNG/WebP images,
records rollback data, verifies the complete product image order, and requires
`CONFIRM REPLACE TOTALBLOCK GALLERY IMAGES`.

## Reusable fabric collection media importer

The importer separates source-page extraction from WordPress writes and contains no
supplier, collection, colour or product IDs. Both tools accept all commercial
identities and the collection URL at runtime:

- `preview_fabric_collection_import` supports `linked_product_pages` for collection
  indexes whose full-size images live on individual fabric pages, and
  `sectioned_attribute_swatches` for a single page containing swatches grouped by
  headings such as opacity. It returns a deterministic manifest and SHA-256 without
  writing.
- `import_fabric_collection_media_guarded` rebuilds the live manifest and requires
  its exact reviewed hash plus `CONFIRM IMPORT FABRIC COLLECTION`. It creates a
  hierarchy in the site's existing attachment `media_folder` taxonomy, downloads
  only validated public HTTPS JPEG/PNG/WebP images, and assigns searchable title,
  alt text, caption and source information.

Attachment filenames include supplier, collection, optional variant and colour, so
same-named swatches in multiple opacities remain distinct. Preview results also expose
stable item keys derived at runtime. The guarded importer accepts optional include and
exclude key lists plus a batch offset and batch size; batches are capped at four items
so large collections can resume safely within Cloudflare Worker subrequest limits.

`inspect_fabric_collection_media_import` rebuilds the exact reviewed manifest and
reports selected swatches as present or missing without creating folders or media.
Existing attachment slugs are skipped, reruns are idempotent, private/local URLs and
unsafe redirects are rejected, and the importer has no media deletion or overwrite
path.

## Reusable guarded curtain configurator

`preview_curtain_product_configuration` builds a deterministic, non-writing plan for
replacing one draft product's placeholder WAPF fields with a manual-or-motorised
curtain configuration. Product identity, new name, dimensional limits,
configurations, fabric roles, collection names, swatch attachment IDs and filenames,
headings, stack directions, mounting, operation choices, motor brand, power, motor
position and controls are supplied at runtime. Curtain configuration and fabric
selection are placed first, followed by dimensions and hardware choices. Alpha or
other motor-specific fields appear only for caller-designated motorised operation
choices.

Curtain configuration, heading, mounting, stack direction and operation choices may
each supply verified WordPress attachment IDs and filenames. A complete imaged choice
set renders as WAPF image swatches; a set with no image inputs remains a text radio
group. Partial image sets are rejected. Every fabric and visual-choice attachment is
revalidated before the plan is returned.

A two-layer configuration may optionally specify `fixed_layer_headings` with
`front` and `rear` objects, each containing a fabric `role` and a
`heading_key` referencing a supplied heading option. The plan validates that
both roles occur exactly once in that configuration and each heading exists. For
such a configuration, the general Heading Style selector is hidden; a required,
single-choice Heading Arrangement records the explicit front/rear pair in the
order. Configurations without fixed headings keep the ordinary selectable
Heading Style. For example, a double curtain can specify a front sheer S-Fold
and rear blockout Knife Pleat without exposing an incompatible shared heading
choice. This is parameter-driven and does not hard-code a fabric, heading or
product ID.

`apply_curtain_product_configuration_guarded` rebuilds the same plan and requires the
exact original WAPF hash, plan hash and
`CONFIRM APPLY CURTAIN PRODUCT CONFIGURATION`. It replaces only the product name and
WAPF field group while forcing the product to remain draft and hidden. The slug,
descriptions, categories, images, unrelated metadata and base price are preserved.
The write is verified and the exact prior state is restored if verification fails;
the tool cannot publish a product.

The first configuration pass intentionally supports only explicit caller-supplied
fixed option adjustments. Dimension-based curtain, fabric, track, motor, freight and
installation formulas can be added after the customer-facing option logic is
reviewed without embedding supplier pricing or product IDs in the Worker.

## Product-option image swatches

The generic `upload_wapf_choice_visual_guarded` tool uploads one reviewed JPEG, PNG or WebP for an exact choice on a caller-supplied draft/hidden product. It checks the product name, WAPF hash, field ID, choice slug and supplied image SHA-256 before uploading; it does not change product options or delete media. Call it once per image and keep the returned WordPress attachment IDs and filenames.

The generic `apply_wapf_image_swatches_guarded` tool converts selected radio fields to image swatches using those existing attachments. It checks the exact product identity, WAPF metadata ID and prior hash, field and choice labels/slugs, attachment IDs and filenames. The only WAPF changes are the selected field types and their choices' image URLs/attachment IDs. Field IDs, choice slugs, labels, pricing expressions, conditional logic and unrelated product data remain unchanged. The product must stay draft/hidden. The write is verified and the previous WAPF field group is restored on verification failure. Both tools require `CONFIRM APPLY WAPF IMAGE SWATCHES` and cannot publish a product.

## Connect to Cloudflare AI Playground

You can connect to your MCP server from the Cloudflare AI Playground, which is a remote MCP client:

1. Go to https://playground.ai.cloudflare.com/
2. Enter your deployed MCP server URL (`remote-mcp-server-authless.<your-account>.workers.dev/mcp`)
3. You can now use your MCP tools directly from the playground!

## Connect Claude Desktop to your MCP server

You can also connect to your remote MCP server from local MCP clients, by using the [mcp-remote proxy](https://www.npmjs.com/package/mcp-remote).

To connect to your MCP server from Claude Desktop, follow [Anthropic's Quickstart](https://modelcontextprotocol.io/quickstart/user) and within Claude Desktop go to Settings > Developer > Edit Config.

Update with this configuration:

```json
{
	"mcpServers": {
		"calculator": {
			"command": "npx",
			"args": [
				"mcp-remote",
				"http://localhost:8787/mcp" // or remote-mcp-server-authless.your-account.workers.dev/mcp
			]
		}
	}
}
```

Restart Claude and you should see the tools become available.
