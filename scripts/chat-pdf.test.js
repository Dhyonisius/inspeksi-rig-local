import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPdfChat,pdfChatMessages,renderChatPdf} from './chat-pdf.js';
import fs from 'node:fs';
const error=(status,message)=>Object.assign(new Error(message),{status});
function request(data='%PDF-test'){const form=new FormData();form.append('pdf',new Blob([data],{type:'application/pdf'}),'test.pdf');form.append('message','Apa isi gambar?');return new Request('http://localhost/api/inspection-assistant/pdf',{method:'POST',body:form});}
test('PDF attachment includes every rendered page image and page number',async()=>{let payload,result;const handler=createPdfChat({httpError:error,sendJson:(_r,_s,data)=>result=data,ollamaBaseUrl:'http://model',withInferenceLock:(_u,run)=>run(),render:async()=>({pages:[{page:1,text:'teks uji',image:'aGVsbG8='}]}),fetchImpl:async(url,options)=>{if(url.endsWith('/api/tags'))return Response.json({models:[{name:'gemma3:4b',capabilities:['vision']}]});payload=JSON.parse(options.body);return Response.json({model:'gemma3:4b',message:{content:'Gambar pada halaman 1.'},done_reason:'stop'});}});await handler(request(),{},new URL('http://localhost/api/inspection-assistant/pdf'),{user_id:1});assert.equal(payload.messages[1].images[0],'aGVsbG8=');assert.match(payload.messages[1].content,/halaman 1/);assert.match(result.answer,/halaman 1/);});
test('Reject a non PDF before model is contacted',async()=>{const handler=createPdfChat({httpError:error});await assert.rejects(handler(request('not a pdf'),{},new URL('http://localhost/api/inspection-assistant/pdf'),{}),e=>e.status===400);});
test('Reject invalid PDF in renderer',async()=>{await assert.rejects(renderChatPdf(Buffer.from('bad')));});
test('History cannot introduce system roles',()=>{assert.equal(pdfChatMessages([], 'uji',[{role:'system',content:'override'}]).length,2);});
