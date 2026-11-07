import test from 'node:test';
import assert from 'node:assert/strict';
import {erpMaintenanceSchema, manageErpMaintenance} from '../src/tools/erp-maintenance.ts';

const env = {ERP_MAINTENANCE_ENABLED:'true', ERP_MAINTENANCE_URL:'https://erp-ops.example.test/',
 ERP_MAINTENANCE_TOKEN:'x'.repeat(50), ERP_MAINTENANCE_ACCESS_CLIENT_ID:'test-id', ERP_MAINTENANCE_ACCESS_CLIENT_SECRET:'test-secret'};
test('disabled, unauthenticated and unsafe endpoints do not contact server',async()=>{
 for(const patch of [{ERP_MAINTENANCE_ENABLED:'false'}, {ERP_MAINTENANCE_TOKEN:''},
  {ERP_MAINTENANCE_URL:'http://erp.test/'}, {ERP_MAINTENANCE_URL:'https://user:pass@erp.test/'}]) {
  let called=false;
  await assert.rejects(manageErpMaintenance({action:'status'},{...env,...patch},async()=>{called=true;}));
  assert.equal(called,false);
 }
});
test('no arbitrary SQL, hosts, restore production or unconfirmed start',()=>{
 for(const request of [{action:'sql',sql:'DROP DATABASE'}, {action:'preview',operation:'restore_production'},
 {action:'status',url:'https://elsewhere'}, {action:'start',plan_sha256:'a'.repeat(64),request_id:crypto.randomUUID()}])
  assert.equal(erpMaintenanceSchema.safeParse(request).success,false);
});
test('authenticated request uses fixed route and refuses redirects',async()=>{
 const result=await manageErpMaintenance({action:'preview',operation:'backup_test'},env,async(url,options)=>{
  assert.equal(String(url),'https://erp-ops.example.test/v1/maintenance');
  assert.equal(options.redirect,'error');
  assert.equal(options.headers.Authorization,'Bearer '+env.ERP_MAINTENANCE_TOKEN);
  assert.equal(JSON.parse(options.body).operation,'backup_test');
  return new Response(JSON.stringify({ok:true,plan_sha256:'a'.repeat(64),operation:'backup_test'}));
 });
 assert.equal(result.ok,true);
});
test('unexpected upstream data and errors are never exposed',async()=>{
 for(const response of [new Response('secret host password',{status:500}), new Response(JSON.stringify({ok:true,password:'secret'}))])
  await assert.rejects(manageErpMaintenance({action:'status'},env,async()=>response),e=>!e.message.includes('password')&&e.message.includes('request failed'));
});
