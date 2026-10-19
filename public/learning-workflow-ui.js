(() => {
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const post=body=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const parse=value=>{try{return typeof value==='string'?JSON.parse(value):value||[];}catch{return[];}};
  const jobNames={QUEUED:'Menunggu',RUNNING:'Membuat usulan',COMPLETED:'Usulan selesai',COMPLETED_WITH_ERRORS:'Selesai, sebagian perlu dicoba ulang',FAILED:'Proses belum berhasil',CANCELLED:'Dihentikan',INTERRUPTED:'Terhenti saat aplikasi dimulai ulang'};
  function mount({root,api,user,onError=()=>{},onModels=()=>{}}) {
    let destroyed=false,busy=false,jobBusy=false,uploading=false,status='pending',offset=0,timer=null,items=[],stats={},rigAvailable=false,lastJob=null;
    const selected=new Set();
    root.innerHTML=`<div class="page-head"><div><p class="eyebrow">DATA PEMBELAJARAN</p><h1>Belajar dari foto</h1><p class="page-subtitle">AI menyiapkan usulan. Anda cukup memeriksa, mengoreksi, lalu memverifikasi.</p></div><div class="learning-actions"><button class="btn btn-primary" data-learning-add>+ Tambah foto</button><button class="btn btn-secondary" data-learning-refresh>Muat ulang</button></div></div>
      <ol class="learning-steps"><li><b>1</b><span>Tambah foto<small>Pilih area & kelompok</small></span></li><li><b>2</b><span>Usulan AI<small>Satu atau banyak foto</small></span></li><li><b>3</b><span>Koreksi & verifikasi<small>Label tetap diperiksa</small></span></li><li><b>4</b><span>Latih & evaluasi<small>Setelah data siap</small></span></li></ol>
      <div data-learning-stats class="learning-stats"></div>
      <details class="learning-upload-details" data-upload-panel><summary>Tambah foto ke antrean pembelajaran</summary><div class="learning-grid"><article><form data-learning-upload>
        <label class="inline-label" for="learn-dataset">Dataset tujuan</label><select class="select-field" id="learn-dataset" name="dataset_id" required></select>
        <label class="inline-label" for="learn-area">Area / peralatan yang difoto</label><select class="select-field" id="learn-area" name="work_area_id" required></select>
        <label class="inline-label" for="learn-group">Kelompok pengambilan</label><input class="field" id="learn-group" name="capture_group" maxlength="160" placeholder="Contoh: AU-15 · inspeksi pagi" required><p class="hint-text">Gunakan kelompok yang sama untuk foto dari satu kejadian.</p>
        <label class="inline-label" for="learn-file">Pilih foto</label><input class="field" id="learn-file" name="image" type="file" accept="image/jpeg,image/png,image/webp" multiple required><p class="hint-text">Maksimal 50 foto · JPG, PNG, WebP · 8 MB per foto.</p>
        <label class="dt-consent"><input type="checkbox" name="auto_propose" checked><span>Buat usulan AI setelah foto tersimpan.</span></label>
        <label class="dt-consent"><input type="checkbox" name="permission" required><span>Saya berwenang memakai foto ini untuk dataset internal.</span></label>
        <button class="btn btn-primary" type="submit">Tambah foto</button><p data-learning-upload-status role="status" aria-live="polite"></p></form></article>
        <aside class="learning-helper"><h3>Kurangi pekerjaan menandai foto</h3><ol><li>Unggah beberapa foto sekaligus; AI memprosesnya satu per satu.</li><li>Periksa usulan label. Geser kotak atau ubah ukuran yang kurang tepat.</li><li>Simpan koreksi, lalu verifikasi sebagai label manusia.</li></ol><p class="hint-text">Foto TRAIN terverifikasi dapat membantu Gemma sebagai contoh. Pelatihan YOLO dilakukan setelah dataset disetujui.</p><div class="learning-actions"><button class="btn btn-secondary" data-view="datasets">Kelola dataset</button><button class="btn btn-secondary" data-view="rig-dataset">Impor PDF rig</button></div></aside></div></details>
      <section class="card learning-queue"><div class="card-pad"><div class="learning-queue-head"><h2 class="card-title">Antrean pemeriksaan label</h2><div class="history-tabs" role="group" aria-label="Status label"><button data-learning-tab="pending" aria-pressed="true" class="is-active">Perlu ditinjau</button><button data-learning-tab="reviewed" aria-pressed="false">Menunggu verifikasi</button><button data-learning-tab="verified" aria-pressed="false">Terverifikasi</button></div></div>
        <p class="card-caption">Urutan prioritas mendahulukan foto yang membuat AI ragu, hasil model yang berbeda, dan kategori yang masih sedikit contoh.</p>
        <form class="learning-toolbar" data-learning-filters><input class="field" name="q" aria-label="Cari foto atau dataset" placeholder="Cari foto atau dataset…" maxlength="120"><select class="select-field" name="area" aria-label="Filter area"><option value="">Semua area</option></select><select class="select-field" name="sort" aria-label="Urutkan foto"><option value="priority">Prioritas tinjauan</option><option value="newest">Foto terbaru</option></select><button class="btn btn-secondary" type="submit">Tampilkan</button></form>
        <div data-learning-job></div><div class="dt-error" data-learning-error role="alert"></div>
        <div class="learning-selection" data-learning-selection><label><input type="checkbox" data-select-page> Pilih foto halaman ini</label><span data-selected-count>0 dipilih</span><select class="select-field" data-proposal-method aria-label="Metode usulan"><option value="HYBRID">Gemma + model rig bila tersedia</option><option value="VLM">Gemma · tanpa pelatihan baru</option><option value="PSEUDO" disabled>Model rig · usulan kotak</option></select><button class="btn btn-primary" data-start-proposals disabled>Buat usulan untuk pilihan</button><p>Foto diproses bergantian. Pemeriksaan AI lain menunggu sampai proses selesai atau dihentikan.</p></div>
        <div data-learning-items></div><div data-learning-pagination class="dataset-pagination"></div>
      </div></section>
      <details class="learning-training-details" data-training-panel><summary>Latih dan evaluasi model rig<small>Gunakan setelah label diverifikasi dan kelompok foto dibagi menjadi latih, validasi, dan uji.</small></summary><div data-rig-training></div><div class="learning-actions"><button class="btn btn-secondary" data-view="evaluation">Evaluasi Gemma</button><button class="btn btn-secondary" data-view="rig-dataset">Pembagian kelompok rig</button><button class="btn btn-secondary" data-view="protect-curation">Kurasi foto Protect</button></div></details>`;
    const form=root.querySelector('[data-learning-upload]'),filters=root.querySelector('[data-learning-filters]');
    const training=window.RigTrainingUI?.mount({root:root.querySelector('[data-rig-training]'),api,user});
    const error=message=>{if(!destroyed)root.querySelector('[data-learning-error]').textContent=message||'';};
    api('/api/ai/status').then(data=>{if(!destroyed)onModels(data);}).catch(()=>{});
    function selectionChanged() {
      const visible=items.filter(item=>item.label_status==='DRAFT' && item.dataset_status==='DRAFT' && item.work_area_id);
      root.querySelector('[data-selected-count]').textContent=selected.size+' dipilih';
      root.querySelector('[data-start-proposals]').disabled=!selected.size || jobBusy || uploading;
      const checkbox=root.querySelector('[data-select-page]');checkbox.disabled=!visible.length || jobBusy;
      checkbox.checked=visible.length>0 && visible.every(item=>selected.has(item.dataset_item_id));
      checkbox.indeterminate=selected.size>0 && !checkbox.checked;
      root.querySelector('[data-learning-selection]').classList.toggle('is-hidden',status!=='pending');
      root.querySelector('[data-proposal-method] option[value=PSEUDO]').disabled=!rigAvailable;
      if(!rigAvailable && root.querySelector('[data-proposal-method]').value==='PSEUDO')root.querySelector('[data-proposal-method]').value='HYBRID';
    }
    function renderItems() {
      root.querySelector('[data-learning-items]').innerHTML=items.length?`<div class="learning-photo-grid">${items.map(item=>{
        const eligible=item.label_status==='DRAFT' && item.dataset_status==='DRAFT' && item.work_area_id;
        const reasons=parse(item.priority_reasons),attention=item.has_proposal && item.review_priority>=75;
        const badge=item.label_status==='VERIFIED'?'Terverifikasi':item.label_status==='REVIEWED'?'Menunggu verifikasi':attention?'Perlu perhatian':item.has_proposal?'Usulan siap':'Belum ada usulan';
        return `<article class="learning-photo">${eligible?`<label class="learning-photo-check"><input type="checkbox" data-select-item="${item.dataset_item_id}" aria-label="Pilih ${esc(item.original_name)}" ${selected.has(item.dataset_item_id)?'checked':''} ${jobBusy?'disabled':''}></label>`:''}<img src="/api/media/${item.image_id}/thumbnail" alt="${esc(item.original_name)}" loading="lazy"><div class="learning-photo-body"><span class="role-tag">${esc(item.area_name||'Pilih area saat meninjau')}</span><h3>${esc(item.original_name)}</h3><p>${esc(item.dataset_name)} · ${{TRAIN:'Latih',VALIDATION:'Validasi',TEST:'Uji'}[item.split]}</p><span class="learning-priority ${attention?'attention':''}">${badge}</span>${reasons.length&&item.label_status==='DRAFT'?`<p class="learning-reason">${esc(reasons.slice(0,2).join(' · '))}</p>`:''}<div class="learning-card-actions">${item.dataset_status==='DRAFT'?`<button class="btn btn-secondary" data-learn-review="${item.dataset_item_id}">${item.label_status==='DRAFT'?(item.has_proposal?'Periksa usulan':'Periksa foto'):'Ubah label'}</button>`:''}${item.label_status==='REVIEWED'&&!item.needs_review?`<button class="btn btn-primary" data-learn-verify="${item.dataset_item_id}">Verifikasi</button>`:''}</div></div></article>`;
      }).join('')}</div>`:'<div class="learning-empty"><strong>Tidak ada foto pada pilihan ini</strong><p>Tambahkan foto baru atau ubah filter untuk melanjutkan.</p></div>';
      selectionChanged();
    }
    async function refresh() {
      if(destroyed || busy)return;busy=true;error('');
      try {
        const query=new URLSearchParams({status,offset:String(offset),q:filters.elements.q.value,area:filters.elements.area.value,sort:filters.elements.sort.value});
        const [data,areas]=await Promise.all([api('/api/learning?'+query),api('/api/areas')]);if(destroyed)return;
        items=data.items;stats=data.stats||{};rigAvailable=Boolean(data.rig_model?.available);training?.setDatasets(data.datasets);
        for(const [selector,options,empty] of [['[name=dataset_id]',data.datasets.filter(d=>d.status==='DRAFT'),'Buat dataset Draft dahulu'],['[name=work_area_id]',areas.areas,'Pilih area…']]) {
          const select=form.querySelector(selector),old=select.value;
          select.innerHTML=(selector.includes('work_area')?'<option value="">Pilih area…</option>':'')+options.map(value=>`<option value="${value.dataset_id||value.work_area_id}">${esc(value.name)}</option>`).join('')||`<option value="">${empty}</option>`;
          if([...select.options].some(option=>option.value===old))select.value=old;
        }
        const oldArea=filters.elements.area.value;filters.elements.area.innerHTML='<option value="">Semua area</option>'+areas.areas.map(a=>`<option value="${a.work_area_id}">${esc(a.name)}</option>`).join('');filters.elements.area.value=oldArea;
        form.querySelector('[type=submit]').disabled=uploading || !data.datasets.some(d=>d.status==='DRAFT');
        root.querySelector('[data-learning-stats]').innerHTML=[['pending','Perlu ditinjau'],['reviewed','Menunggu verifikasi'],['verified','Terverifikasi'],['example_count','Calon contoh Gemma']].map(([key,title])=>`<div class="card"><span>${title}</span><strong>${Number(stats[key])||0}</strong></div>`).join('');
        root.querySelectorAll('[data-learning-tab]').forEach(button=>{const active=button.dataset.learningTab===status;button.classList.toggle('is-active',active);button.setAttribute('aria-pressed',String(active));});
        selected.forEach(id=>{if(!items.some(item=>item.dataset_item_id===id))selected.delete(id);});renderItems();
        root.querySelector('[data-learning-pagination]').innerHTML=`<p>${data.total?`${offset+1}–${Math.min(offset+24,data.total)} dari ${data.total} foto`:'0 foto'}</p><div><button class="btn btn-secondary" data-learn-page="${Math.max(0,offset-24)}" ${offset===0?'disabled':''}>Sebelumnya</button><button class="btn btn-secondary" data-learn-page="${offset+24}" ${offset+24>=data.total?'disabled':''}>Berikutnya</button></div>`;
      } catch(e){error(e.message);onError(e);}finally{busy=false;}
    }
    async function refreshJobs() {
      clearTimeout(timer);if(destroyed)return;
      try {
        const data=await api('/api/annotation-jobs');if(destroyed)return;
        const previous=jobBusy;lastJob=data.jobs.find(job=>['QUEUED','RUNNING'].includes(job.status))||data.jobs[0]||null;
        jobBusy=Boolean(lastJob&&['QUEUED','RUNNING'].includes(lastJob.status));rigAvailable=Boolean(data.rig_model?.available);
        const holder=root.querySelector('[data-learning-job]');
        holder.innerHTML=lastJob?`<section class="learning-job"><div class="card-title-row"><div><h3 class="card-title">${esc(jobNames[lastJob.status]||lastJob.status)}</h3><p>${lastJob.completed} berhasil · ${lastJob.failed} perlu dicoba ulang · ${lastJob.total} foto dipilih</p></div>${jobBusy?`<button type="button" class="btn btn-secondary" data-cancel-proposals="${lastJob.id}">Hentikan</button>`:''}</div><progress max="${lastJob.total}" value="${lastJob.items.filter(item=>['COMPLETED','FAILED','CANCELLED','INTERRUPTED'].includes(item.status)).length}"></progress>${jobBusy?'<p>Hasil yang sudah selesai tetap tersimpan jika proses dihentikan.</p>':lastJob.completed?'<p>Buka Periksa usulan untuk mengoreksi hasil sebelum memverifikasi label.</p>':'<p>Belum ada usulan baru. Pilih foto untuk memulai atau mencoba lagi.</p>'}${lastJob.error?`<p class="dt-error">${esc(lastJob.error)}</p>`:''}${lastJob.items.some(item=>item.error)?`<details><summary>Lihat foto yang perlu dicoba ulang</summary><ul>${lastJob.items.filter(item=>item.error).map(item=>`<li>Foto #${item.dataset_item_id}: ${esc(item.error)}</li>`).join('')}</ul></details>`:''}</section>`:'';
        selectionChanged();root.querySelectorAll('[data-select-item]').forEach(input=>{input.disabled=jobBusy;});
        if(previous&&!jobBusy){selected.clear();await refresh();}
        if(jobBusy&&!document.hidden)timer=setTimeout(refreshJobs,2500);
      } catch(e){error(e.message);}
    }
    async function startProposals(ids,method='HYBRID') {
      const result=await api('/api/annotation-jobs',post({item_ids:ids,method}));
      if(destroyed)return;lastJob=result;jobBusy=true;selectionChanged();await refreshJobs();
    }
    async function click(event) {
      const button=event.target.closest('button');if(!button||destroyed)return;
      try {
        if(button.hasAttribute('data-learning-add')){const panel=root.querySelector('[data-upload-panel]');panel.open=true;panel.scrollIntoView({behavior:'smooth',block:'start'});}
        else if(button.dataset.learningTab){if(busy)return;status=button.dataset.learningTab;offset=0;selected.clear();await refresh();}
        else if(button.hasAttribute('data-learn-page')){if(busy)return;offset=Number(button.dataset.learnPage);selected.clear();await refresh();}
        else if(button.hasAttribute('data-learning-refresh')){await refresh();await refreshJobs();}
        else if(button.dataset.learnReview)await window.DatasetToolsUI.openImport({datasetItemId:Number(button.dataset.learnReview),api,onSaved:refresh});
        else if(button.dataset.learnVerify){button.disabled=true;await api(`/api/dataset-items/${button.dataset.learnVerify}/verify`,{method:'PATCH'});await refresh();}
        else if(button.hasAttribute('data-start-proposals')){button.disabled=true;await startProposals([...selected],root.querySelector('[data-proposal-method]').value);}
        else if(button.dataset.cancelProposals){button.disabled=true;await api(`/api/annotation-jobs/${button.dataset.cancelProposals}/cancel`,post({}));await refreshJobs();}
      } catch(e){error(e.message);}finally{if(button.isConnected)button.disabled=false;selectionChanged();}
    }
    function change(event) {
      if(event.target.hasAttribute('data-select-page')) {
        for(const item of items.filter(item=>item.label_status==='DRAFT'&&item.dataset_status==='DRAFT'&&item.work_area_id))event.target.checked?selected.add(item.dataset_item_id):selected.delete(item.dataset_item_id);
        root.querySelectorAll('[data-select-item]').forEach(input=>{input.checked=selected.has(Number(input.dataset.selectItem));});selectionChanged();
      } else if(event.target.dataset.selectItem){const id=Number(event.target.dataset.selectItem);event.target.checked?selected.add(id):selected.delete(id);selectionChanged();}
    }
    async function upload(event) {
      event.preventDefault();if(uploading||destroyed)return;error('');
      const files=[...form.elements.image.files],notice=root.querySelector('[data-learning-upload-status]');
      if(!files.length || files.length>50 || files.some(file=>file.size>8*1024*1024)){error('Pilih 1–50 foto, masing-masing maksimal 8 MB.');return;}
      uploading=true;const controls=[...form.elements].map(element=>[element,element.disabled]),base=new FormData(form),ids=[],failures=[];let added=0;
      controls.forEach(([element])=>{element.disabled=true;});selectionChanged();
      try {
        for(let index=0;index<files.length;index++) {
          if(destroyed)break;
          notice.textContent=`Menyimpan foto ${index+1}/${files.length}…`;
          const body=new FormData();for(const [key,value] of base)if(key!=='image')body.append(key,value);body.append('image',files[index]);
          try {const result=await api('/api/learning/photos',{method:'POST',body});added++;if(result.label_status==='DRAFT')ids.push(result.dataset_item_id);}
          catch(e){failures.push(files[index].name+': '+e.message);}
        }
        if(destroyed)return;
        notice.textContent=`${added} foto tersimpan atau sudah ada.${failures.length?` ${failures.length} foto belum berhasil.`:''}`;
        if(!failures.length){form.elements.image.value='';form.elements.permission.checked=false;}else error(failures.slice(0,5).join(' · '));
        status='pending';offset=0;
        if(base.get('auto_propose')==='on'&&ids.length) {
          try{await startProposals([...new Set(ids)]);}catch(e){error('Foto tetap tersimpan. Usulan belum dimulai: '+e.message);}
        }
      } finally {uploading=false;controls.forEach(([element,disabled])=>{element.disabled=disabled;});selectionChanged();}
      await refresh();
    }
    async function filter(event){event.preventDefault();offset=0;selected.clear();await refresh();}
    function visibility(){clearTimeout(timer);if(!document.hidden)refreshJobs();}
    root.addEventListener('click',click);root.addEventListener('change',change);form.addEventListener('submit',upload);filters.addEventListener('submit',filter);document.addEventListener('visibilitychange',visibility);
    refresh();refreshJobs();
    return {destroy(){destroyed=true;clearTimeout(timer);training?.destroy();root.removeEventListener('click',click);root.removeEventListener('change',change);form.removeEventListener('submit',upload);filters.removeEventListener('submit',filter);document.removeEventListener('visibilitychange',visibility);}};
  }
  window.LearningUI=Object.freeze({mount});
})();
