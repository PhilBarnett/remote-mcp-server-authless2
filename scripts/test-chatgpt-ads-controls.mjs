import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: [new URL('../src/tools/chatgpt-ads.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022' });
const { manageChatgptAds, managementInputSchema, registerChatgptAdsTools } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
function setup() {
  const account = { id: 'adacct_6ac4305ad094819e97ddf2ada19c5a78', timezone: 'Australia/Sydney', currency_code: 'AUD', status: 'active' };
  const state = { '/v1/ad_account': account, '/v1/ad_account/spend_limit_windows': { revision: 0, windows: [] } };
  const calls = [];
  const deps = { getBindings: () => ({ OPENAI_ADS_API_KEY: 'test-secret' }), fetch: async (url, options) => {
    calls.push({ url, options });
    return Response.json(state[new URL(url).pathname] ?? { accepted: true });
  }};
  return { deps, state, calls, run: input => manageChatgptAds(deps, { action: 'controls', ...input }) };
}
const change = { operation: 'set_ad_account_daily_spend_limit', body: { amount_micros: 30000000, expected_revision: 0, window_id: null, start_date: '2026-10-07' } };
test('advanced-only catalog and root schema exclude retired actions and duplicate operations', async () => {
  const { run, deps, calls } = setup();
  let registered;
  registerChatgptAdsTools({ registerTool(name, options) { registered = { name, options }; } }, deps);
  assert.equal(registered.name, 'manage_chatgpt_ads_advanced');
  assert.equal(managementInputSchema.toJSONSchema().type, 'object');
  const catalog = await run({ mode: 'describe' });
  assert.equal(catalog.operations.length, 22);
  for (const item of catalog.operations) assert.equal((await run({ mode: 'describe', operation: item.operation })).operation, item.operation);
  for (const action of ['account', 'campaigns', 'ads', 'delivery', 'conversions', 'locations']) await assert.rejects(manageChatgptAds(deps, { action }));
  for (const operation of ['create_campaign', 'activate_campaign', 'update_ad', 'get_campaign_insights', 'upload_blob', 'add_custom_audience_members', 'get_hotel_insights', 'list_product_feeds']) await assert.rejects(run({ mode: 'preview', operation }));
  assert.equal(calls.length, 0);
});
test('preview performs only reads; apply forwards the exact spending limit once', async () => {
  const { run, calls } = setup();
  const preview = await run({ mode: 'preview', ...change });
  assert.ok(calls.every(c => c.options.method === 'GET'));
  const applied = await run({ mode: 'apply', ...change, preview_token: preview.preview_token });
  assert.equal(applied.applied, true);
  assert.equal(applied.verification_read_completed, true);
  const writes = calls.filter(c => c.options.method !== 'GET');
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].options.body), change.body);
});
test('changed inputs, forged token, expiry and stale revision prevent writes', async () => {
  const { run, state, calls } = setup();
  const preview = await run({ mode: 'preview', ...change });
  await assert.rejects(run({ mode: 'apply', ...change, body: { ...change.body, amount_micros: 40000000 }, preview_token: preview.preview_token }), /changed/);
  const forged = preview.preview_token.slice(0,-1) + (preview.preview_token.endsWith('0') ? '1' : '0');
  await assert.rejects(run({ mode: 'apply', ...change, preview_token: forged }), /signature/);
  await assert.rejects(run({ mode: 'apply', ...change, preview_token: `${Date.now()-1}.${preview.preview_token.split('.').slice(1).join('.')}` }), /expired/);
  state['/v1/ad_account/spend_limit_windows'].revision++;
  await assert.rejects(run({ mode: 'apply', ...change, preview_token: preview.preview_token }), /changed/);
  assert.ok(calls.every(c => c.options.method === 'GET'));
});
test('wrong account and changed currency block mutation', async () => {
  const { run, state, calls } = setup();
  state['/v1/ad_account'].id = 'wrong';
  await assert.rejects(run({ mode: 'preview', ...change }), /identity/);
  state['/v1/ad_account'].id = 'adacct_6ac4305ad094819e97ddf2ada19c5a78';
  state['/v1/ad_account'].currency_code = 'USD';
  await assert.rejects(run({ mode: 'preview', ...change }), /currency/);
  assert.ok(calls.every(c => c.options.method === 'GET'));
});
test('read cannot mutate, apply requires preview, invalid money and paths fail before access', async () => {
  const { run, calls } = setup();
  await assert.rejects(run({ mode: 'read', ...change }), /changes/);
  await assert.rejects(run({ mode: 'apply', ...change }), /preview_token/);
  calls.length = 0;
  await assert.rejects(run({ mode: 'preview', ...change, body: { ...change.body, amount_micros: -1 } }));
  await assert.rejects(run({ mode: 'read', operation: 'get_product_feed_settings', parameters: { feed_id: '../ad_account' } }));
  assert.equal(calls.length, 0);
});
test('SFTP only permits SSH public keys and response credentials are redacted', async () => {
  const { run, state, calls } = setup();
  await assert.rejects(run({ mode: 'preview', operation: 'post_product_feed_sftp_access', parameters: { feed_id: 'feed_test' }, body: { authentication_method: 'password' } }), /SSH/);
  assert.equal(calls.length, 0);
  state['/v1/feeds/feed_test/sftp_access'] = { password: 'secret-pass', nested: { access_token: 'secret-token' }, echoed: 'test-secret' };
  const read = await run({ mode: 'read', operation: 'get_product_feed_sftp_access', parameters: { feed_id: 'feed_test' } });
  assert.equal(read.result.password, '[REDACTED]');
  assert.equal(read.result.nested.access_token, '[REDACTED]');
  assert.equal(read.result.echoed, '[REDACTED]');
});
test('credential errors and redirects remain private; mutations are never automatically retried', async () => {
  const { deps, run } = setup();
  const preview = await run({ mode: 'preview', ...change });
  const original = deps.fetch;
  let writes = 0;
  deps.fetch = async (url, options) => { if (options.method !== 'GET') { writes++; throw new DOMException('test-secret', 'TimeoutError'); } return original(url, options); };
  await assert.rejects(run({ mode: 'apply', ...change, preview_token: preview.preview_token }), e => e.message.includes('TimeoutError') && !e.message.includes('test-secret'));
  assert.equal(writes, 1);
  deps.fetch = async () => Response.redirect('https://credential-sink.invalid', 302);
  await assert.rejects(run({ mode: 'read', operation: 'get_ad_account_spend_limit_windows' }), /redirect HTTP 302/);
  deps.getBindings = () => ({});
  await assert.rejects(run({ mode: 'read', operation: 'get_ad_account_spend_limit_windows' }), /not configured/);
});
