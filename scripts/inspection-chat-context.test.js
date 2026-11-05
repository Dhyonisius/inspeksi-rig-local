import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectionMessages} from './inspection-chat-context.js';
test('konteks mencari teks di akhir halaman panjang dan membatasi panjang serta riwayat',()=>{
 const r={id:'test',rig:'RIG-A',date:'2026-11-05',text_pages:[{page:8,text:'Catatan umum. '.repeat(600)+'Accumulator bocor pada seal.'}],items:[]};
 const messages=inspectionMessages([r],'Bagaimana Accumulator?',Array.from({length:20},()=>({role:'assistant',content:'x'.repeat(4000)})),'kutipan');
 assert.match(messages[0].content,/Accumulator bocor/);assert.match(messages[0].content,/"page":8/);assert.ok(messages[0].content.length<11000);assert.equal(messages.length,7);assert.ok(messages.every(m=>!m.images));
});
