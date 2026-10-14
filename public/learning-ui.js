(() => {
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function mount({root,api,user,onError=()=>{},onModels=()=>{}}) {
    api('/api/ai/status').then(data=>{if(!destroyed)onModels(data);}).catch(()=>{});
    let destroyed=false,busy=false,status='pending',offset=0;
    root.innerHTML=`<div class="page-head"><div><p class="eyebrow">PENGEMBANGAN MODEL</p><h1>Belajar dari foto</h1><p class="page-subtitle">Tambah foto rig yang belum dikenali, periksa labelnya, lalu verifikasi sebagai contoh.</p></div><div class="learning-actions"><button class="btn btn-primary" data-learning-train>Latih model rig</button><button class="btn btn-secondary" data-learning-refresh>Muat ulang</button></div></div>
      <ol class="learning-steps"><li><b>1</b><span>Tambah foto<small>PDF atau foto baru</small></span></li><li><b>2</b><span>Periksa & verifikasi<small>Label dari manusia</small></span></li><li><b>3</b><span>Gunakan sebagai contoh<small>Pemeriksaan berikutnya</small></span></li><li><b>4</b><span>Latih model rig<small>Latih, evaluasi, coba model</small></span></li></ol>
      <div data-learning-stats class="learning-stats"></div>
      <div class="learning-grid"><article class="card card-pad"><h2 class="card-title">Tambah foto baru</h2><p class="card-caption">Bisa langsung ditambahkan tanpa menunggu analisis AI.</p><form data-learning-upload>
        <label class="inline-label" for="learn-dataset">Dataset tujuan</label><select class="select-field" id="learn-dataset" name="dataset_id" required></select>
        <label class="inline-label" for="learn-area">Area / peralatan yang difoto</label><select class="select-field" id="learn-area" name="work_area_id" required></select>
        <label class="inline-label" for="learn-group">Kelompok pengambilan</label><input class="field" id="learn-group" name="capture_group" maxlength="160" placeholder="Contoh: AU-15 · 10 Oktober · inspeksi pagi" required><p class="hint-text">Foto dari rig dan kejadian yang sama harus tetap dalam satu kelompok saat membagi data.</p>
        <label class="inline-label" for="learn-file">Foto</label><input class="field" id="learn-file" name="image" type="file" accept="image/jpeg,image/png,image/webp" required><p class="hint-text">JPG, PNG, WebP · maksimal 8 MB per foto</p>
        <label class="dt-consent"><input type="checkbox" name="permission" required><span>Saya berwenang memakai foto ini untuk pembelajaran internal.</span></label><button class="btn btn-primary" type="submit">Tambah ke antrean</button><p data-learning-upload-status role="status"></p></form>
        <button class="quiet-link" data-view="datasets">Kelola / buat dataset →</button></article>
        <article class="card card-pad"><h2 class="card-title">Cara AI menggunakan foto Anda</h2><p class="learning-copy">Setelah label diverifikasi, foto TRAIN dari area yang sama dapat disertakan sebagai contoh visual saat Anda memeriksa foto berikutnya. Maksimal dua contoh dipakai untuk menjaga beban laptop.</p><div class="dt-notice">Menambah foto saja belum mengubah bobot model. Foto VALIDATION, TEST, label ragu, dan foto yang sedang diperiksa tidak menjadi contoh.</div><p class="learning-copy">Untuk melatih model baru, selesaikan label dan kotak bahaya, pisahkan kelompok rig, lalu ekspor data dan evaluasi model hasil pelatihan.</p><div class="learning-actions"><button class="btn btn-secondary" data-view="rig-dataset">Lihat PDF & pembagian rig</button><button class="btn btn-secondary" data-view="evaluation">Evaluasi model</button></div></article></div>
      <section class="card learning-queue"><div class="card-pad"><h2 class="card-title">Antrean pembelajaran</h2><div class="history-tabs" role="group" aria-label="Status label"><button data-learning-tab="pending" aria-pressed="true" class="is-active">Belum ditinjau</button><button data-learning-tab="reviewed" aria-pressed="false">Menunggu verifikasi</button><button data-learning-tab="verified" aria-pressed="false">Terverifikasi</button></div><div data-learning-error class="dt-error" role="alert"></div><div data-learning-items></div><div data-learning-pagination class="dataset-pagination"></div></div></section>
      <div class="dt-notice">Ada foto Protect yang tidak relevan? Pisahkan melalui <button class="btn btn-secondary" type="button" data-view="protect-curation">Kurasi foto Protect</button> sebelum memberi label.</div><section class="card card-pad learning-readiness"><h2 class="card-title">Kesiapan pelatihan model</h2><p class="card-caption">Angka berikut menunjukkan kesiapan data, bukan akurasi model.</p><div data-learning-datasets></div></section><div data-rig-training></div>`;
    const training=window.RigTrainingUI?.mount({root:root.querySelector('[data-rig-training]'),api,user});
    const error=message=>{if(!destroyed)root.querySelector('[data-learning-error]').textContent=message;};
    async function refresh() {
      if(destroyed||busy)return;busy=true;error('');
      try {
        const [data,areas]=await Promise.all([api(`/api/learning?status=${status}&offset=${offset}`),api('/api/areas')]);
        if(destroyed)return;
        training?.setDatasets(data.datasets);
        const form=root.querySelector('[data-learning-upload]'),selected=form.querySelector('[name=dataset_id]').value;
        const drafts=data.datasets.filter(d=>d.status==='DRAFT');
        form.querySelector('[name=dataset_id]').innerHTML=drafts.map(d=>`<option value="${d.dataset_id}">${esc(d.name)}</option>`).join('')||'<option value="">Buat dataset Draft dahulu</option>';
        if(drafts.some(d=>String(d.dataset_id)===selected))form.querySelector('[name=dataset_id]').value=selected;
        const areaSelect=form.querySelector('[name=work_area_id]'),oldArea=areaSelect.value;
        areaSelect.innerHTML='<option value="">Pilih area…</option>'+areas.areas.map(a=>`<option value="${a.work_area_id}">${esc(a.name)}</option>`).join('');areaSelect.value=oldArea;
        form.querySelector('[type=submit]').disabled=!drafts.length;
        root.querySelector('[data-learning-stats]').innerHTML=[['pending','Belum ditinjau'],['reviewed','Menunggu verifikasi'],['verified','Terverifikasi'],['example_count','Memenuhi syarat contoh*']].map(([key,label])=>`<div class="card"><span>${label}</span><strong>${Number(data.stats?.[key])||0}</strong></div>`).join('');
        root.querySelector('[data-learning-items]').innerHTML=data.items.length?`<div class="learning-photo-grid">${data.items.map(item=>`<article class="learning-photo"><img src="/api/media/${item.image_id}/thumbnail" alt="${esc(item.original_name)}" loading="lazy"><div><span class="role-tag">${esc(item.area_name||'Area belum dipilih')}</span><h3>${esc(item.original_name)}</h3><p>${esc(item.dataset_name)} · ${{TRAIN:'Latih',VALIDATION:'Validasi',TEST:'Uji'}[item.split]}</p>${item.dataset_status==='DRAFT'?`<button class="btn btn-secondary" data-learn-review="${item.dataset_item_id}">${item.label_status==='DRAFT'?'Periksa foto':'Ubah label'}</button>`:''}${item.label_status==='REVIEWED'&&!item.needs_review?`<button class="btn btn-primary" data-learn-verify="${item.dataset_item_id}">Verifikasi</button>`:''}</div></article>`).join('')}</div>`:'<div class="empty-state"><div><strong>Antrean ini kosong</strong><p>Foto baru muncul pada tab Belum ditinjau.</p></div></div>';
        root.querySelector('[data-learning-pagination]').innerHTML=`<p>${data.total?`${offset+1}–${Math.min(offset+24,data.total)} dari ${data.total} foto`:'0 foto'}</p><div><button class="btn btn-secondary" data-learn-page="${Math.max(0,offset-24)}" ${offset===0?'disabled':''}>Sebelumnya</button><button class="btn btn-secondary" data-learn-page="${offset+24}" ${offset+24>=data.total?'disabled':''}>Berikutnya</button></div>`;
        root.querySelector('[data-learning-datasets]').innerHTML=data.datasets.map(d=>{
          const reasons=[];if(d.verified<d.total)reasons.push(`${d.total-d.verified} foto perlu label / izin terverifikasi`);
          if(!d.train_count)reasons.push('Belum ada contoh TRAIN');if(!d.validation_count)reasons.push('Belum ada VALIDATION');if(!d.test_count)reasons.push('Belum ada TEST');if(d.status!=='APPROVED')reasons.push('Dataset belum disetujui');
          return `<div class="learning-dataset"><div><strong>${esc(d.name)}</strong><p>${d.verified}/${d.total} terverifikasi · Latih ${d.train_count} · Validasi ${d.validation_count} · Uji ${d.test_count}</p><small>${esc(reasons.join(' · ')||'Data siap diekspor. Periksa kecukupan dan keseimbangan setiap kategori sebelum melatih.')}</small></div><button class="btn btn-secondary" data-dataset-items="${d.dataset_id}">Buka dataset</button></div>`;
        }).join('')+'<p class="hint-text">*Masih disaring saat analisis: file harus utuh, foto acuan tidak boleh muncul di VALIDATION/TEST, dan area harus sesuai. Evaluasi saat ini mengukur model dasar tanpa contoh tambahan.</p>';
      }catch(e){error(e.message);onError(e);}finally{busy=false;}
    }
    async function click(event) {
      const button=event.target.closest('button');if(!button||destroyed)return;
      if(button.hasAttribute('data-learning-train'))root.querySelector('[data-rig-training]')?.scrollIntoView({behavior:'smooth',block:'start'});
      else if(button.dataset.learningTab){if(busy)return;status=button.dataset.learningTab;offset=0;root.querySelectorAll('[data-learning-tab]').forEach(b=>{const active=b===button;b.classList.toggle('is-active',active);b.setAttribute('aria-pressed',String(active));});await refresh();}
      else if(button.hasAttribute('data-learn-page')){if(busy)return;offset=Number(button.dataset.learnPage);await refresh();}
      else if(button.hasAttribute('data-learning-refresh'))await refresh();
      else if(button.dataset.learnReview)await window.DatasetToolsUI.openImport({datasetItemId:Number(button.dataset.learnReview),api,onSaved:refresh});
      else if(button.dataset.learnVerify){button.disabled=true;try{await api(`/api/dataset-items/${button.dataset.learnVerify}/verify`,{method:'PATCH'});await refresh();}catch(e){error(e.message);}finally{if(button.isConnected)button.disabled=false;}}
    }
    const form=root.querySelector('[data-learning-upload]');
    async function upload(event){event.preventDefault();if(busy||destroyed)return;const file=form.querySelector('[name=image]').files[0];if(!file||file.size>8*1024*1024){error('Pilih foto maksimal 8 MB.');return;}busy=true;const button=form.querySelector('[type=submit]');button.disabled=true;try{const result=await api('/api/learning/photos',{method:'POST',body:new FormData(form)});if(destroyed)return;form.querySelector('[name=image]').value='';form.querySelector('[name=permission]').checked=false;root.querySelector('[data-learning-upload-status]').textContent=result.label_status==='DRAFT'?'Foto tersimpan. Lanjutkan dengan Periksa foto di antrean.':'Foto identik sudah ada. Label sebelumnya tetap tersimpan.';status=result.label_status==='VERIFIED'?'verified':result.label_status==='REVIEWED'?'reviewed':'pending';offset=0;root.querySelectorAll('[data-learning-tab]').forEach(b=>{const active=b.dataset.learningTab===status;b.classList.toggle('is-active',active);b.setAttribute('aria-pressed',String(active));});}catch(e){error(e.message);}finally{busy=false;if(button.isConnected)button.disabled=false;}await refresh();}
    root.addEventListener('click',click);form.addEventListener('submit',upload);refresh();
    return {destroy(){destroyed=true;training?.destroy();root.removeEventListener('click',click);form.removeEventListener('submit',upload);}};
  }
  window.LearningUI=Object.freeze({mount});
})();
