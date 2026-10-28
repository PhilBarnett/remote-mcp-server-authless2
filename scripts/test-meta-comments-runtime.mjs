import assert from 'node:assert/strict';
import { build } from 'esbuild';
import * as miniflare from 'miniflare';
const bundle=await build({stdin:{contents:`import {createCommentReader,readMetaComments} from './src/tools/meta-comments';
export default {async fetch(request) {
 const config={adAccountId:'act_99',apiVersion:'v25.0',accessToken:'mock-token'};
 try { const get=createCommentReader(()=>config); return Response.json(await readMetaComments(get,config,{action:'inventory',limit:25,after:new URL(request.url).searchParams.get('after')??undefined})); }
 catch(error){return Response.json({error:error.message});}
}};`,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
const options={workers:[{name:'test',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-02',outboundService:'mock'},
{name:'mock',modules:true,compatibilityDate:'2026-07-02',script:`export default {async fetch(request){
 const u=new URL(request.url); if(u.origin!=='https://graph.facebook.com'||request.method!=='GET'||request.headers.get('Authorization')!=='Bearer mock-token')throw Error('Unexpected request');
 if(u.searchParams.get('after')==='redirect')return Response.redirect('https://credential-sink.invalid/',302);
 if(u.searchParams.get('after')==='error')return Response.json({error:{code:190,message:'mock-token'}},{status:400});
 return Response.json({data:[{id:'10',name:'Our Page'}],paging:{next:'https://graph.facebook.com/?access_token=mock-token',cursors:{after:'next'}}});
}};`} ]};
const mf=new miniflare.Miniflare(miniflare.convertV4MiniflareOptions?miniflare.convertV4MiniflareOptions(options):options);
try {
 const ok=await(await mf.dispatchFetch('http://test.local/')).json();assert.equal(ok.data[0].id,'10');assert.equal(ok.next_after,'next');assert.equal(ok.writes_performed,false);assert.ok(!JSON.stringify(ok).includes('mock-token'));
 const blocked=await(await mf.dispatchFetch('http://test.local/?after=redirect')).json();assert.match(blocked.error,/redirect was blocked/);
 const error=await(await mf.dispatchFetch('http://test.local/?after=error')).json();assert.match(error.error,/code 190/);assert.ok(!error.error.includes('mock-token'));
 console.log('PASS workerd: bounded read using existing bearer token, safe cursor projection, blocked redirects and sanitised API errors.');
}finally{await mf.dispose();}
