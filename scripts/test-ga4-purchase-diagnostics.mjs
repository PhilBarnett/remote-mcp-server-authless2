import assert from 'node:assert/strict';
import {test} from 'node:test';
import {purchaseDiagnosticSchema, purchaseDiagnosticRequest, purchaseDiagnosticResult, registerPurchaseDiagnosticTool} from '../src/tools/ga4-purchase-diagnostics.ts';
const input = (extra={})=>purchaseDiagnosticSchema.parse({start_date:'2026-09-01',end_date:'2026-09-30',...extra});
test('transaction metrics are purchase-filtered and separated from item metrics',()=>{
 const t=purchaseDiagnosticRequest(input({hostname:'online.blindmotion.com.au'}));
 assert.deepEqual(t.metrics.map(x=>x.name),['eventCount','ecommercePurchases','purchaseRevenue']);
 assert.equal(t.dimensionFilter.andGroup.expressions[0].filter.stringFilter.value,'purchase');
 assert.equal(t.dimensionFilter.andGroup.expressions[1].filter.stringFilter.value,'online.blindmotion.com.au');
 const i=purchaseDiagnosticRequest(input({report:'items'}));
 assert.deepEqual(i.metrics.map(x=>x.name),['itemsPurchased','itemRevenue']);
 assert.deepEqual(i.dimensions.map(x=>x.name),['date','hostName','transactionId','itemId']);
});
test('pagination and privacy states preserve numeric matching without leaking bad IDs',()=>{
 const r=purchaseDiagnosticResult({rows:[{transactionId:'9948'},{transactionId:'(not set)'},{transactionId:'customer@example.com'}],row_count:9},input({offset:2}),{metadata:{subjectToThresholding:true,currencyCode:'AUD',timeZone:'Australia/Sydney'}});
 assert.equal(r.next_offset,5);assert.equal(r.has_more,true);assert.equal(r.rows[0].transactionId,'9948');
 assert.equal(r.rows[1].transaction_id_state,'missing');assert.equal(r.rows[2].transactionId,'(non-numeric redacted)');
 assert.equal(r.data_quality.subject_to_thresholding,true);assert.equal(r.data_quality.currency_code,'AUD');
 const end=purchaseDiagnosticResult({rows:[{transactionId:'9948'}],row_count:3},input({offset:2}),{});
 assert.equal(end.has_more,false);assert.equal(end.next_offset,null);
});
test('invalid dates, reverse ranges, URLs and excessive pages fail closed',()=>{
 for(const extra of [{start_date:'2026-02-30'},{start_date:'2026-10-01'}]) assert.throws(()=>purchaseDiagnosticRequest(input(extra)));
 for(const extra of [{hostname:'https://example.com/path'},{limit:1001},{offset:-1},{report:'users'}]) assert.equal(purchaseDiagnosticSchema.safeParse({start_date:'2026-09-01',end_date:'2026-09-30',...extra}).success,false);
});
test('registered read-only tool awaits reports and returns errors without writes',async()=>{
 let handler;let seen;
 registerPurchaseDiagnosticTool({registerTool:(name,config,fn)=>{assert.equal(name,'get_ga4_purchase_diagnostics');assert.equal(config.annotations.readOnlyHint,true);handler=fn;}},{runReport:async request=>{seen=request;return {metadata:{},rows:[]};},reportResult:()=>({rows:[],row_count:0}),toolResult:x=>x,toolError:e=>({error:e.message})});
 const result=await handler(input());assert.equal(result.has_more,false);assert.equal(seen.dimensionFilter.andGroup.expressions[0].filter.fieldName,'eventName');
 const bad=await handler(input({start_date:'2026-02-30'}));assert.match(bad.error,/valid YYYY/);
});
