import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import ts from 'typescript';
import {z} from 'zod';
import {assertProductImageEditAllowed, assertSameProductImageState, sameOptionValue, changeWapfChoiceLabels} from '../src/tools/product-option-edits.ts';

const product={id:1298,name:'Curtains',status:'publish',catalog_visibility:'hidden',regular_price:'0',sale_price:'',price:'0'};
const path='_wapf_fieldgroup.fields[1].options.choices[2].image';
assert.doesNotThrow(()=>assertProductImageEditAllowed('staging',product,'_wapf_fieldgroup',path));
assert.doesNotThrow(()=>assertProductImageEditAllowed('staging',{...product,status:'draft'},'other','other.image'));
assert.doesNotThrow(()=>assertProductImageEditAllowed('live',{...product,catalog_visibility:'visible'},'other','other.image'));
for(const status of ['private','pending','trash']) assert.throws(()=>assertProductImageEditAllowed('staging',{...product,status},'_wapf_fieldgroup',path));
for(const catalog_visibility of ['visible','catalog','search']) assert.throws(()=>assertProductImageEditAllowed('staging',{...product,catalog_visibility},'_wapf_fieldgroup',path));
for(const bad of ['_wapf_fieldgroup.fields[1].pricing.amount','_wapf_fieldgroup.fields[1].options.choices[2].attachment','_wapf_fieldgroup.fields[1].options.choices[2]','_wapf_fieldgroup.fields[1].options.choices[2].image.extra']) assert.throws(()=>assertProductImageEditAllowed('staging',product,'_wapf_fieldgroup',bad));
assert.throws(()=>assertProductImageEditAllowed('staging',product,'other',path));
assert.throws(()=>assertProductImageEditAllowed('unknown',product,'_wapf_fieldgroup',path));
for(const key of ['id','name','status','catalog_visibility','regular_price','sale_price','price']) assert.throws(()=>assertSameProductImageState(product,{...product,[key]:'changed'}));
assert.doesNotThrow(()=>assertSameProductImageState(product,structuredClone(product)));
assert.equal(sameOptionValue({a:1,b:{x:2}},'{"b":{"x":2},"a":1}'),true);
assert.equal(sameOptionValue({fields:[1,2]},{fields:[2,1]}),false);

const group={fields:[{id:'heading',type:'image-swatch',label:'Heading Style',options:{choices:[{slug:'wave',label:'S-Fold',image:'image.webp',attachment:4,pricing_type:'fixed',pricing_amount:10},{slug:'knife',label:'Knife Pleat',pricing_type:'none'}]},conditionals:[{rules:[{field:'configuration',value:'sheer'}]}]},{id:'width',type:'number',label:'Width',pricing:{amount:'formula'}}],variables:[{value:'formula'}]};
const edit={field_id:'heading',choice_slug:'wave',expected_label:'S-Fold',new_label:'S-Wave'};
const {changed}=changeWapfChoiceLabels(group,[edit]);
const expected=structuredClone(group);expected.fields[0].options.choices[0].label='S-Wave';
assert.deepEqual(changed,expected);
assert.equal(group.fields[0].options.choices[0].label,'S-Fold');
assert.throws(()=>changeWapfChoiceLabels(group,[edit,edit]));
assert.throws(()=>changeWapfChoiceLabels(group,[{...edit,choice_slug:'missing'}]));
assert.throws(()=>changeWapfChoiceLabels(group,[{...edit,expected_label:'Unexpected'}]));
assert.throws(()=>changeWapfChoiceLabels(group,[{...edit,new_label:'S-Fold'}]));
assert.throws(()=>changeWapfChoiceLabels(group,[{field_id:'heading',expected_label:'Heading Style',new_label:'Other'}]));
assert.throws(()=>changeWapfChoiceLabels(group,[{...edit,field_id:'width'}]));
assert.deepEqual(changeWapfChoiceLabels(group,[{field_id:'width',expected_label:'Width',new_label:'Measured Width'}]).changed.fields[0],group.fields[0]);
const duplicated=structuredClone(group);duplicated.fields[0].options.choices.push(structuredClone(duplicated.fields[0].options.choices[0]));
assert.throws(()=>changeWapfChoiceLabels(duplicated,[edit]));
console.log('PASS: hidden staging image boundaries, state preservation and label-only choice edits');

// Execute the actual registered image handler against mocked WordPress responses.
const source=fs.readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');
const start=source.lastIndexOf('server.registerTool(',source.indexOf('"replace_product_option_image_guarded"'));
const end=source.indexOf('server.registerTool(',start+20);
let handler, state, uploads, writes, reads, mode;
const initial={...product,meta_data:[{id:12,key:'_wapf_fieldgroup',value:{fields:[{id:'test',options:{choices:[{image:'https://staging-online.blindmotion.com.au/old.webp',attachment:44,pricing_amount:'20'}]}}]}}]};
const context={z,crypto:webcrypto,structuredClone,assertProductImageEditAllowed,assertSameProductImageState,sameOptionValue,
 server:{registerTool:(_name,_schema,callback)=>{handler=callback;}},
 productImageWcFetch:async()=>{reads++; if(mode==='race'&&reads===2)state.meta_data[0].value.fields[0].options.choices[0].pricing_amount='30'; return {json:async()=>structuredClone(state)};},
 productImageWpFetch:async()=>({json:async()=>({id:777,source_url:'https://staging-online.blindmotion.com.au/new.webp',mime_type:'image/webp'})}),
 productImageWpUploadMedia:async()=>{uploads++;return {id:777,source_url:'https://staging-online.blindmotion.com.au/new.webp',mime_type:'image/webp'};},
 productImageWcWrite:async(_environment,_path,body)=>{writes++;for(const meta of body.meta_data){const index=state.meta_data.findIndex(m=>m.id===meta.id||m.key===meta.key);if(index<0)state.meta_data.push(structuredClone(meta));else state.meta_data[index]={...state.meta_data[index],...structuredClone(meta)};}if(mode==='corrupt'&&writes===1)state.meta_data[0].value.fields[0].options.choices[0].pricing_amount='99';return {json:async()=>structuredClone(state)};},
 productMetaPathTokens:()=>['fields',0,'options','choices',0,'image'],
 getNestedValue:(value,tokens)=>tokens.reduce((item,token)=>item?.[token],value),
 setNestedValue:(value,tokens,newValue)=>{const parent=tokens.slice(0,-1).reduce((item,token)=>item[token],value);parent[tokens.at(-1)]=newValue;},
 normaliseImageUrl:value=>value, decodeBase64:()=>new Uint8Array([1]),hasExpectedImageSignature:()=>true,
 mediaMetadata:value=>value,toolResult:value=>value,toolError:error=>({isError:true,message:error.message})};
vm.runInNewContext(ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText,context);
const args={environment:'staging',product_id:1298,meta_data_id:12,custom_field_key:'_wapf_fieldgroup',custom_field_path:'_wapf_fieldgroup.fields[0].options.choices[0].image',expected_source_url:'https://staging-online.blindmotion.com.au/old.webp',replacement_base64:'AAAA',replacement_filename:'new.webp',replacement_mime_type:'image/webp'};
const run=async(extra={},testMode='')=>{state=structuredClone(initial);uploads=0;writes=0;reads=0;mode=testMode;return handler({...args,...extra});};
assert.equal((await run()).replaced,true);assert.equal(uploads,1);assert.equal(writes,1);assert.equal(state.status,'publish');assert.equal(state.meta_data[0].value.fields[0].options.choices[0].pricing_amount,'20');
assert.equal((await run({replacement_attachment_id:777})).replaced,true);assert.equal(uploads,0);
assert.equal((await run({custom_field_path:'_wapf_fieldgroup.fields[0].pricing.amount'})).isError,true);assert.equal(uploads,0);assert.equal(writes,0);
assert.equal((await run({expected_source_url:'https://staging-online.blindmotion.com.au/stale.webp'})).isError,true);assert.equal(uploads,0);assert.equal(writes,0);
assert.equal((await run({},'race')).isError,true);assert.equal(uploads,1);assert.equal(writes,0);
assert.equal((await run({},'corrupt')).isError,true);assert.equal(writes,2);assert.deepEqual(state.meta_data[0],initial.meta_data[0]);
console.log('PASS: actual image handler refuses stale/racing writes and restores corrupted metadata');
