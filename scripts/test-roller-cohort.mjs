import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesSampleAttribution } from '../src/tools/sample-cohort-attribution.ts';
import { isRollerOnlySampleOrder, isRollerPurchaseOrder, rollerPurchaseLineRevenue } from '../src/tools/roller-cohort.ts';
const sample = (product='Indoor Blinds', roller='Everyday Roller Blinds') => ({product_id:128,meta_data:[{key:'Product',value:product},{key:'Type of Roller Blinds',value:roller}]});
const order = (items, extra={}) => ({status:'completed',total:'0.00',line_items:items,...extra});
test('sample attribution compares only supplied fields against the WooCommerce UTM values', () => {
 const attribution = {utm_source: ' fb ', utm_medium: 'paid', utm_campaign: '52667333206000'};
 assert.equal(matchesSampleAttribution(attribution, {campaign: '52667333206000'}), true);
 assert.equal(matchesSampleAttribution(attribution, {source: 'fb', medium: 'paid'}), true);
 assert.equal(matchesSampleAttribution(attribution, {source: 'fb', campaign: '52667333206001'}), false);
 assert.equal(matchesSampleAttribution({...attribution, utm_campaign: null}, {campaign: '52667333206000'}), false);
});
test('explicit roller selection wins over conflicting advertising attribution',()=>{
 assert.equal(isRollerOnlySampleOrder(order([sample()],{attribution:{sample_intent:'Outdoor'}})),true);
 assert.equal(isRollerOnlySampleOrder(order([sample('Indoor Blinds','Premium Roller Blinds')])),true);
 assert.equal(isRollerOnlySampleOrder(order([{product_id:128,meta_data:[]},sample()])),true);
});
test('mixed, unknown, empty and paid sample baskets are excluded',()=>{
 for(const items of [[],[{product_id:128}], [sample(),sample('Outdoor Blinds','Straight Drop')], [sample(),sample('Curtains','Sheer')], [sample('Indoor Blinds','New Product')], [sample(),{product_id:3839}]]) assert.equal(isRollerOnlySampleOrder(order(items)),false);
 assert.equal(isRollerOnlySampleOrder(order([sample()],{total:'1'})),false);
 for(const status of ['on-hold','cancelled','refunded','failed']) assert.equal(isRollerOnlySampleOrder(order([sample()],{status})),false);
});
test('ambiguous duplicate selection metadata does not qualify',()=>{
 const s=sample();s.meta_data.push({key:'Product',value:'Outdoor Blinds'});
 assert.equal(isRollerOnlySampleOrder(order([s])),false);
});
test('roller purchase excludes samples, unrelated products and unpaid orders',()=>{
 const o=order([{product_id:3839,total:'100'},{product_id:4788,total:'200'},{product_id:111,total:'900'},{product_id:128,total:'0'}],{status:'processing',total:'1320'});
 assert.equal(isRollerPurchaseOrder(o),true);assert.equal(rollerPurchaseLineRevenue(o),300);
 assert.equal(isRollerPurchaseOrder({...o,status:'on-hold'}),false);
 assert.equal(isRollerPurchaseOrder(order([{product_id:111,total:'100'}],{total:'110'})),false);
 assert.equal(isRollerPurchaseOrder(order([{product_id:3839,total:'NaN'}],{total:'110'})),false);
});

test('current indoor selector classifies explicit roller samples without landing attribution', () => {
 const currentSample = (range) => ({
  product_id: 128,
  meta_data: [
   {key: 'Product', value: 'Indoor Blinds'},
   {key: 'Type of Indoor Blinds', value: range},
  ],
 });
 const everyday = currentSample('Everyday Roller Blinds');
 const premium = currentSample('Premium Roller Blinds');
 assert.equal(isRollerOnlySampleOrder(order([everyday, premium])), true);
 assert.equal(isRollerOnlySampleOrder(order([sample(), premium])), true);
 assert.equal(isRollerOnlySampleOrder(order([everyday, currentSample('Roman Blinds')])), false);
 assert.equal(isRollerOnlySampleOrder(order([everyday, {
  product_id: 128,
  meta_data: [{key: 'Type of Indoor Blinds', value: 'Roman Blinds'}],
 }])), false);
 assert.equal(isRollerOnlySampleOrder(order([{
  ...everyday,
  meta_data: [...everyday.meta_data, {key: 'Type of Roller Blinds', value: 'Premium Roller Blinds'}],
 }])), false);
});
