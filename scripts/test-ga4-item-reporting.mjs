import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalItemReporting } from '../src/tools/ga4-item-reporting.ts';
test('canonical grouping retains raw IDs and separates samples',()=>{
 const rows=[{itemId:'gla_3839',itemName:'Everyday',itemsPurchased:'81',itemRevenue:'9280.43'},{itemId:'3839',itemName:'Everyday Roller',itemsPurchased:'2',itemRevenue:'400.39'},{itemId:'128',itemsPurchased:'32',itemRevenue:'0'},{itemId:'gla_128',itemsPurchased:'221',itemRevenue:'0'}];
 const r=canonicalItemReporting(rows,4);assert.equal(r.rows.length,2);assert.deepEqual(r.rows[0].raw_item_ids,['gla_3839','3839']);assert.equal(r.rows[0].itemsPurchased,83);assert.equal(r.rows[0].itemRevenue,9680.82);assert.equal(r.rows[1].product_group,'fabric_sample');assert.equal(r.rows[1].itemsPurchased,253);assert.equal(r.source_rows_truncated,false);
});
test('unknown SKU identities are preserved and truncation is disclosed',()=>{
 const r=canonicalItemReporting([{itemId:'ABC',itemsViewed:'3'},{itemId:'gla_ABC',itemsViewed:'NaN'}],5);assert.equal(r.rows.length,2);assert.equal(r.rows[0].canonical_item_id,null);assert.equal(r.rows[1].itemsViewed,0);assert.equal(r.source_rows_truncated,true);
});
