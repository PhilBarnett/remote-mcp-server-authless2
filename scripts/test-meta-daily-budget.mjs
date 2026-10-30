import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Exercise the registered production handler with mocked Meta transport.
const source = await readFile("src/index.ts", "utf8");
const section = source.slice(source.indexOf('"update_meta_daily_budget"'), source.indexOf('"pause_meta_campaign_guarded"'));
const start = section.indexOf("async ({ object_type, object_id, new_daily_budget_aud }) => {");
const end = section.lastIndexOf("\n\t\t},");
assert.ok(start >= 0 && end > start, "registered daily-budget handler must be found");
const handlerSource = section.slice(start, end + "\n\t\t}".length);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function setup(currentAud = 24, accountId = "123") {
 const writes = [];
 const account = {id:"456",account_id:accountId,name:"Koolewong",daily_budget:String(Math.round(currentAud * 100))};
 const run = new AsyncFunction("getMetaConfig","metaFetch","metaPost","metaBudgetAmount","toolResult","toolError","args",
  "return (" + handlerSource + ")(args);");
 return {
  writes,
  change: (amount, object_type = "campaign") => run(
   () => ({adAccountId:"act_123"}),
   async () => ({...account}),
   async (id, body) => {writes.push({id,body});account.daily_budget=String(body.daily_budget);},
   amount => amount == null ? null : Number(amount) / 100,
   result => result,
   error => ({error:error.message}),
   {object_type,object_id:"456",new_daily_budget_aud:amount}
  )
 };
}
test("Meta daily budget accepts exactly 50% for campaigns and ad sets", async () => {
 for (const type of ["campaign","adset"]) {
  const s=setup(),r=await s.change(36,type);
  assert.equal(r.updated,true);
  assert.equal(r.verified_daily_budget,36);
  assert.deepEqual(s.writes,[{id:"456",body:{daily_budget:3600}}]);
 }
});
test("Meta daily budget rejects one cent over 50% and the requested 45 from 24", async () => {
 for (const amount of [36.01,44,45]) {
  const s=setup(),r=await s.change(amount);
  assert.match(r.error,/capped at 50%/);
  assert.equal(s.writes.length,0);
 }
});
test("Meta budget decreases remain supported and account ownership remains required", async () => {
 const s=setup(45),r=await s.change(24);
 assert.equal(r.verified_daily_budget,24);
 const foreign=setup(24,"999"),blocked=await foreign.change(36);
 assert.match(blocked.error,/configured Meta ad account/);
 assert.equal(foreign.writes.length,0);
});
