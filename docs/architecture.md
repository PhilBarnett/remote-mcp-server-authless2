# Blindmotion MCP architecture

The MCP remains one Cloudflare Worker and one connector. Internally, it is organised by domain so adding a tool does not make `src/index.ts` larger.

## Target structure

- `src/index.ts`: Worker entry point, server composition and transitional infrastructure only.
- `src/tools/<domain>.ts`: Tool schemas, validation and handlers for one business domain.
- `src/clients/<service>.ts`: Authenticated API clients with no MCP registration logic.
- `src/tooling/`: Shared result, guard and registration utilities.
- `scripts/audit-mcp-tools.mjs`: Manifest inventory, duplicate detection and the hard tool ceiling.

Each domain exports one registrar such as `registerSearchConsoleTools(server, dependencies)`. Dependencies are explicit and narrow, which keeps domain code testable without introducing a class hierarchy.

## Non-negotiable boundaries

1. Preview/read operations and confirmed write operations remain separate tools.
2. Existing confirmation strings, identity checks, hash locks, paused/draft restrictions, verification and rollback behaviour must not change during extraction.
3. A migration PR moves one domain at a time and must not change the exposed tool name, description or input schema.
4. `npm run type-check`, `npm run lint` and `npm run audit:mcp-tools` must pass before deployment.
5. CI rejects duplicate tool names and more than 95 exposed tools.

## Migration sequence

1. Establish the registrar pattern with the read-only Search Console domain.
2. Extract read-only analytics domains: GA4, then Google Ads reporting.
3. Extract guarded GitHub and WooCommerce domains while preserving their exact write boundaries.
4. Extract WAPF and Meta Ads in smaller capability groups because their rollback and activation guards are more coupled.
5. Move remaining authentication and HTTP code from `src/index.ts` into service clients.
6. Leave `src/index.ts` as a thin composition root that creates the server, wires clients and registers domains.

Large domains should be split by capability, not by arbitrary file length. A new Worker or connector is justified only by a real credential, security, ownership or deployment boundary.
