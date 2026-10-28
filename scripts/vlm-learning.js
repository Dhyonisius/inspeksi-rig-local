import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
const target=i=>JSON.stringify(Object.fromEntries(['equipment','check_item','role','source_status','remark'].map(k=>[k,i[k]??null])));
const key=i=>digest(i.checksum+target(i));
export function createVlmLearning({root,privateDir,hub,jsonBody,sendJson,httpError}){
 const home=path.join(privateDir,'vlm-learning'),jobs=path.join(home,'jobs');fsSync.mkdirSync(jobs,{recursive:true});
 const python=process.env.VLM_TRAIN_PYTHON||(process.platform==='win32'?path.join(privateDir,'vlm-learning-env','Scripts','python.exe'):'');
 const configured=!!python&&fsSync.existsSync(python);let active=null,disposed=false,timer;
 let config={automatic:true},registry={checkpoints:{},trained:{},purged_photos:0,applied_jobs:{}};
 try{config={...config,...JSON.parse(fsSync.readFileSync(path.join(home,'config.json'),'utf8'))};}catch(e){if(e.code!=='ENOENT')throw e;}
 try{registry={...registry,...JSON.parse(fsSync.readFileSync(path.join(home,'registry.json'),'utf8'))};}catch(e){if(e.code!=='ENOENT')throw e;}
 for(const [code,value] of Object.entries(registry.trained))if(!code.includes(':')){registry.trained[value.scope+':'+code]=value;delete registry.trained[code];}
 const write=async(file,data)=>{const tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(data,null,2));await fs.rename(tmp,file);};
 const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
 let applying=Promise.resolve();
 async function adopt(jobDir){const operation=applying.catch(()=>{}).then(async()=>{
  const result=await read(path.join(jobDir,'result.json')),job=await read(path.join(jobDir,'job.json'));
  const adapter=path.resolve(result.adapter||''),expected=path.resolve(jobDir,'adapter');
  const semantic=result.semantic_evaluation;
  if(result.accepted!==true||result.weights_changed!==true||semantic?.passed!==true||!Number.isInteger(semantic.sample_count)||semantic.sample_count<2||!Array.isArray(semantic.expected)||semantic.expected.length!==semantic.sample_count||new Set(semantic.expected).size<2||JSON.stringify(semantic.expected)!==JSON.stringify(semantic.predictions)||![result.validation_loss,result.baseline_validation_loss,result.reloaded_validation_loss].every(Number.isFinite)||result.validation_loss>=result.baseline_validation_loss||Math.abs(result.reloaded_validation_loss-result.validation_loss)>.02||adapter!==expected||digest(await fs.readFile(path.join(adapter,'adapter_model.safetensors')))!==result.adapter_sha256)throw new Error('Checkpoint belum lulus evaluasi jawaban dan bobot; foto tidak dihapus.');
  const scope=result.dummy?'dummy':'real',accepted=new Set(result.trained_keys||[]);let purged=0;
  for(const sample of job.samples)if(accepted.has(sample.key))registry.trained[scope+':'+digest(sample.checksum+JSON.stringify(JSON.parse(sample.target)))]={scope,adapter,code:sample.checksum};
  for(const report of await hub.list()){
   let modified=false;
   for(const item of report.items){const known=registry.trained[(report.is_dummy?'dummy':'real')+':'+key(item)];if(known&&!item.image_purged){item.learning=item.learning||{status:'TRAINED',checkpoint:known.adapter,code:item.checksum,trained_at:new Date().toISOString()};modified=true;}}
   if(!modified)continue;
   // Commit learning receipts before deleting matching JPEGs. Untrained/evaluation images survive.
   const reportFile=path.join(privateDir,'pdf-hub','documents',report.id,'report.json');await write(reportFile,report);
   for(const checksum of new Set(report.items.filter(i=>i.learning?.status==='TRAINED').map(i=>i.checksum))){if(report.items.some(i=>i.checksum===checksum&&i.learning?.status!=='TRAINED'))continue;
    const photo=path.join(privateDir,'pdf-hub','documents',report.id,'images',checksum+'.jpg');try{await fs.unlink(photo);purged++;}catch(e){if(e.code!=='ENOENT')throw e;}
    for(const item of report.items)if(item.checksum===checksum)item.image_purged=true;
   }
   report.stored_photos=new Set(report.items.filter(i=>!i.image_purged).map(i=>i.checksum)).size;await write(reportFile,report);
  }
  registry.checkpoints[scope]={...result,job:path.basename(jobDir),accepted_at:new Date().toISOString()};registry.purged_photos+=purged;registry.applied_jobs[path.basename(jobDir)]=true;await write(path.join(home,'registry.json'),registry);return purged;
 });applying=operation;return operation;}
 async function queueSamples(dummy){const rows=[];const seen=new Set();for(const report of (await hub.list()).reverse()){
  if(report.is_dummy!==dummy)continue;
  for(const item of report.items){const code=key(item);if(item.image_purged||registry.trained[(dummy?'dummy':'real')+':'+code]||seen.has(code))continue;
   const image=path.join(privateDir,'pdf-hub','documents',report.id,'images',item.checksum+'.jpg');try{await fs.access(image);}catch{continue;}
   seen.add(code);rows.push({key:code,document_id:report.id,checksum:item.checksum,image,target:target(item)});
  }
 }return rows;}
 async function runChild(jobFile){return new Promise((resolve,reject)=>{const child=spawn(python,[path.join(root,'scripts','vlm-learn.py'),jobFile],{windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8',CUDA_VISIBLE_DEVICES:'',OMP_NUM_THREADS:'2',MKL_NUM_THREADS:'2',HF_HUB_DISABLE_TELEMETRY:'1'}});if(active)active.child=child;let errors='';child.stdout.resume();child.stderr.on('data',c=>errors=(errors+c).slice(-1500));const timeout=setTimeout(()=>child.kill(),16*60*1000);child.on('error',e=>{clearTimeout(timeout);reject(e);});child.on('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(new Error(errors||'Pelatihan berhenti; foto disimpan.'));});});}
 async function train(dummy=true){if(!configured)throw httpError(503,'Worker VLM belum disiapkan.');if(active)throw httpError(409,'Worker VLM sedang bekerja.');
  if(!dummy)throw httpError(409,'Model kecil lokal baru diuji untuk klasifikasi diagram dummy. Foto asli menunggu trainer yang divalidasi; foto tetap disimpan.');
  const rows=(await queueSamples(dummy)).slice(0,12);if(rows.length<4)throw httpError(409,'Menunggu minimal 4 foto baru untuk pelatihan dan evaluasi.');
  const id=new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID().slice(0,8),dir=path.join(jobs,id);await fs.mkdir(dir);
  const scope=dummy?'dummy':'real';const job={output:dir,cache:path.join(home,'base-model-cache'),samples:rows,dummy,previous_adapter:registry.checkpoints[scope]?.adapter,parent_pid:process.pid};await write(path.join(dir,'job.json'),job);registry.last_job=id;await write(path.join(home,'registry.json'),registry);active={id,dir,kind:'training'};
  runChild(path.join(dir,'job.json')).then(()=>adopt(dir)).catch(async e=>{await write(path.join(dir,'error.json'),{error:e.message});}).finally(()=>active=null);return {job:id};
 }
 async function status(){let progress=null;try{progress=await read(path.join(active?.dir||path.join(jobs,registry.last_job||'first-dummy'),'progress.json'));}catch{}
  if(!active&&['TRAINING','LOADING'].includes(progress?.stage))progress={...progress,stage:'INTERRUPTED',error:'Worker sudah tidak berjalan; foto tetap disimpan.'};
  const pendingDummy=(await queueSamples(true)).length,pendingReal=(await queueSamples(false)).length;
  return {configured,automatic:config.automatic,busy:!!active,active_job:active?.id,progress,checkpoints:registry.checkpoints,purged_photos:registry.purged_photos,pending_dummy:pendingDummy,pending_real:pendingReal,model:'HuggingFaceTB/SmolVLM-256M-Instruct',device:'cpu',cpu_threads:2,experimental:true,real_training_available:false};}
 async function tick(){if(disposed)return;if(config.automatic&&configured&&!active&&!hub.status().busy){try{for(const checkpoint of Object.values(registry.checkpoints))await adopt(path.join(jobs,checkpoint.job));if((await queueSamples(true)).length>=4)await train(true);}catch{}}
  if(!disposed){timer=setTimeout(tick,15*60*1000);timer.unref();}}
 // First completed local experiment is adopted after the same checkpoint checks.
 async function initialize(){for(const name of (await fs.readdir(jobs)).sort()){const dir=path.join(jobs,name);try{if(!registry.applied_jobs[name]&&fsSync.existsSync(path.join(dir,'result.json')))await adopt(dir);}catch(e){console.warn('[vlm-learning]',e.message);}}}
 async function handle(req,res,url,user){if(!url.pathname.startsWith('/api/vlm-learning'))return false;
  if(req.method==='GET'&&url.pathname==='/api/vlm-learning/status'){sendJson(res,200,await status());return true;}
  if(user.role!=='admin')throw httpError(403,'Pelatihan VLM dikelola administrator.');
  if(req.method==='POST'&&url.pathname==='/api/vlm-learning/train'){const body=await jsonBody(req);sendJson(res,202,await train(body.dummy!==false));return true;}
  if(req.method==='POST'&&url.pathname==='/api/vlm-learning/config'){const body=await jsonBody(req);config.automatic=body.automatic===true;await write(path.join(home,'config.json'),config);sendJson(res,200,{ok:true});return true;}
  if(req.method==='POST'&&url.pathname==='/api/vlm-learning/stop'){config.automatic=false;await write(path.join(home,'config.json'),config);active?.child?.kill();if(active)await write(path.join(active.dir,'progress.json'),{stage:'STOPPED',error:'Pelatihan dihentikan; foto tetap disimpan.'});sendJson(res,200,{ok:true});return true;}
  if(req.method==='POST'&&url.pathname==='/api/vlm-learning/predict'){
   if(active)throw httpError(409,'Tunggu pelatihan selesai sebelum menguji model.');const body=await jsonBody(req),checkpoint=registry.checkpoints[body.dummy===false?'real':'dummy'];if(!checkpoint)throw httpError(409,'Belum ada checkpoint yang diterima.');
   const binary=Buffer.from(String(body.image||'').replace(/^data:image\/[^;]+;base64,/,''),'base64');if(!binary.length||binary.length>3*1024*1024)throw httpError(400,'Foto maksimal 3 MiB.');
   const dir=path.join(jobs,'predict-'+crypto.randomUUID());await fs.mkdir(dir);const image=path.join(dir,'input.jpg');await fs.writeFile(image,binary);await write(path.join(dir,'job.json'),{predict:true,image,output:dir,task:checkpoint.task,labels:checkpoint.labels,cache:path.join(home,'base-model-cache'),previous_adapter:checkpoint.adapter,parent_pid:process.pid});active={id:path.basename(dir),dir,kind:'prediction'};
   try{await runChild(path.join(dir,'job.json'));sendJson(res,200,await read(path.join(dir,'prediction.json')));}finally{await fs.unlink(image).catch(()=>{});active=null;}return true;
  }
  throw httpError(404,'Endpoint pelatihan VLM tidak ditemukan.');
 }
 return {handle,status,adopt,initialize,enableScheduler(){timer=setTimeout(tick,15*60*1000);timer.unref();},dispose(){disposed=true;clearTimeout(timer);active?.child?.kill();}};
}
