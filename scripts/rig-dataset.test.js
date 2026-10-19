import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRigDataset } from './rig-dataset.js';
const admin={user_id:1,role:'admin'},operator={user_id:2,role:'operator'};
const error=(status,message)=>Object.assign(new Error(message),{status});
const literal=value=>`N'${String(value).replaceAll("'","''")}'`;
async function setup(t,query,extra={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'rig-pdf-test-'));
 t.after(async()=>{const target=path.resolve(root),tmp=path.resolve(os.tmpdir());assert.ok(target.startsWith(tmp+path.sep));await fs.rm(target,{recursive:true,force:true});});
 const privateDir=path.join(root,'data/private'),uploadDir=path.join(privateDir,'uploads'),prepared=path.join(privateDir,'rig-pdf/prepared');await fs.mkdir(uploadDir,{recursive:true});await fs.mkdir(path.join(prepared,'images'),{recursive:true});
 const image=Buffer.from([255,216,255,1,2,3]),sha=crypto.createHash('sha256').update(image).digest('hex'),pdfSha='a'.repeat(64);
 await fs.writeFile(path.join(prepared,'images',sha+'.jpg'),image);
 const manifest={schema_version:1,source:'PROTECT_RIG_PDF',dataset_name:'Fixture rig',version:'v1',documents:[{sha256:pdfSha,name:'test.pdf'}],items:[{checksum:sha,image_path:`images/${sha}.jpg`,source_id:'b'.repeat(64),occurrences:[{pdf_sha256:pdfSha,pdf_name:'test.pdf',rig_name:'AU-15',page:2,context:'100% COMPLETE'}]}]};
 await fs.writeFile(path.join(prepared,'manifest.json'),JSON.stringify(manifest));const sql=[];
 const ctx={root,privateDir,uploadDir,sqlText:literal,sqlAscii:literal,intValue:(v)=>{if(!Number.isSafeInteger(Number(v))||Number(v)<1)throw error(400,'id');return Number(v);},httpError:error,jsonBody:async request=>request.body,sendJson:(response,status,body)=>Object.assign(response,{status,body}),withDatasetReadLock:async(id,job)=>job(),jsonQuery:async statement=>{sql.push(statement);return statement.startsWith("SELECT checksum FROM dbo.RigPdfItemSuppression") ? [] : query(statement);}};
 Object.assign(ctx,extra);
 const handle=createRigDataset(ctx),invoke=async(route,method='GET',body={},user=admin)=>{const response={};await handle({method,body},response,new URL(route,'http://localhost'),user);return response;};return {root,privateDir,uploadDir,prepared,manifest,image,sha,handle,invoke,sql};
}
test('PDF import defaults to uncertain/draft and preserves source without interpreting checklist',async t=>{
 const f=await setup(t,sql=>sql.includes('DECLARE @id INT,@known')?{dataset_id:7,present:true,completed:false}:sql.includes('DECLARE @image INT')?{dataset_item_id:8,new_image:true,locked:false}:{ok:1});
 const result=await f.handle.importPrepared(admin);assert.equal(result.status,'COMPLETED');assert.equal(result.imported,1);
 const insert=f.sql.find(s=>s.includes('DECLARE @image INT'));assert.match(insert,/'TRAIN','UNCERTAIN','DRAFT'/);assert.match(insert,/100% COMPLETE/);assert.doesNotMatch(insert,/'NO_LISTED_HAZARD_VISIBLE'/);
 const files=await fs.readdir(f.uploadDir);assert.equal(files.length,1);assert.deepEqual(await fs.readFile(path.join(f.uploadDir,files[0])),f.image);
});
test('deleted import checkpoint prevents resurrection and writes no photos',async t=>{
 const f=await setup(t,()=>({dataset_id:7,present:false,completed:true}));assert.equal((await f.handle.importPrepared(admin)).status,'DELETED');assert.equal((await fs.readdir(f.uploadDir)).length,0);assert.equal(f.sql.length,2);
});
test('checksum mismatch stops before item insertion',async t=>{
 const f=await setup(t,()=>({dataset_id:7,present:true,completed:false}));await fs.writeFile(path.join(f.prepared,f.manifest.items[0].image_path),'changed');const result=await f.handle.importPrepared(admin);assert.equal(result.status,'FAILED');assert.match(result.error,/Checksum/);assert.equal((await fs.readdir(f.uploadDir)).length,0);
});
test('operator cannot import PDFs or change whole-document splits',async t=>{
 const f=await setup(t,()=>null);await assert.rejects(f.invoke('/api/rig-pdf/import','POST',{},operator),{status:403});await assert.rejects(f.invoke('/api/datasets/7/training-groups','POST',{},operator),{status:403});assert.equal(f.sql.length,0);
});
test('curation requires consent and actual hazard boxes before SQL mutation',async t=>{
 const f=await setup(t,()=>null);await assert.rejects(f.invoke('/api/dataset-items/8/training-review','POST',{overall_label:'RISK',description:'Broken cable',license_confirmed:true,annotations:[]}),{status:400});await assert.rejects(f.invoke('/api/dataset-items/8/training-review','POST',{overall_label:'UNCERTAIN',description:'Unclear',annotations:[]}),{status:400});assert.equal(f.sql.length,0);
});
test('review records a human-reviewed label and invalidates prior verification',async t=>{
 const f=await setup(t,sql=>sql.startsWith('SELECT hazard_type_id')?[]:{found:true,dataset_status:'DRAFT'});const result=await f.invoke('/api/dataset-items/8/training-review','POST',{work_area_id:7,overall_label:'NO_LISTED_HAZARD_VISIBLE',description:'No visible hazard in this image',license_confirmed:true,annotations:[]});assert.equal(result.body.label_status,'REVIEWED');assert.match(f.sql.at(-1),/verified_by_user_id=NULL/);assert.match(f.sql.at(-1),/reviewed_at=SYSUTCDATETIME/);
});
test('split changes update every photograph in a source group under draft lock',async t=>{
 const f=await setup(t,()=>({changed:20,dataset_status:'DRAFT'}));const group='pdf:'+'a'.repeat(64);const result=await f.invoke('/api/datasets/7/training-groups','POST',{group_key:group,split:'TEST'});assert.equal(result.body.changed,20);assert.match(f.sql[0],/source_group_key=/);assert.match(f.sql[0],/UPDLOCK,HOLDLOCK/);
});

test('proposal endpoint delegates to the shared service without writing human labels',async t=>{
 let call;
 const f=await setup(t,()=>null,{annotationLearning:{suggest:async(...args)=>{call=args;return {human_reviewed:false,annotations:[],overall_label:'UNCERTAIN'};}}});
 const result=await f.invoke('/api/dataset-items/8/ai-proposal','POST',{work_area_id:7},operator);
 assert.equal(result.body.label_saved,false);assert.equal(result.body.verified,false);assert.equal(call[0],8);assert.equal(call[1],operator);assert.deepEqual(call[2],{work_area_id:7});assert.equal(f.sql.length,0);
});
