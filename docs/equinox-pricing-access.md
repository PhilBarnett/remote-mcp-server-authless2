# Equinox pricing inspection

`manage_equinox` pricing actions uses only the fixed Equinox origin and its separate credentials. It never uses Blindmotion as fallback.

Deployment requires the existing authenticated `blindmotion-wapf-pricing-bridge` WordPress plugin on **Equinox**. Its source is maintained in `PhilBarnett/blindmotion-wordpress-plugins`. Do not assume deploying the Worker installs the plugin. The current Equinox REST inventory does not advertise its routes.

After installing/activating the reviewed plugin release and deploying the Worker:

1. Call with `site: equinox, action: pricing_storage` to inspect storage names/shapes/hashes and discover ACF pricing group identity without raw option values.
2. Call with `action: pricing_details, lookup_names: [alphastraightdrop50pcgm]` to retrieve the exact table, including stored configuration. Add named fabric/headbox tables as needed (maximum ten).
3. Supply `acf_field_group_id` and `expected_acf_field_group_title` together for pricing options. Both must match the returned group.

No table mutation is provided. The two inspection routes refuse non-GET methods even through `manage_equinox`. Arbitrary bridge routes remain excluded. Compare returned table data with costing sources before implementing discounts. Missing bridge or unsupported selections fail explicitly.

Validation: `node scripts/test-equinox-pricing.mjs`, `npm run type-check`, and `npm run test:mcp-auth`.
