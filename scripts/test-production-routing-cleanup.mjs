import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const start = source.indexOf('// Production routing audit: fixed-origin GET only;');
const end = source.indexOf('// End production routing audit.', start);
assert.ok(start >= 0 && end > start);
const original = '/** Blindmotion sample selection sync v1.0.3. */\nfinal class BM_Sample_Routing_V103 {}\nBM_Sample_Routing_V103::init();\n\n/** Blindmotion sample selection sync v1.0.2. */\nfinal class BM_Sample_Routing {}\n';
const sha256Hex = async bytes => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
const reviewedHash = '01118f44ba0fae2428ab6957c4a69b9e9c2957407b83c97996d9a400f27000bf';
const helpers = source.slice(start, end);
assert.equal(helpers.split(reviewedHash).length, 2, 'Production guard remains pinned to reviewed source');
// Exercise the production code with a synthetic fixture, without publishing live PHP.
const fixtureHelpers = helpers.replace(reviewedHash, await sha256Hex(new TextEncoder().encode(original)));
const ctx = vm.createContext({ URL, TextEncoder, TextDecoder, Uint8Array, AbortSignal, fetch, Date, crypto, sha256Hex });
vm.runInContext(ts.transpileModule(fixtureHelpers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
function mock(code = original, active = true, failure = '') {
  let saved = { id: 11, code, active };
  const posts = [];
  return { posts, request: async (url, options) => {
    assert.equal(url, 'https://online.blindmotion.com.au/wp-json/code-snippets/v1/snippets/11');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, 'Basic test');
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.deepEqual(Object.keys(body).sort(), ['active', 'code']);
      posts.push(body);
      saved = { ...saved, ...body };
      return Response.json(saved);
    }
    assert.equal(options.method, 'GET');
    if (posts.length === 1 && failure === 'verify') return Response.json({ ...saved, active: !active });
    if (posts.length === 1 && failure === 'concurrent') return Response.json({ ...saved, code: saved.code + '// concurrent edit' });
    return Response.json(saved);
  }};
}
test('keeps the reviewed current block and original activation', async () => {
  for (const active of [true, false]) {
    const m = mock(original, active);
    const result = await ctx.cleanupProductionSampleRouting('https://online.blindmotion.com.au', 'Basic test', m.request);
    assert.equal(result.active, active);
    assert.equal(m.posts.length, 1);
    assert.equal(m.posts[0].code, original.slice(0, original.indexOf('/** Blindmotion sample selection sync v1.0.2.')).trimEnd() + '\n');
    assert.equal(result.contact_sync_performed, false);
    assert.equal(result.email_settings_changed, false);
  }
});
test('source drift refuses all writes', async () => {
  const m = mock(original + '// drift');
  await assert.rejects(ctx.cleanupProductionSampleRouting('https://online.blindmotion.com.au', 'Basic test', m.request), /changed since/);
  assert.equal(m.posts.length, 0);
});
test('failed verification restores exact original bytes and activation', async () => {
  const m = mock(original, true, 'verify');
  await assert.rejects(ctx.cleanupProductionSampleRouting('https://online.blindmotion.com.au', 'Basic test', m.request), /were restored/);
  assert.equal(m.posts.length, 2);
  assert.equal(m.posts[1].code, original);
  assert.equal(m.posts[1].active, true);
});
test('rollback refuses to overwrite concurrent edits', async () => {
  const m = mock(original, true, 'concurrent');
  await assert.rejects(ctx.cleanupProductionSampleRouting('https://online.blindmotion.com.au', 'Basic test', m.request), /rollback could not be confirmed/);
  assert.equal(m.posts.length, 1);
});
test('alternate origins refuse all requests', async () => {
  const m = mock();
  await assert.rejects(ctx.cleanupProductionSampleRouting('https://example.com', 'Basic test', m.request), /exact live/);
  assert.equal(m.posts.length, 0);
});
