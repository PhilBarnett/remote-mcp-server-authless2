import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import * as miniflare from 'miniflare';
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const start = source.indexOf('// Production routing audit: fixed-origin GET only;');
const end = source.indexOf('// End production routing audit.', start);
const helpers = source.slice(start, end);
for (const redirect of [false, true]) {
 const compiled = await build({stdin:{contents:helpers+`
async function sha256Hex(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join(''); }
export default {async fetch(){try{return Response.json(await readProductionSampleRouting('https://online.blindmotion.com.au','Basic runtime-test'));}catch(e){return Response.json({error:e.message});}}};`,loader:'ts'},write:false,format:'esm',platform:'browser',target:'es2022'});
 const options={workers:[{name:'test',modules:true,script:compiled.outputFiles[0].text,compatibilityDate:'2026-07-02',outboundService:'mock'},
 {name:'mock',modules:true,script:`export default {async fetch(request){if(request.method!=='GET'||request.headers.get('Authorization')!=='Basic runtime-test'||request.url!=='https://online.blindmotion.com.au/wp-json/code-snippets/v1/snippets/11')throw Error('Unexpected request');return ${redirect ? "Response.redirect('https://credential-sink.invalid/',302)" : "Response.json({id:11,active:true,code:'class BM_Sample_Routing {}'})"};}}`,compatibilityDate:'2026-07-02'}]};
 const mf=new miniflare.Miniflare(miniflare.convertV4MiniflareOptions ? miniflare.convertV4MiniflareOptions(options) : options);
 try {const result=await(await mf.dispatchFetch('http://test.local/')).json();if(redirect)assert.match(result.error,/HTTP 302/);else{assert.equal(result.active,true);assert.equal(result.write_performed,false);} console.log(redirect?'PASS Workers redirect refusal':'PASS Workers fixed source read');}finally{await mf.dispose();}
}
