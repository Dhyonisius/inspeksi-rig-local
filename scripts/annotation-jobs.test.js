import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAnnotationJobs } from './annotation-jobs.js';
const user={role:'operator',user_id:2};
const error=(status,message)=>Object.assign(new Error(message),{status});
async function setup(t,suggest) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'annotation-jobs-'));let locked=false;
 const jobs=createAnnotationJobs({privateDir:root,httpError:error,intValue:v=>{if(!Number.isSafeInteger(Number(v))||Number(v)<1)throw error(400,'id');return Number(v);},
  jsonBody:async r=>r.body,sendJson:(r,status,body)=>Object.assign(r,{status,body}),rigModelStatus:()=>({available:false}),
  withInferenceLock:(id,run)=>{if(locked)throw error(409,'busy');locked=true;return Promise.resolve().then(run).finally(()=>{locked=false;});}}, {suggest});
 await jobs.initialize();
 const invoke=async(route,method='GET',body={},actor=user)=>{const result={};await jobs({method,body},result,new URL(route,'http://localhost'),actor);return result;};
 async function finished() {for(let i=0;i<100;i++){const job=(await invoke('/api/annotation-jobs')).body.jobs[0];if(job && !['QUEUED','RUNNING'].includes(job.status))return job;await new Promise(r=>setTimeout(r,10));}throw new Error('Job did not finish: '+JSON.stringify(await Promise.all((await fs.readdir(path.join(root,'annotation-jobs'))).filter(n=>n.endsWith('.json')).map(n=>fs.readFile(path.join(root,'annotation-jobs',n),'utf8')))));}
 t.after(async()=>{jobs.stop();if(locked)await finished();assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(root,{recursive:true,force:true});});
 return {jobs,invoke,finished,root};
}
test('batch processes unique photos sequentially and preserves successful results after one failure',async t=>{
 let concurrent=0,peak=0;const order=[];
 const f=await setup(t,async id=>{concurrent++;peak=Math.max(peak,concurrent);order.push(id);await new Promise(r=>setTimeout(r,5));concurrent--;if(id===9)throw error(503,'offline');return{method:'VLM'};});
 const started=await f.invoke('/api/annotation-jobs','POST',{item_ids:[8,8,9,10]});assert.equal(started.status,202);
 const job=await f.finished();assert.equal(job.status,'COMPLETED_WITH_ERRORS');assert.equal(job.completed,2);assert.equal(job.failed,1);assert.deepEqual(order,[8,9,10]);assert.equal(peak,1);
});
test('cancellation aborts the current inference and does not start the next photo',async t=>{
 let began;const started=new Promise(resolve=>{began=resolve;});const calls=[];
 const f=await setup(t,async(id,actor,body,{signal})=>{calls.push(id);began();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));});
 const result=await f.invoke('/api/annotation-jobs','POST',{item_ids:[8,9]});await started;
 await f.invoke(`/api/annotation-jobs/${result.body.id}/cancel`,'POST');
 const job=await f.finished();assert.equal(job.status,'CANCELLED');assert.deepEqual(calls,[8]);assert.ok(job.items.every(item=>item.status==='CANCELLED'));
});
test('another user cannot list or cancel jobs and unavailable pseudo mode is rejected',async t=>{
 const f=await setup(t,async()=>({method:'VLM'}));const started=await f.invoke('/api/annotation-jobs','POST',{item_ids:[8]});await f.finished();
 assert.deepEqual((await f.invoke('/api/annotation-jobs','GET',{}, {role:'operator',user_id:3})).body.jobs,[]);
 await assert.rejects(f.invoke(`/api/annotation-jobs/${started.body.id}/cancel`,'POST',{}, {role:'operator',user_id:3}),{status:404});
 await assert.rejects(f.invoke('/api/annotation-jobs','POST',{item_ids:[8],method:'PSEUDO'}),{status:409});
 await assert.rejects(f.invoke('/api/annotation-jobs','POST',{item_ids:Array(51).fill(8)}),{status:400});
});
