# Staging tracking diagnostic

Call `manage_staging_blindmotion_plugin_deployment` with `{ "action": "inspect_tracking" }` after BOTH bridge and Worker releases. No extra fields, arbitrary option names, paths, URLs, customer/order IDs or write actions are accepted.

The existing authenticated staging endpoint returns only three fixed plugin identities/versions/file hashes, typed allowlisted GTM/Site Kit settings, and bounded callback names for six relevant hooks. Tokens, raw options, customers, order keys, source bodies and callback object state are not returned. Unknown values are null, not false. Callbacks are never executed.

This is server configuration evidence, not a browser purchase trace. The REST context may omit frontend-only callbacks. It cannot establish the historical duplicate source, GTM #39 firing, production isolation, or refresh deduplication. It creates no orders and changes no tracking settings. The automated browser capture/fixture phase remains separate and unimplemented; do not report this diagnostic as a completed duplicate repair.

## Release reconciliation

On 12 October 2026, installed staging bridge 1.1.19 was reconciled with WordPress curtain rollout PR #49 commit 300199f67cd6150efd6fb95782585b7fd792e012. The main file and eight supporting code files matched exactly; main remained at 1.1.6 because that branch was unmerged. Diagnostic PR #50 is stacked on the curtain branch, preserves its source and passed PHP 7.4/8.3 plus curtain/sample regression checks. Staging bridge 1.1.20 was deployed and read back active, with the diagnostic source verified. Release archive SHA-256: 2afd709fd003ef956e8bf2e94ce598d98a6c8a3e577fbc2583254627deaa16f4. Worker release follows the bridge. Older bridges fail closed for the new action. No production curtain rollout is authorized by this release.

No role or credential expansion is needed. No new frontend routes or collectors are introduced. Production is rejected by the PHP diagnostic's independent exact HTTPS-origin/request-host checks and existing authenticated bridge permissions. The Worker additionally verifies the staging response and evidence flags.

## Validation

Worker: `node scripts/test-staging-work.mjs` and `npm run type-check`.
WordPress: `php blindmotion-plugin-deployment-bridge/test-tracking-diagnostic.php`; CI runs PHP 7.4 and 8.3.
After release: invoke the diagnostic and inspect plugin identities and null/unsupported fields. Browser isolation must be independently verified before opening any test receipt.
