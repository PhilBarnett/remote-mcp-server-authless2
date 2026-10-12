import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const file = new URL('../src/tools/staging-work.ts', import.meta.url);
const output = new URL('../src/tools/.staging-work-test.mjs', import.meta.url);
fs.writeFileSync(output, ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText);
try {
  const { stagingWorkSchema, runStagingWork } = await import(output.href);
  assert.equal(stagingWorkSchema.safeParse({action:'inspect_tracking'}).success,true);
  for (const extra of [{host:'online.blindmotion.com.au'},{order_id:9143},{option:'secret'},{relative_path:'wp-config.php'}]) {
    assert.equal(stagingWorkSchema.safeParse({action:'inspect_tracking',...extra}).success,false);
  }
  let response = {environment:'staging',host:'staging-online.blindmotion.com.au',write_performed:false};
  const source = {options:{inputSchema:stagingWorkSchema},handler:input=>runStagingWork(async()=>response,input,false)};
  const content = {options:{inputSchema:stagingWorkSchema},handler:input=>runStagingWork(async()=>response,input,true)};
  assert.equal(source.options.inputSchema.safeParse({action:'read_source',plugin_slug:'other',relative_path:'test.php'}).success,false);
  assert.equal(source.options.inputSchema.safeParse({action:'inspect_routing',order_ids:[1],environment:'live'}).success,false);
  assert.equal(content.options.inputSchema.safeParse({action:'preview_content',product_id:3839,expected_sha256:'a'.repeat(64),changes:{price:'1'}}).success,false);
  assert.equal(content.options.inputSchema.safeParse({action:'preview_content',product_id:3839,expected_sha256:'a'.repeat(64),changes:{}}).success,false);
  assert.equal((await source.handler({action:'inspect_routing',order_ids:[]})).isError,undefined);
  assert.equal((await source.handler({action:'inspect_tracking'})).isError,true);
  response={...response,diagnostic_version:1,evidence_kind:'server_configuration_only',browser_events_verified:false,production_isolation_verified:false};
  assert.equal((await source.handler({action:'inspect_tracking'})).isError,undefined);
  response.browser_events_verified=true;
  assert.equal((await source.handler({action:'inspect_tracking'})).isError,true);
  response.host='online.blindmotion.com.au';
  assert.equal((await source.handler({action:'inspect_routing',order_ids:[]})).isError,true);
  response={environment:'staging',host:'staging-online.blindmotion.com.au',write_performed:true};
  assert.equal((await content.handler({action:'apply_content'})).isError,true);
  console.log('PASS: staging schemas, identity guards and write verification');
} finally { fs.unlinkSync(output); }
