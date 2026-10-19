import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const pattern = /^[a-f0-9-]{36}$/;
const running = new Set(['QUEUED','RUNNING']);
export function createAnnotationJobs(ctx, learning) {
  const directory = path.join(ctx.privateDir,'annotation-jobs');
  let current = null;
  const file = id => { if (!pattern.test(id || '')) throw ctx.httpError(400,'Proses usulan tidak valid.'); return path.join(directory,id+'.json'); };
  async function save(job) {
    await fs.mkdir(directory,{recursive:true});
    const target=file(job.id),temp=target+'.'+crypto.randomUUID()+'.tmp';
    try {
      await fs.writeFile(temp,JSON.stringify(job),{flag:'wx'});
      for(let attempt=0;;attempt++) {
        try {await fs.rename(temp,target);break;}
        catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=8)throw error;await new Promise(resolve=>setTimeout(resolve,20));}
      }
    }
    finally { await fs.unlink(temp).catch(()=>{}); }
  }
  async function read(id,user) {
    let job;
    try { const info=await fs.lstat(file(id));if(!info.isFile() || info.isSymbolicLink() || info.size>256*1024) throw Error();job=JSON.parse(await fs.readFile(file(id),'utf8')); }
    catch { throw ctx.httpError(404,'Proses usulan tidak ditemukan.'); }
    if (user && user.role!=='admin' && job.owner_user_id!==user.user_id) throw ctx.httpError(404,'Proses usulan tidak ditemukan.');
    return job;
  }
  async function run(state,user) {
    const {job,controller}=state;
    try {
      job.status='RUNNING';await save(job);
      for (const item of job.items) {
        if(controller.signal.aborted) break;
        item.status='RUNNING';job.current_item_id=item.dataset_item_id;await save(job);
        try {
          const proposal=await learning.suggest(item.dataset_item_id,user,{method:job.method},{signal:controller.signal,lockHeld:true});
          item.status='COMPLETED';item.method=proposal.method;
        } catch(error) {
          item.status=controller.signal.aborted?'CANCELLED':'FAILED';item.error=String(error.message).slice(0,300);
        }
        job.completed=job.items.filter(i=>i.status==='COMPLETED').length;
        job.failed=job.items.filter(i=>i.status==='FAILED').length;
        await save(job);
      }
      job.status=controller.signal.aborted?'CANCELLED':job.failed?'COMPLETED_WITH_ERRORS':'COMPLETED';
    } catch(error) { job.status=controller.signal.aborted?'CANCELLED':'FAILED';job.error=String(error.message).slice(0,300); }
    finally {
      job.items.forEach(item=>{if(['QUEUED','RUNNING'].includes(item.status))item.status=job.status==='CANCELLED'?'CANCELLED':'INTERRUPTED';});
      job.current_item_id=null;job.finished_at=new Date().toISOString();
      await save(job).catch(()=>{});if(current===state)current=null;
    }
  }
  async function handle(request,response,url,user) {
    if(!url.pathname.startsWith('/api/annotation-jobs'))return false;
    if(!['admin','operator'].includes(user?.role))throw ctx.httpError(403,'Akun tidak dapat mengelola usulan AI.');
    let match;
    if(request.method==='GET' && url.pathname==='/api/annotation-jobs') {
      const jobs=[];
      for(const name of (await fs.readdir(directory).catch(()=>[])).filter(n=>pattern.test(n.replace(/\.json$/,'')) && n.endsWith('.json'))) {
        try { jobs.push(await read(name.slice(0,-5),user)); } catch { /* Another user's job stays private. */ }
      }
      jobs.sort((a,b)=>b.created_at.localeCompare(a.created_at));
      ctx.sendJson(response,200,{jobs:jobs.slice(0,20),rig_model:ctx.rigModelStatus?.()||{available:false}});return true;
    }
    if(request.method==='POST' && url.pathname==='/api/annotation-jobs') {
      const body=await ctx.jsonBody(request);
      if(!body || !Array.isArray(body.item_ids) || body.item_ids.length<1 || body.item_ids.length>50)throw ctx.httpError(400,'Pilih 1–50 foto untuk usulan AI.');
      const ids=[...new Set(body.item_ids.map(id=>ctx.intValue(id,'Foto dataset')))];
      const method=String(body.method||'HYBRID').toUpperCase();
      if(!['VLM','HYBRID','PSEUDO'].includes(method))throw ctx.httpError(400,'Metode usulan tidak tersedia.');
      if(method==='PSEUDO' && !ctx.rigModelStatus?.().available)throw ctx.httpError(409,'Pilih model rig terlatih sebelum membuat usulan dengan model rig.');
      if(current)throw ctx.httpError(409,'Masih ada proses usulan. Tunggu atau hentikan proses tersebut.');
      const job={id:crypto.randomUUID(),owner_user_id:user.user_id,created_at:new Date().toISOString(),status:'QUEUED',method,
        total:ids.length,completed:0,failed:0,items:ids.map(dataset_item_id=>({dataset_item_id,status:'QUEUED'}))};
      const state={job,controller:new AbortController()};
      await save(job);
      // Reserve immediately, before returning 202, so a second job cannot race.
      try {
        const promise=ctx.withInferenceLock(user.user_id,()=>run(state,user));current=state;
        void Promise.resolve(promise).catch(async error=>{job.status='FAILED';job.error=error.message;await save(job).catch(()=>{});if(current===state)current=null;});
      } catch(error) {job.status='FAILED';job.error=error.message;await save(job);throw error;}
      ctx.sendJson(response,202,job);return true;
    }
    if(request.method==='POST' && (match=url.pathname.match(/^\/api\/annotation-jobs\/([a-f0-9-]+)\/cancel$/))) {
      const job=await read(match[1],user);
      if(current?.job.id===job.id && running.has(current.job.status))current.controller.abort(new Error('Usulan dihentikan oleh pengguna.'));
      ctx.sendJson(response,202,{ok:true,cancel_requested:current?.job.id===job.id});return true;
    }
    return false;
  }
  handle.initialize=async()=>{
    await fs.mkdir(directory,{recursive:true});
    for(const name of await fs.readdir(directory)) {
      if(!name.endsWith('.json') || !pattern.test(name.slice(0,-5)))continue;
      const job=await read(name.slice(0,-5)).catch(()=>null);
      if(job && running.has(job.status)){job.status='INTERRUPTED';job.finished_at=new Date().toISOString();job.items.forEach(i=>{if(running.has(i.status))i.status='INTERRUPTED';});await save(job);}
    }
  };
  handle.stop=()=>current?.controller.abort(new Error('Server dihentikan.'));
  return handle;
}
