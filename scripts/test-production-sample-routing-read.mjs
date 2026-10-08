import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const start = source.indexOf("// Production routing audit: fixed-origin GET only;");
const end = source.indexOf("// End production routing audit.", start);
assert.ok(start >= 0 && end > start, "Routing audit helpers must exist");
const helpers = source.slice(start, end);
const js = ts.transpileModule(helpers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const context = vm.createContext({ URL, AbortSignal, TextEncoder, TextDecoder, Uint8Array, Date, crypto, fetch,
  sha256Hex: async bytes => Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex") });
vm.runInContext(js, context);
const read = context.readProductionSampleRouting;
const valid = { id: 11, active: true, code: "class BM_Sample_Routing {\n const VERSION = '1.0.3';\n public function route() { return 'straight_drop'; }\n}" };
const response = value => new Response(JSON.stringify(value));
test("fixed authenticated GET, hash and active source, no parity claim", async () => {
  let count = 0;
  const result = await read("https://online.blindmotion.com.au/", "Basic test", async (url, options) => {
    count++;
    assert.equal(url, "https://online.blindmotion.com.au/wp-json/code-snippets/v1/snippets/11");
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.Authorization, "Basic test");
    assert.equal(options.body, undefined);
    return response(valid);
  });
  assert.equal(count, 1);
  assert.equal(result.source, valid.code);
  assert.equal(result.active, true);
  assert.equal(result.production_parity_verified, false);
  assert.equal(result.write_performed, false);
  assert.match(result.source_sha256, /^[a-f0-9]{64}$/);
});
test("reject alternate origins, paths and URL credentials before any request", async () => {
  for (const site of ["http://online.blindmotion.com.au", "https://staging-online.blindmotion.com.au",
    "https://online.blindmotion.com.au.evil.test", "https://online.blindmotion.com.au/wp-admin/",
    "https://x:y@online.blindmotion.com.au/", "https://online.blindmotion.com.au/?x=1"]) {
    await assert.rejects(read(site, "Basic test", () => { throw new Error("unexpected request"); }), /exact live/);
  }
});
test("reject wrong snippet, wrong class and ambiguous activation metadata", async () => {
  for (const value of [{ ...valid, id: 12 }, { ...valid, code: "class Other {}" }, { ...valid, active: "1" }]) {
    await assert.rejects(read("https://online.blindmotion.com.au", "Basic test", async () => response(value)), /identity/);
  }
});
test("redact credential lines, token-shaped strings and addresses", async () => {
  const code = valid.code + "\n$api_key = 'secret-value';\n$x = 'abcd1234abcd1234abcd1234abcd1234';\n// owner@example.com";
  const result = await read("https://online.blindmotion.com.au", "Basic test", async () => response({ ...valid, code }));
  assert.doesNotMatch(result.source, /secret-value|abcd1234|owner@example.com/);
  assert.match(result.source, /straight_drop/);
  assert.equal(result.source_redactions, 3);
});
test("error and malformed JSON responses do not disclose their bodies", async () => {
  await assert.rejects(read("https://online.blindmotion.com.au", "Basic test",
    async () => new Response("private-secret", { status: 403 })), error => /HTTP 403/.test(error.message) && !/private-secret/.test(error.message));
  await assert.rejects(read("https://online.blindmotion.com.au", "Basic test",
    async () => new Response("private-secret")), error => /invalid JSON/.test(error.message) && !/private-secret/.test(error.message));
});
test("reject oversized responses", async () => {
  await assert.rejects(read("https://online.blindmotion.com.au", "Basic test",
    async () => response({ ...valid, code: valid.code + "x".repeat(262144) })), /size limit/);
});


test("redirect is rejected without following or exposing its target", async () => {
 let calls=0;
 await assert.rejects(read("https://online.blindmotion.com.au", "Basic test", async () => {
   calls++; return new Response("private redirect body", {status:302,headers:{Location:"https://credential-sink.invalid/"}});
 }), /HTTP 302/);
 assert.equal(calls,1);
});
