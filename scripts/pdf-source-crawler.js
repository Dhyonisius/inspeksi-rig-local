const decode=s=>s.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi,e=>{const value=e.slice(1,-1).toLowerCase();if(value[0]==='#'){const n=value[1]==='x'?parseInt(value.slice(2),16):parseInt(value.slice(1),10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';}return {amp:'&',quot:'"',apos:"'",lt:'<',gt:'>'}[value];});
function attr(tag,name){return decode(tag.match(new RegExp('\\b'+name+'\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))','i'))?.slice(1).find(v=>v!==undefined)||'');}
export async function discoverPdfSources(initial,read,signal,progress=()=>{}){
 const queue=[initial],visited=new Set(),pdfs=new Map(),errors=[];let expected=0;
 const canonical=(href,base)=>{const u=new URL(decode(href),base);u.hash='';return u.href;};
 while(queue.length){signal.throwIfAborted();const raw=queue.shift();if(visited.has(raw))continue;if(visited.size>=50)throw new Error('Batas 50 halaman sumber terlampaui; pengambilan tidak lengkap.');visited.add(raw);
  let resource;try{resource=await read(raw,signal);}catch(e){if(signal.aborted)throw e;errors.push({url:raw,error:e.message});continue;}
  if(resource.data.subarray(0,5).toString()==='%PDF-'){pdfs.set(resource.url,{url:resource.url,data:resource.data});progress({pages:visited.size,discovered:pdfs.size});continue;}
  if(/^\s*[\[{]/.test(resource.data.toString('utf8'))){
   const data=JSON.parse(resource.data.toString('utf8'));const rows=Array.isArray(data)?data:(data.reports||data.data||data.items);
   if(!Array.isArray(rows))throw new Error('API belum dikenali: perlu array reports/data/items yang berisi pdf_url atau download_url.');
   expected=Math.max(expected,Number(data.pagination?.total||data.total||0));
   for(const row of rows){const href=row.pdf_url||row.download_url||row.export_pdf_url;if(!href)continue;const url=canonical(href,resource.url);if(pdfs.size>=200&&!pdfs.has(url))throw new Error('Batas 200 PDF per putaran terlampaui.');const serialized=JSON.stringify(row);if(serialized.length>100000)throw new Error('Metadata satu laporan melebihi batas 100.000 karakter.');pdfs.set(url,{url,metadata:JSON.parse(serialized)});}
   const next=data.pagination?.next_url||data.next_url||data.links?.next;if(next){const url=canonical(next,resource.url);if(!visited.has(url)&&!queue.includes(url))queue.push(url);}
   progress({pages:visited.size,discovered:pdfs.size});continue;
  }
  const html=resource.data.toString('utf8'),base=resource.url;
  const count=html.replace(/<[^>]*>/g,' ').match(/Showing\s+rigs\s+\d+\s+to\s+\d+\s+of\s+(\d+)/i);expected=Math.max(expected,Number(count?.[1]||0));
  const tags=[...html.matchAll(/<(a|link)\b([^>]*?)(?:>([\s\S]*?)<\/a\s*>|\/?>)/gi)];let hasNext=false;
  for(const m of tags){const tag=m[0],href=attr(tag,'href');if(!href)continue;const text=(m[3]||'').replace(/<[^>]*>/g,' ').trim();const rel=attr(tag,'rel');
   const isPdf=/\bdata-export-pdf(?:\s|=|>)/i.test(tag)||attr(tag,'type').toLowerCase()==='application/pdf'||/\.pdf(?:[?#]|$)|export[^#]*pdf/i.test(href)||/export\s*pdf/i.test(text);
   const isNext=/\bnext\b/i.test(rel)||/^(?:next|berikutnya|selanjutnya|›|»|→)$/i.test(text)||/^(?:next|halaman berikutnya)/i.test(attr(tag,'aria-label'));
   let url;try{url=canonical(href,base);}catch{errors.push({url:href,error:'Tautan tidak valid.'});continue;}
   if(isPdf){if(pdfs.size>=200&&!pdfs.has(url))throw new Error('Batas 200 PDF per putaran terlampaui.');pdfs.set(url,{url});}
   else if(isNext){hasNext=true;if(!visited.has(url)&&!queue.includes(url))queue.push(url);}
  }
  if(!hasNext&&/<button\b(?![^>]*\bdisabled)[^>]*(?:aria-label=["'](?:Next|Halaman berikutnya)["']|data-page-next)[^>]*>/i.test(html))errors.push({url:base,error:'Pagination berupa tombol JavaScript memerlukan konektor khusus; tidak dianggap selesai.'});
  progress({pages:visited.size,discovered:pdfs.size});
 }
 if(expected&&pdfs.size<expected)errors.push({url:initial,error:`Hanya ${pdfs.size} PDF ditemukan dari ${expected} rig yang tercantum.`});
 if(!pdfs.size)throw new Error(errors[0]?.error||'Tautan Export PDF tidak ditemukan. Gunakan PDF langsung atau halaman dengan tautan Export PDF dan Next.');
 return {sources:[...pdfs.values()],pages:visited.size,errors,expected};
}
