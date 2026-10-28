import test,{after} from 'node:test';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createPdfHub,PDF_INTERVAL_MS,PDF_RETENTION_MS} from './pdf-hub.js';
import {discoverPdfSources} from './pdf-source-crawler.js';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtureDir=await fs.mkdtemp(path.join(os.tmpdir(),'inspection-pdf-fixture-'));
const fixture=path.join(fixtureDir,'dummy.pdf');
execFileSync(process.env.PYTHON_EXE||'python',[path.join(root,'scripts','crssc-dummy-pdf.py'),fixture,'--version','1992220'],{windowsHide:true});
const pdf=await fs.readFile(fixture);
after(()=>fs.rm(fixtureDir,{recursive:true,force:true}));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function setup(fetchImpl,intervalMs=50,now=Date.now){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'inspection-pdf-test-'));const hub=createPdfHub({root,privateDir:dir,jsonBody:async req=>req.body,sendJson:(res,status,body)=>{res.status=status;res.body=body;},httpError:(status,message)=>Object.assign(new Error(message),{status}),fetchImpl,intervalMs,now});const call=async(endpoint,body={},role='admin')=>{const res={};await hub.handle({method:'POST',body},res,new URL('http://localhost'+endpoint),{role});return res;};return {hub,call,dir,async clean(){await hub.stop();hub.dispose();await fs.rm(dir,{recursive:true,force:true});}};}
async function waitIdle(hub){for(let i=0;i<100;i++){if(!hub.status().busy)return;await pause(40);}throw new Error('Timeout');}
test('interval produksi 15 menit dan retensi PDF 3 jam',()=>{assert.equal(PDF_INTERVAL_MS,900000);assert.equal(PDF_RETENTION_MS,10800000);});
test('HTML export, ekstraksi non-NA, deduplikasi, persistensi tanpa PDF, scheduler dan Stop',async()=>{
 let calls=0;const ctx=await setup(async url=>{calls++;return new Response(String(url).endsWith('/export.pdf')?pdf:'<a data-export-pdf href="/export.pdf">Export PDF</a>',{headers:{'Content-Type':String(url).endsWith('/export.pdf')?'application/pdf':'text/html'}});},80);
 try{await ctx.call('/api/pdf-hub/config',{source_url:'http://localhost:5091/'});await ctx.call('/api/pdf-hub/start');await waitIdle(ctx.hub);const reports=await ctx.hub.list();assert.equal(reports.length,1);assert.equal(reports[0].items.length,12);assert.equal(reports[0].skipped_na,2);assert.equal(reports[0].photos,12);await fs.access(path.join(ctx.dir,'pdf-hub','documents',reports[0].id,'source.pdf'));
 await pause(250);await ctx.call('/api/pdf-hub/stop');assert.ok(calls>=4,'scheduler mengambil ulang');const stopped=calls;await pause(230);assert.equal(calls,stopped);assert.equal((await ctx.hub.list()).length,1);assert.equal(JSON.parse(await fs.readFile(path.join(ctx.dir,'pdf-hub','config.json'))).running,false);
 const answer=await ctx.call('/api/inspection-assistant',{message:'ringkasan',use_ai:false});assert.match(answer.body.answer,/12 item non-NA/);assert.match(answer.body.answer,/DUMMY/);
 }finally{await ctx.clean();}
});
test('Stop membatalkan pengambilan aktif dan mencegah commit',async()=>{
 let calls=0;const ctx=await setup(async(url,{signal})=>{calls++;return await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});});
 try{await ctx.call('/api/pdf-hub/config',{source_url:'http://localhost:5091/'});await ctx.call('/api/pdf-hub/start');await ctx.call('/api/pdf-hub/stop');assert.equal(ctx.hub.status().busy,false);assert.equal((await ctx.hub.list()).length,0);await pause(150);assert.equal(calls,1);}finally{await ctx.clean();}
});
test('host tidak diizinkan dan operator ditolak; redirect diperiksa ulang',async()=>{
 const ctx=await setup(async()=>new Response(null,{status:302,headers:{location:'http://169.254.169.254/latest'}}));
 try{await assert.rejects(ctx.call('/api/pdf-hub/config',{source_url:'file:///etc/passwd'}));await assert.rejects(ctx.call('/api/pdf-hub/config',{source_url:'http://localhost:5091/'},'operator'),{status:403});await ctx.call('/api/pdf-hub/config',{source_url:'http://localhost:5091/'});await assert.rejects(ctx.hub.run(),/Host sumber/);assert.equal((await ctx.hub.list()).length,0);}finally{await ctx.clean();}
});
test('chat VLM menerima fakta, foto relevan, dan riwayat percakapan',async()=>{
 let captured;const ctx=await setup(async(url,options)=>{if(String(url).endsWith('/api/chat')){captured=JSON.parse(options.body);return Response.json({model:'gemma3:4b',message:{content:'Jawaban uji dari dataset dummy'}});}return new Response(pdf,{headers:{'Content-Type':'application/pdf'}});});
 try{await ctx.call('/api/pdf-hub/config',{source_url:'http://localhost:5091/export.pdf'});await ctx.hub.run();const result=await ctx.call('/api/inspection-assistant',{message:'Bagaimana Accumulator Warning Sign?',history:[{role:'user',content:'Lihat laporan terbaru'}]});assert.equal(result.body.engine,'ollama');assert.ok(captured.messages.some(m=>m.images?.length));assert.ok(captured.messages.some(m=>m.content==='Lihat laporan terbaru'));assert.ok(captured.messages[0].content.includes('"item_count":12'));assert.ok(captured.messages[0].content.includes('"is_dummy":true'));}finally{await ctx.clean();}
});
function multiPage(raw){const u=new URL(raw),page=Number(u.searchParams.get('page')||1);return 'Showing rigs '+((page-1)*5+1)+' to '+Math.min(page*5,28)+' of 28 '+Array.from({length:Math.min(5,28-(page-1)*5)},(_,i)=>`<a data-export-pdf href="/export.pdf?rig=${(page-1)*5+i+1}">Export PDF</a>`).join('')+(page<6?`<a rel="next" href="/?page=${page+1}">Next</a>`:'<a rel="next" href="/">Next</a>');}
test('28 PDF di 6 halaman, link ganda dan loop pagination tidak menggandakan unduhan',async()=>{
 const downloads=[];const ctx=await setup(async raw=>{const u=new URL(raw);if(u.pathname==='/export.pdf'){downloads.push(u.href);return new Response(pdf);}return new Response(multiPage(raw)+'<a data-export-pdf href="/export.pdf?rig=1">Export PDF</a>',{headers:{'Content-Type':'text/html'}});});
 try{await ctx.call('/api/pdf-hub/config',{source_url:'http://localhost:5091/'});const result=await ctx.hub.run();assert.equal(result.complete,true);assert.equal(result.pages,6);assert.equal(result.discovered,28);assert.equal(result.imported,1);assert.equal(result.duplicates,27);assert.equal(new Set(downloads).size,28);assert.equal(downloads.length,28);}finally{await ctx.clean();}
});
test('PDF gagal tidak menghalangi rig lainnya dan tidak dilaporkan lengkap',async()=>{
 const ctx=await setup(async raw=>{const u=new URL(raw);if(u.pathname==='/export.pdf')return u.searchParams.get('rig')==='5'?new Response('failed',{status:503}):new Response(pdf);return new Response(multiPage(raw),{headers:{'Content-Type':'text/html'}});});
 try{await ctx.call('/api/pdf-hub/config',{source_url:'http://localhost:5091/'});const result=await ctx.hub.run();assert.equal(result.complete,false);assert.equal(result.failed,1);assert.equal(ctx.hub.status().progress.processed,28);assert.ok(result.errors[0].url.includes('rig=5'));assert.match(ctx.hub.status().last_error,/belum lengkap/);}finally{await ctx.clean();}
});
test('retensi menghapus hanya PDF setelah 3 jam; foto, metadata, chat dan Stop tetap aman',async()=>{
 let moment=Date.now();const ctx=await setup(async()=>new Response(pdf),50,()=>moment);
 try{await ctx.call('/api/pdf-hub/config',{source_url:'http://localhost:5091/export.pdf'});await ctx.hub.run();await ctx.hub.stop();const [r]=await ctx.hub.list();const folder=path.join(ctx.dir,'pdf-hub','documents',r.id),photo=path.join(folder,r.items[0].image_path);const before=await fs.readFile(photo);
 moment+=PDF_RETENTION_MS-1;assert.equal(await ctx.hub.cleanup(),0);await fs.access(path.join(folder,'source.pdf'));moment++;assert.equal(await ctx.hub.cleanup(),1);await assert.rejects(fs.access(path.join(folder,'source.pdf')));assert.deepEqual(await fs.readFile(photo),before);assert.equal((await ctx.hub.list())[0].items.length,12);const answer=await ctx.call('/api/inspection-assistant',{message:'jumlah',use_ai:false});assert.match(answer.body.answer,/12 item non-NA/);assert.equal(ctx.hub.status().running,false);
 }finally{await ctx.clean();}
});
test('Stop di PDF kedua menjaga PDF pertama dan mencegah PDF ketiga diunduh',async()=>{
 const downloads=[];const ctx=await setup(async(raw,{signal})=>{const u=new URL(raw);if(u.pathname!=='/export.pdf')return new Response('<a data-export-pdf href="/export.pdf?rig=1">PDF</a><a data-export-pdf href="/export.pdf?rig=2">PDF</a><a data-export-pdf href="/export.pdf?rig=3">PDF</a>',{headers:{'Content-Type':'text/html'}});downloads.push(u.searchParams.get('rig'));if(downloads.length===1)return new Response(pdf);return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));});
 try{await ctx.call('/api/pdf-hub/config',{source_url:'http://localhost:5091/'});await ctx.hub.start();for(let i=0;i<100&&downloads.length<2;i++)await pause(40);assert.equal(downloads.length,2);await ctx.hub.stop();await pause(100);assert.deepEqual(downloads,['1','2']);assert.equal((await ctx.hub.list()).length,1);assert.equal(ctx.hub.status().busy,false);}finally{await ctx.clean();}
});
test('API metadata paginasi ditemukan dan disimpan bersama bukti lokal',async()=>{
 const ctx=await setup(async raw=>{const u=new URL(raw);if(u.pathname==='/export.pdf')return new Response(pdf);const page=Number(u.searchParams.get('page')||1);return Response.json({data:[{rig:'DUMMY-IDB-08',pdf_url:'/export.pdf?report='+page,source_kind:'PHOTO_METADATA_AND_DAILY_PDF'}],pagination:{total:2,next_url:page===1?'/api/reports?page=2':null}});});
 try{await ctx.call('/api/pdf-hub/config',{source_url:'http://localhost:5091/api/reports'});const result=await ctx.hub.run();assert.equal(result.pages,2);assert.equal(result.discovered,2);assert.equal(result.complete,true);const [r]=await ctx.hub.list();assert.equal(r.source_metadata.source_kind,'PHOTO_METADATA_AND_DAILY_PDF');await fs.access(path.join(ctx.dir,'pdf-hub','documents',r.id,r.items[0].image_path));}finally{await ctx.clean();}
});
