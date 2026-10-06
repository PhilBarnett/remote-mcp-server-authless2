import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import * as miniflare from 'miniflare';

const source = await readFile(new URL('../src/tools/chatgpt-ads.ts', import.meta.url), 'utf8');
async function run(legacy = false, redirect = false, controls = false) {
  const moduleSource = legacy ? source.replace('redirect: "manual"', 'redirect: "error"') : source;
  const result = await build({
    stdin: { contents: `${moduleSource}
export default { async fetch() {
  if (${controls}) {
    const deps = { getBindings: () => ({ OPENAI_ADS_API_KEY: 'runtime-test-key' }), fetch: (input, init) => fetch(input, init) };
    const change = { action: 'controls', operation: 'create_campaign', body: { name: 'Runtime Campaign', status: 'paused', budget: { daily_spend_limit_micros: 20000000 } }, idempotency_key: 'runtime-create-001' };
    const preview = await manageChatgptAds(deps, { ...change, mode: 'preview' });
    return Response.json(await manageChatgptAds(deps, { ...change, mode: 'apply', preview_token: preview.preview_token }));
  }
  try { return Response.json(await readChatgptAds({ getBindings: () => ({ OPENAI_ADS_API_KEY: 'runtime-test-key' }), fetch: (input, init) => fetch(input, init) }, { action: 'account' })); }
  catch (error) { return Response.json({ error: error.message }); }
} };`, resolveDir: new URL('../src/tools/', import.meta.url).pathname, sourcefile: 'runtime-test.ts', loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  });
  const options = { workers: [
    { name: 'test', modules: true, script: result.outputFiles[0].text, compatibilityDate: '2026-07-02', outboundService: 'mock' },
    { name: 'mock', modules: true, script: `export default { async fetch(request) {
      if (new URL(request.url).origin !== 'https://api.ads.openai.com') throw new Error('Unexpected origin');
      if (request.headers.get('Authorization') !== 'Bearer runtime-test-key') throw new Error('Missing test auth');
      if (new URL(request.url).pathname === '/v1/campaigns') {
        if (request.method === 'GET') return Response.json({ data: [], has_more: false });
        if (request.headers.get('Idempotency-Key') !== 'runtime-create-001') throw new Error('Missing idempotency key');
        return Response.json({ id: 'cmpn_created', ...await request.json() });
      }
      return ${redirect ? "Response.redirect('https://credential-sink.invalid/', 302)" : "Response.json({ id: 'adacct_6ac4305ad094819e97ddf2ada19c5a78', timezone: 'Australia/Sydney', currency_code: 'AUD', status: 'active' })"};
    } };`, compatibilityDate: '2026-07-02' },
  ] };
  const mf = new miniflare.Miniflare(miniflare.convertV4MiniflareOptions ? miniflare.convertV4MiniflareOptions(options) : options);
  try { return await (await mf.dispatchFetch('http://test.local/')).json(); }
  finally { await mf.dispose(); }
}

const original = await run(true);
assert.match(original.error, /request failed \(TypeError\)/);
const fixed = await run();
assert.equal(fixed.authenticated, true);
const blocked = await run(false, true);
assert.match(blocked.error, /redirect HTTP 302; redirect blocked/);
const controlled = await run(false, false, true);
assert.equal(controlled.applied, true);
assert.equal(controlled.result.status, 'paused');
assert.equal(controlled.result.id, 'cmpn_created');
console.log('PASS workerd: unsupported redirect rejected; authentication works; redirects blocked; signed preview/apply creates a paused campaign against a mock API.');
