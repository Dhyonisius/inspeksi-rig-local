const text=value=>String(value??'').trim();
const status=value=>text(value).toUpperCase().replace(/[\s-]+/g,'_');
export function buildInspectionWarnings(reports){
 const seen=new Set(),latest=[...reports].sort((a,b)=>text(b.date).localeCompare(text(a.date))||text(b.imported_at).localeCompare(text(a.imported_at))).filter(r=>{if(seen.has(r.rig))return false;seen.add(r.rig);return true;});
 const warnings=[];
 for(const report of latest)for(const item of report.items||[]){
  const sourceStatus=status(item.source_status),remark=text(item.remark);
  if(item.is_na||['NA','N/A','NOT_APPLICABLE'].includes(sourceStatus))continue;
  const noReplacement=/\b(?:tidak|tak|belum|jangan)\s+(?:(?:perlu|harus)\s+)?(?:di)?ganti\b|\b(?:tidak|belum)\s+perlu\s+penggantian\b|\b(?:no|without)\s+replacement\b|\b(?:not|doesn['’]?t|do\s+not)\s+(?:(?:need|require|requires)\s+)?(?:replacement|replac\w*)\b|\b(?:sudah|telah)\s+(?:di)?ganti\b|\balready\s+replaced\b|\breplacement\s+(?:done|completed)\b/i.test(remark);
  const explicitReplacement=item.replacement_required===true||['REPLACE','REPLACEMENT','GANTI','PERLU_DIGANTI'].includes(status(item.recommended_action))||['NEEDS_REPLACEMENT','REPLACE_REQUIRED','REPLACEMENT_REQUIRED'].includes(sourceStatus);
  const replacement=explicitReplacement||(!noReplacement&&/\b(?:perlu|harus|wajib)\s+(?:di\s*)?ganti\b|\b(?:perlu|memerlukan|butuh|lakukan)\s+penggantian\b|\b(?:needs?|requires?)\s+(?:to\s+be\s+replaced|replacement)\b|(?:^|[.;:]\s*)\s*(?:replace|ganti)\b/i.test(remark));
  const notReady=['NOT_READY','NOTREADY','TIDAK_SIAP','BELUM_SIAP'].includes(sourceStatus)||(/\bnot\s+ready\b|\b(?:tidak|belum)\s+siap\b/i.test(remark)&&!['READY','SIAP'].includes(sourceStatus));
  if(!notReady&&!replacement)continue;
  warnings.push({id:report.id+':'+(item.id||item.checksum||warnings.length),document_id:report.id,rig:report.rig,date:report.date,imported_at:report.imported_at,is_dummy:!!report.is_dummy,equipment:text(item.equipment)||'Peralatan belum disebutkan',check_item:text(item.check_item),role:text(item.role),page:item.page,source_status:text(item.source_status)||'RECORDED',remark,not_ready:notReady,replacement_required:replacement,replacement_basis:replacement?(explicitReplacement?'Penanda penggantian pada data sumber':'Catatan sumber menyebut penggantian'):null});
 }
 warnings.sort((a,b)=>Number(b.replacement_required)-Number(a.replacement_required)||a.rig.localeCompare(b.rig)||a.equipment.localeCompare(b.equipment));
 return {reports:latest.length,rigs:latest.map(r=>r.rig).sort(),total:warnings.length,not_ready:warnings.filter(w=>w.not_ready).length,replacement_required:warnings.filter(w=>w.replacement_required).length,dummy:warnings.some(w=>w.is_dummy),updated_at:latest.map(r=>r.imported_at).sort().at(-1)||null,warnings};
}
