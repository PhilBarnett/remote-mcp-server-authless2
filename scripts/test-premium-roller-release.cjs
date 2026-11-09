const {stripTypeScriptTypes}=require('node:module');
const {readFileSync}=require('node:fs');
const {createHash}=require('node:crypto');
const assert=require('node:assert/strict');
const entire=readFileSync(__dirname+'/../src/index.ts','utf8');
const source=stripTypeScriptTypes(entire.slice(entire.indexOf('// Premium Roller release:'),entire.indexOf('/* Guarded outdoor-fabric replacement')));
const stage={"fields":[{"id":"690277bc4d9ea","label":"Test 690277bc4d9ea","type":"image-swatch","conditionals":[{"rules":[{"field":"source","condition":"==","value":"yes","generated":false}]}],"options":{"choices":[]},"required":true},{"id":"690277bc3f85c","label":"Test 690277bc3f85c","type":"image-swatch","conditionals":[{"rules":[{"field":"source","condition":"==","value":"yes","generated":false}]}],"options":{"choices":[]},"required":true},{"id":"690277bceca41","label":"Test 690277bceca41","type":"image-swatch","conditionals":[{"rules":[{"field":"source","condition":"==","value":"yes","generated":false}]}],"options":{"choices":[]},"required":true},{"id":"690277bcbd016","label":"Test 690277bcbd016","type":"image-swatch","conditionals":[{"rules":[{"field":"source","condition":"==","value":"yes","generated":false}]}],"options":{"choices":[]},"required":true},{"id":"690277bc8ef80","label":"Test 690277bc8ef80","type":"image-swatch","conditionals":[{"rules":[{"field":"source","condition":"==","value":"yes","generated":false}]}],"options":{"choices":[]},"required":true},{"id":"690277bc12235","label":"Test 690277bc12235","type":"image-swatch","conditionals":[{"rules":[{"field":"source","condition":"==","value":"yes","generated":false}]}],"options":{"choices":[]},"required":true},{"id":"690277bccf759","label":"Test 690277bccf759","type":"image-swatch","conditionals":[{"rules":[{"field":"source","condition":"==","value":"yes","generated":false}]}],"options":{"choices":[]},"required":true},{"id":"690277bc5132a","label":"Test 690277bc5132a","type":"image-swatch","conditionals":[{"rules":[{"field":"source","condition":"==","value":"yes","generated":false}]}],"options":{"choices":[]},"required":true},{"id":"690277bcedc47","label":"Test 690277bcedc47","type":"image-swatch","conditionals":[{"rules":[{"field":"source","condition":"==","value":"yes","generated":false}]}],"options":{"choices":[]},"required":true},{"id":"690277bc6099a","label":"Test 690277bc6099a","type":"image-swatch","conditionals":[{"rules":[{"field":"source","condition":"==","value":"yes","generated":false}]}],"options":{"choices":[]},"required":true},{"id":"690277bcc9525","label":"Test 690277bcc9525","type":"image-swatch","conditionals":[{"rules":[{"field":"source","condition":"==","value":"yes","generated":false}]}],"options":{"choices":[]},"required":true},{"id":"69f338431af48","label":"Test 69f338431af48","type":"image-swatch","conditionals":[{"rules":[{"field":"source","condition":"==","value":"yes","generated":false}]}],"options":{"choices":[]},"required":true},{"id":"69f33001190b7","label":"Test 69f33001190b7","type":"image-swatch","conditionals":[{"rules":[{"field":"source","condition":"==","value":"yes","generated":false}]}],"options":{"choices":[]},"required":true},{"id":"69f330ef6a093","label":"Remote control options - Alpha","type":"image-swatch","conditionals":[{"rules":[{"field":"source","condition":"==","value":"yes","generated":false}]}],"options":{"choices":[]},"required":true},{"id":"source","label":"Source","type":"radio","options":{"choices":[{"slug":"yes"}]}}],"variables":[{"name":"preserve","value":"original"}],"layout":{"unchanged":true}};
const hash=async v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const ids=['690277bc4d9ea','690277bc3f85c','690277bceca41','690277bcbd016','690277bc8ef80','690277bc12235','690277bccf759','690277bc5132a','690277bcedc47','690277bc6099a','690277bcc9525','69f338431af48','69f33001190b7','69f330ef6a093'];
const schema=new Proxy(()=>schema,{get:()=>schema,apply:()=>schema});
async function harness(mode='ok') {
 let handler,writes=0,reads=0;
 const group=structuredClone(stage);
 for (const id of ids) group.fields.find(f=>f.id===id).conditionals=[];
 const remote=group.fields.find(f=>f.id==='69f330ef6a093');
 remote.options.choices=[['0xqij','Alpha 1 channel',77],['csn4i','Alpha 8 channel',88],['sfea6','Alpha 16 channel',88],['6njqw','No remote required on this blind',0]].map(([slug,label,amount],i)=>({slug,label,pricing_amount:amount,pricing_type:i===3?'none':'fixed',selected:false,options:[],image:null,attachment:null}));
 let product={id:4788,name:'Premium Roller Blinds',status:'publish',catalog_visibility:'visible',description:'KEEP LIVE CONTENT',meta_data:[{id:130508,key:'_wapf_fieldgroup',value:group}]};
 const original=structuredClone(product);
 const args={action:'preview',product_id:4788,expected_product_name:product.name,expected_meta_data_id:130508,expected_field_group_sha256:await hash(group),condition_updates:ids.map(id=>({field_id:id,expected_label:stage.fields.find(f=>f.id===id).label,conditionals:stage.fields.find(f=>f.id===id).conditionals})),explorer_remotes:{one_channel:{kind:'existing_attachment',attachment_id:9065,expected_filename:'one.png'},sixteen_channel:{kind:'existing_attachment',attachment_id:9066,expected_filename:'sixteen.png'}}};
 const key=i=>String(i.attachment_id);
 const env={z:schema,wapfVisualFieldId:schema,wapfVisualChoiceSlug:schema,genericWapfId:schema,genericWapfHash:schema,wapfPatchExistingImage:schema,
 wcFetch:async()=>{reads++;if(mode==='read-lost'&&writes)throw Error('offline');if(mode==='concurrent'&&reads===3)product.meta_data[0].value.layout={changed:true};return {json:async()=>structuredClone(product)};},
 wcWrite:async(path,body)=>{writes++;assert.equal(path,'products/4788');assert.deepEqual(Object.keys(body),['meta_data']);if(mode==='no-write')throw Error('offline');product.meta_data[0].value=structuredClone(body.meta_data[0].value);if(mode==='third-party'&&writes===1)product.meta_data[0].value.layout={other:true};if(mode==='state-change'&&writes===1)product.status='private';if(mode==='response-lost')throw Error('lost');},
 genericWapf:p=>({meta:p.meta_data[0],group:p.meta_data[0].value}),genericWapfHashOf:hash,genericWapfFieldId:f=>f.id,wapfFieldLabel:f=>f.label,
 loadWapfPatchMedia:async imgs=>new Map(imgs.map(i=>[key(i),{attachment:i.attachment_id,source_url:'https://online.blindmotion.com.au/'+i.expected_filename}])),wapfPatchImageKey:key,
 server:{registerTool:(n,s,h)=>handler=h},toolResult:x=>x,toolError:e=>({error:e.message})};
 new Function(...Object.keys(env),source)(...Object.values(env));
 return {run:a=>handler(a),args,get:()=>({product,writes,original})};
}
(async()=>{
 let n=0;
 for(const mode of ['ok','response-lost','no-write','read-lost','third-party','state-change','concurrent']){
  const h=await harness(mode), preview=await h.run(h.args);assert.ok(preview.plan_sha256,JSON.stringify(preview));assert.equal(h.get().writes,0);
  const result=await h.run({...h.args,action:'apply',confirmation:'CONFIRM APPLY PREMIUM ROLLER RELEASE',expected_plan_sha256:preview.plan_sha256});
  if(['ok','response-lost'].includes(mode)){
   assert.equal(result.updated,true,JSON.stringify(result));assert.equal(h.get().writes,1);assert.equal(h.get().product.description,'KEEP LIVE CONTENT');
   const f=h.get().product.meta_data[0].value.fields;
   assert.deepEqual(f.find(f=>f.id==='69f330ef6a093').options.choices.map(c=>c.pricing_amount),[66,66,0]);
   for(const old of h.get().original.meta_data[0].value.fields){const now=f.find(f=>f.id===old.id);if(!ids.includes(old.id))assert.deepEqual(now,old);else {const a=structuredClone(old),b=structuredClone(now);delete a.conditionals;delete b.conditionals;if(old.id==='69f330ef6a093'){delete a.options.choices;delete b.options.choices;}assert.deepEqual(a,b);}}
  } else if(mode==='state-change'){assert.equal(result.rolled_back,true);assert.equal(h.get().writes,2);assert.deepEqual(h.get().product.meta_data[0].value,h.get().original.meta_data[0].value);}
  else if(['read-lost','third-party'].includes(mode)){assert.equal(result.manual_reconciliation_required,true);assert.equal(h.get().writes,1);}
  else {assert.ok(result.error);assert.equal(h.get().writes,mode==='concurrent'?0:1);}
  n++;
 }
 for(const kind of ['stale','disallowed','duplicate','missing-choice','wrong-label','wrong-plan','missing-confirmation']){
  const h=await harness();const p=await h.run(h.args);let a=structuredClone(h.args);
  if(kind==='stale')a.expected_field_group_sha256='0'.repeat(64);
  if(kind==='disallowed')a.condition_updates[0].field_id='unapproved';
  if(kind==='duplicate')a.condition_updates.push(a.condition_updates[0]);
  if(kind==='missing-choice')a.condition_updates[0].conditionals[0].rules[0].value='missing';
  if(kind==='wrong-label')a.condition_updates[0].expected_label='wrong';
  if(kind==='wrong-plan'||kind==='missing-confirmation')a={...a,action:'apply',expected_plan_sha256:kind==='wrong-plan'?'0'.repeat(64):p.plan_sha256,confirmation:kind==='wrong-plan'?'CONFIRM APPLY PREMIUM ROLLER RELEASE':undefined};
  assert.ok((await h.run(a)).error,kind);assert.equal(h.get().writes,0);n++;
 }
 console.log(n+' release tests passed');
})().catch(e=>{console.error(e);process.exit(1)});
