import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const compiled = await build({entryPoints:['src/tools/sample-routing-update.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const {updateSampleRouting,routingConfirmation} = await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const baseline = JSON.parse(readFileSync('src/tools/sample-routing-baseline.ts','utf8').match(/export const baselineCode = (.*);/)[1]);
const site='https://online.blindmotion.com.au';
function mock(options={}) {
 let state={id:11,code:baseline,active:true,name:'Sample Routing',scope:'global',priority:10}; let writes=0,reads=0;
 const request=async(url,init)=>{
  assert.equal(url,site+'/wp-json/code-snippets/v1/snippets/11'); assert.equal(init.redirect,'manual'); assert.equal(init.headers.Authorization,'Basic test');
  if(init.method==='GET') { reads++; if(options.redirect)return new Response('',{status:302}); if(options.concurrent&&reads===3)state.code+='\n// concurrent edit'; return Response.json(state); }
  assert.equal(init.method,'POST');writes++;const body=JSON.parse(init.body);assert.deepEqual(Object.keys(body),['code']);state.code=body.code;
  if(options.failAfterWrite&&writes===1)throw Error('network');
  return Response.json(state);
 };
 return {request,get writes(){return writes},get state(){return state}};
}
const call=(m,input,s=site)=>updateSampleRouting(s,'Basic test',input,m.request);
const m=mock();const plan=await call(m,{action:'preview'});assert.equal(m.writes,0);
await assert.rejects(call(m,{action:'apply'}),/preview and confirmation/);assert.equal(m.writes,0);
await assert.rejects(call(m,{action:'preview'},'https://staging-online.blindmotion.com.au'),/Exact live/);
await assert.rejects(call(mock({redirect:true}),{action:'preview'}),/HTTP 302/);
const input={action:'apply',confirmation:routingConfirmation,expected_source_sha256:plan.source_sha256,expected_plan_sha256:plan.plan_sha256};
assert.equal((await call(m,input)).verified,true);assert.equal(m.writes,1);assert.match(m.state.code,/BM_Sample_Return_Live_V2/);
await assert.rejects(call(m,input),/preview and confirmation/);assert.equal(m.writes,1);
const rollback=await call(m,{action:'preview'});assert.equal(rollback.direction,'rollback');
assert.equal((await call(m,{...input,action:'rollback',expected_source_sha256:rollback.source_sha256,expected_plan_sha256:rollback.plan_sha256})).verified,true);assert.equal(m.state.code,baseline);
const uncertain=mock({failAfterWrite:true});assert.equal((await call(uncertain,input)).rolled_back,true);assert.equal(uncertain.state.code,baseline);
const concurrent=mock({concurrent:true});await call(concurrent,{action:'preview'});await assert.rejects(call(concurrent,input),/changed after preview/);assert.equal(concurrent.writes,0);
console.log('PASS: preview, fixed target, redirect refusal, confirmation, stale plan, apply/read-back, rollback, ambiguous write recovery, concurrent change refusal');
const release = JSON.parse(readFileSync('src/tools/sample-routing-release.ts','utf8').match(/export const releaseCode = (.*);/)[1]);
const dir=mkdtempSync(join(tmpdir(),'sample-routing-'));
const phpFile=join(dir,'release.php');writeFileSync(phpFile,'<?php\n'+release);
try { execFileSync('php',['-v'],{stdio:'pipe'}); }
catch (error) { if(process.env.CI)throw error; console.log('PHP unavailable locally; mandatory PHP checks run in CI.');process.exit(0); }
execFileSync('php',['-l',phpFile],{stdio:'inherit'});
const fixtureFile=join(dir,'fixtures.php');
writeFileSync(fixtureFile,`<?php
define('ABSPATH',__DIR__);
function add_action(...$args) {}
function wp_json_encode($v) {return json_encode($v);}
function wp_strip_all_tags($s) {return strip_tags($s);}
require ${JSON.stringify(phpFile)};
$single=['Product'=>['Indoor Blinds'],'Type of Indoor Blinds'=>['Everyday Roller Blinds'],'Roller Blind Configurations'=>['Single'],'Fabric Combinations - Single Blinds'=>['Blockout (+&#36;0.00)'],'Blockout Fabric Options - Everyday roller blinds'=>['Vibe blockout'],'Vibe Blockout Colours'=>['Alloy, Birch']];
$dual=['Product'=>['Indoor Blinds'],'Type of Indoor Blinds'=>['Premium Roller Blinds'],'Roller Blind Configurations'=>['Dual'],'Fabric Combinations - Dual Blinds'=>['Blockout &amp; Sunscreen (+&#36;0.00)'],'Blockout Fabric - Premium roller blinds'=>['LeReve Blockout (+&#36;0.00)'],'LeReve Blockout Colours'=>['Concrete'],'Sunscreen Fabric Options - Premium Roller blinds'=>['Duo Screen'],'Duo Screen Colours - Premium'=>['Blue Grey']];
$a=BM_Sample_Return_Live_V2::line($single);$b=BM_Sample_Return_Live_V2::line($dual);
if(count($a['links'])!==2 || $a['warnings'] || count($b['links'])!==3 || $b['warnings'])throw new Exception('Resolver fixtures failed');
foreach(array_merge($a['links'],$b['links']) as $link)if(strpos($link['url'],'https://online.blindmotion.com.au/')!==0)throw new Exception('Wrong host');
$single['Vibe Blockout Colours']=['Retired colour'];if(BM_Sample_Return_Live_V2::line($single)['links'])throw new Exception('Retired colour must not substitute');
echo 'PASS PHP live resolver single/dual/alias/fallback'.PHP_EOL;
`);
execFileSync('php',[fixtureFile],{stdio:'inherit'});
