import fs from "node:fs";
import ts from "typescript";
const source = fs.readFileSync(new URL("../src/meta-ecommerce-toolkit.ts", import.meta.url), "utf8");
const from = source.indexOf("const LEGACY_ROLLER_WEBSITE_URL");
const to = source.indexOf("async function refuseDuplicateAdName", from);
if (from < 0 || to < 0) throw new Error("Missing production guard source.");
const js = ts.transpileModule(source.slice(from, to), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const compile = new Function("reader", "links", "validate",
  "const assertAccountObject=reader, collectDestinationUrls=links, buildMetaDestination=validate; " +
  js + "; return assertSalesAdsetForCreation;"
);
const ids = {adset:"52667715090600", campaign:"52667333206000", ad:"52667715090400", creative:"1034570949218456", pixel:"645264952345909"};
const roller = "https://online.blindmotion.com.au/everyday-roller-blinds/";
const good = {
 adset: {id:ids.adset, destination_type:"UNDEFINED", optimization_goal:"OFFSITE_CONVERSIONS", status:"ACTIVE", campaign_id:ids.campaign, promoted_object:{pixel_id:ids.pixel}, targeting:{geo_locations:{countries:["AU"]}}},
 campaign: {id:ids.campaign, objective:"OUTCOME_SALES", status:"ACTIVE"},
 ad: {id:ids.ad, status:"ACTIVE", adset_id:ids.adset, campaign_id:ids.campaign, creative:{id:ids.creative, links:[roller]}},
};
const cases = [
 ["pinned legacy", {}, true],
 ["normal website route", {adset:{destination_type:"WEBSITE", status:"PAUSED"}, campaign:{status:"PAUSED"}, skipSibling:true}, true],
 ["new destination is unrelated", {dest:"https://online.blindmotion.com.au/curtains/"}, false],
 ["other undefined ad set", {adset:{id:"123456"}}, false],
 ["missing destination enum", {adset:{destination_type:undefined}}, false],
 ["explicit wrong destination", {adset:{destination_type:"APP"}}, false],
 ["wrong optimization", {adset:{optimization_goal:"LINK_CLICKS"}}, false],
 ["pixel drift", {adset:{promoted_object:{pixel_id:"000"}}}, false],
 ["conflicting destination", {adset:{promoted_object:{pixel_id:ids.pixel, application_id:"123"}}}, false],
 ["targeting drift", {adset:{targeting:{geo_locations:{countries:["AU","NZ"]}}}}, false],
 ["wrong objective", {campaign:{objective:"OUTCOME_LEADS"}}, false],
 ["legacy accepts only active parents", {campaign:{status:"PAUSED"}}, false],
 ["evidence moved", {ad:{adset_id:"000"}}, false],
 ["sibling creative drift", {ad:{creative:{id:"000",links:[roller]}}}, false],
 ["mixed sibling destinations", {ad:{creative:{id:ids.creative,links:[roller,"https://online.blindmotion.com.au/curtains/"]}}}, false],
 ["no sibling destination", {ad:{creative:{id:ids.creative,links:[]}}}, false],
 ["ownership failure", {wrongOwner:true}, false],
];
let count = 0;
for (const [name, overrides, expected] of cases) {
 const fixture = Object.fromEntries(Object.entries(good).map(([key, value])=>[key,{...value,...overrides[key]}]));
 const calls = [];
 const run = compile(
   async (id,type) => {
     calls.push(type);
     if (overrides.wrongOwner && type === "ad") throw new Error("Wrong account.");
     if (fixture[type].id !== id) throw new Error("Wrong ID.");
     return fixture[type];
   },
   (creative)=>creative?.links ?? [],
   (destinationUrl)=>({destinationUrl}),
 );
 let accepted = false;
 try { await run(fixture.adset.id,overrides.dest??roller); accepted = true; } catch { /* Guard refused before creation. */ }
 if (accepted !== expected || (overrides.skipSibling && calls.includes("ad"))) throw new Error("Failed: "+name);
 count++;
}
console.log(`${count} paused-ad parent guard fixture cases passed`);
