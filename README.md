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
