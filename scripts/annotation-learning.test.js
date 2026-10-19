import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { combineProposals, createAnnotationLearning, boxOverlap } from './annotation-learning.js';
const hazards=[{hazard_type_id:9,code:'CABLE',name:'Kabel rusak',area_type:'RIG'}];
const box={hazard_type_id:9,x:.1,y:.2,width:.3,height:.4,confidence:.85};
const vlm={overall_label:'RISK',description:'Kabel terkelupas.',model:'gemma3:4b',annotations:[box]};
const detector={available:true,model_name:'Rig model',trained_hazard_ids:[9],detections:[{hazard_type_id:9,confidence:.9,box:{x:.11,y:.21,width:.28,height:.39}}]};

test('hybrid uses detector geometry only for an overlapping matching hazard',()=>{
 const result=combineProposals(vlm,detector,hazards);
 assert.equal(result.method,'HYBRID');assert.equal(result.annotations[0].source,'VLM_YOLO');assert.equal(result.annotations[0].x,.11);assert.equal(result.disagreement,false);assert.equal(result.human_reviewed,false);
 assert.equal(boxOverlap(box,box),1);assert.equal(boxOverlap(box,{...box,x:.8,width:.1}),0);
});
test('model disagreement gets higher review priority without silently adding detector hazards',()=>{
 const result=combineProposals({...vlm,overall_label:'NO_LISTED_HAZARD_VISIBLE',annotations:[]},detector,hazards);
 assert.equal(result.disagreement,true);assert.equal(result.priority,95);assert.equal(result.annotations.length,0);assert.equal(result.overall_label,'NO_LISTED_HAZARD_VISIBLE');
});
test('untrained classes do not count as detector misses',()=>{
 const result=combineProposals(vlm,{...detector,trained_hazard_ids:[10],detections:[]},hazards);
 assert.equal(result.disagreement,false);assert.equal(result.annotations[0].source,'VLM');
});
test('pseudo labeling cannot turn absence of detections into a safe label',()=>{
 const result=combineProposals(null,{...detector,detections:[]},hazards,'PSEUDO');assert.equal(result.overall_label,'UNCERTAIN');assert.equal(result.method,'PSEUDO');assert.equal(result.human_reviewed,false);
 const invalid=combineProposals(null,{...detector,detections:[{...detector.detections[0],confidence:2}]},hazards,'PSEUDO');assert.equal(invalid.annotations.length,0);
 const valid=combineProposals(null,detector,hazards,'PSEUDO');assert.equal(valid.overall_label,'RISK');assert.equal(valid.annotations[0].source,'YOLO');
});
test('missing rig model keeps zero-shot VLM available',()=>{
 const result=combineProposals(vlm,{available:false},hazards);assert.equal(result.method,'VLM');assert.equal(result.model,'gemma3:4b');
});

test('model label/box conflicts remain visible with high review priority',()=>{
 const result=combineProposals({...vlm,overall_label:'UNCERTAIN',annotations:[],review_flags:['LABEL_BOX_CONFLICT'],review_notes:['Label dan kotak AI bertentangan.']},null,hazards);
 assert.equal(result.priority,95);assert.ok(result.priority_reasons.includes('Label dan kotak AI bertentangan.'));assert.equal(result.overall_label,'UNCERTAIN');assert.equal(result.human_reviewed,false);
});

async function setup(t,{state={},saved=true,methodFailure=false}={}) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'annotation-learning-'));
 t.after(async()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});});
 const uploadDir=path.join(root,'uploads');await fs.mkdir(uploadDir);const binary=Buffer.from('private-test-photo');await fs.writeFile(path.join(uploadDir,'abcdef.jpg'),binary);
 const checksum=crypto.createHash('sha256').update(binary).digest('hex');const sql=[];let calls=0;
 const ctx={privateDir:root,uploadDir,intValue:value=>{if(!Number.isSafeInteger(Number(value))||Number(value)<1)throw Object.assign(new Error('id'),{status:400});return Number(value);},
  sqlText:value=>"N'"+String(value).replaceAll("'","''")+"'",sqlAscii:value=>"'"+String(value).replaceAll("'","''")+"'",withDatasetReadLock:async(id,run)=>run(),withInferenceLock:async(user,run)=>run(),
  detectRig:async()=>detector,proposeAnnotation:async()=>{calls++;if(methodFailure)throw new Error('offline');return structuredClone(vlm);},
  jsonQuery:async query=>{sql.push(query);
   if(query.startsWith('SELECT di.dataset_item_id'))return {dataset_item_id:8,dataset_id:7,label_status:'DRAFT',dataset_status:'DRAFT',split:'TRAIN',work_area_id:3,file_uri:'uploads/abcdef.jpg',checksum,...state};
   if(query.startsWith('SELECT work_area_id'))return {work_area_id:3,name:'Rig',area_type:'RIG'};
   if(query.startsWith('SELECT hazard_type_id'))return hazards;
   if(query.startsWith('SELECT an.hazard_type_id'))return [];
   if(query.startsWith('SET XACT_ABORT'))return {saved};
   return null;
  }};
 return {service:createAnnotationLearning(ctx),ctx,sql,checksum,calls:()=>calls};
}
test('service stores proposal with a post-inference state guard and never updates human annotations',async t=>{
 const f=await setup(t);const result=await f.service.suggest(8,{user_id:2,role:'operator'});
 assert.equal(result.method,'HYBRID');assert.equal(result.human_reviewed,false);assert.ok(result.priority_reasons.includes('Kategori masih sedikit contoh'));
 const transaction=f.sql.find(query=>query.startsWith('SET XACT_ABORT'));
 assert.match(transaction,/UPDLOCK,HOLDLOCK/);assert.match(transaction,/r.reviewed_at IS NULL/);assert.match(transaction,/di.label_status='DRAFT'/);
 assert.doesNotMatch(transaction,/UPDATE dbo.DatasetItem|INSERT dbo.Annotation|DELETE FROM dbo.Annotation|SET label_status/);
 assert.equal(f.calls(),1);
});
test('concurrent human review wins over an inference result',async t=>{
 const f=await setup(t,{saved:false});await assert.rejects(f.service.suggest(8,{user_id:2,role:'operator'}),{status:409});
});
test('reviewed photos and an aborted request never invoke the VLM',async t=>{
 const f=await setup(t,{state:{label_status:'VERIFIED'}});await assert.rejects(f.service.suggest(8,{user_id:2,role:'operator'}),{status:409});assert.equal(f.calls(),0);
 const aborted=await setup(t);await assert.rejects(aborted.service.suggest(8,{user_id:2,role:'operator'},{},{signal:AbortSignal.abort()}));assert.equal(aborted.calls(),0);assert.ok(aborted.sql.every(query=>query.startsWith('SELECT ')));
});
test('pseudo path uses trained YOLO without calling VLM and rejects a missing model',async t=>{
 const f=await setup(t);const result=await f.service.suggest(8,{user_id:2,role:'operator'},{method:'PSEUDO'});assert.equal(result.method,'PSEUDO');assert.equal(f.calls(),0);
 const missing=await setup(t);missing.ctx.detectRig=async()=>({available:false});await assert.rejects(missing.service.suggest(8,{user_id:2,role:'operator'},{method:'PSEUDO'}),{status:409});
});
test('AI failures do not save a proposal or touch labels',async t=>{
 const f=await setup(t,{methodFailure:true});await assert.rejects(f.service.suggest(8,{user_id:2,role:'operator'}));assert.ok(f.sql.every(query=>query.startsWith('SELECT ')));
});
