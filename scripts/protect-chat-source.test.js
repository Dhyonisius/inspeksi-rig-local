import test from 'node:test';
import assert from 'node:assert/strict';
import {createProtectChatSource} from './protect-chat-source.js';
function fixture(overrides={}){
 const calls=[];const env={PROTECT_API_ENABLED:'1',PROTECT_USERNAME:'test',PROTECT_PASSWORD:'test-password',INSPECTION_CHAT_BASE_URL:'http://company-bridge:8080',INSPECTION_CHAT_MODEL:'internal-model'};
 const fetchImpl=async(raw,options)=>{const url=new URL(raw);calls.push({url,options});const name=url.pathname.split('/').at(-1);
  if(overrides[name])return overrides[name](url,options);
  const result={Login:{jwtToken:'private-test-token',expiresIn:43200},GetRigs:{status:'success',data:[{rigCode:'BMS-20'},{rigCode:'RIG-21'}]},GetEquipmentStatus:{status:'success',data:[{equipmentName:'Mud Pump',roleName:'Mechanic',status:'Not Ready'},{equipmentName:'Drawwork',roleName:'Driller',status:'Ready to Operate'}]},GetSubmissionHistory:{status:'success',data:[{inspectionId:77,roleName:'Mechanic',dateTime:'2026-11-06 10:00'}]},GetSubmissionHistoryDetail:{status:'success',rigCode:'BMS-20',data:[{equipmentName:'Mud Pump',safeguardName:'Seal',checkValue:'Not OK',photoRemark:'Seal bocor',isChecked:'Y'}]},chat:{model:'internal-model',message:{content:'Mud Pump NOT_READY, seal bocor, inspection_id 77.'}}}[name];
  if(!result)throw Error('Unexpected '+name);return Response.json(result);
 };return {source:createProtectChatSource({env,fetchImpl}),calls};
}
test('default disabled until explicitly enabled',()=>assert.equal(createProtectChatSource({env:{}}).enabled,false));
test('status reads exactly one rig, computes totals, reuses token and never sends secret to LLM',async()=>{
 const {source,calls}=fixture();const answer=await source.answer({message:'Status equipment BMS 20',use_ai:false});
 assert.match(answer.answer,/2 equipment; 1 READY, 1 NOT_READY/);assert.equal(answer.sources[0].rig,'BMS-20');assert.equal(calls.find(c=>c.url.pathname.endsWith('GetEquipmentStatus')).url.searchParams.get('rigCode'),'BMS-20');
 await source.answer({message:'Status BMS-20'});assert.equal(calls.filter(c=>c.url.pathname.endsWith('Login')).length,1);
 const modelCall=calls.find(c=>c.url.pathname.endsWith('/chat'));assert.equal(modelCall.url.host,'company-bridge:8080');assert.doesNotMatch(modelCall.options.body,/private-test-token|test-password/);assert.doesNotMatch(JSON.stringify(answer),/private-test-token|test-password/);
});
test('no rig or multiple rigs asks clarification; does not query master equipment',async()=>{
 const {source,calls}=fixture();assert.match((await source.answer({message:'Apa yang tidak ready?'})).answer,/Sebutkan satu kode rig/);assert.match((await source.answer({message:'BMS-20 dan RIG-21'})).answer,/Sebutkan satu kode rig/);assert.equal(calls.filter(c=>c.url.pathname.endsWith('GetEquipmentStatus')).length,0);
});
test('empty equipment is not interpreted as safe',async()=>{const {source}=fixture({GetEquipmentStatus:()=>Response.json({status:'success',data:[]})});assert.match((await source.answer({message:'Status BMS-20'})).answer,/kosong tidak berarti rig aman/);});
test('details include source ID and remark; no PDF page is invented',async()=>{const {source,calls}=fixture();const r=await source.answer({message:'Detail temuan BMS-20'});assert.equal(r.sources[0].details[0].inspection_id,77);assert.equal(r.sources[0].details[0].items[0].remark,'Seal bocor');assert.ok(calls.find(c=>c.url.pathname.endsWith('GetSubmissionHistoryDetail')).url.searchParams.get('inspectionId')==='77');});
test('authentication failure is guarded; no repeated login or PDF fallback',async()=>{const {source,calls}=fixture({Login:()=>new Response('sensitive upstream error',{status:401})});const r=await source.answer({message:'BMS-20'});assert.match(r.answer,/HTTP 401/);assert.doesNotMatch(r.answer,/sensitive upstream error/);await source.answer({message:'BMS-20'});assert.equal(calls.length,1);});
test('MFA stops before reading data',async()=>{const {source,calls}=fixture({Login:()=>Response.json({mfacode:'challenge',jwtToken:'fake'})});assert.match((await source.answer({message:'BMS-20'})).answer,/MFA/);assert.equal(calls.length,1);});
test('unsupported dates are explicit, not silently mapped to latest',async()=>{const {source,calls}=fixture();assert.match((await source.answer({message:'Status BMS-20 kemarin'})).answer,/belum didukung/);assert.equal(calls.length,2);});
test('rig listing uses live codes without loading all equipment',async()=>{const {source,calls}=fixture();assert.match((await source.answer({message:'Daftar rig'})).answer,/BMS-20, RIG-21/);assert.equal(calls.length,2);});
