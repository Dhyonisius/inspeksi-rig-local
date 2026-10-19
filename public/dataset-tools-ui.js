(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const label = value => ({ RISK: 'Ada indikasi bahaya', NO_LISTED_HAZARD_VISIBLE: 'Tidak tampak bahaya', UNCERTAIN: 'Belum yakin', POTENSI_TIDAK_AMAN: 'Ada indikasi bahaya', TIDAK_TAMPAK_BAHAYA: 'Tidak tampak bahaya', TIDAK_PASTI: 'Belum yakin' }[value] || value || '—');
  const date = value => value ? new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`).toLocaleString('id-ID') : '—';
  const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let activeImport;
  const pdfDescription = (candidates, ai) => [...new Set((candidates || []).map(candidate => String(candidate.name || '').trim()).filter(Boolean)), ai?.description?.trim()].filter(Boolean).join('\n').slice(0, 1200);
  function reviewDescription(value) {
    const text = String(value || '');
    // Only simplify the generated PDF template; keep free-form reviewer notes intact.
    if (!/^PDF:\s*\r?\n/.test(text)) return text;
    const body = text.replace(/^PDF:\s*\r?\n/, '');
    const aiHeader = /\r?\n\s*\r?\nAI \([^\r\n]+\) — perlu crosscheck:\s*\r?\n/.exec(body);
    const pdf = aiHeader ? body.slice(0, aiHeader.index) : body;
    const ai = aiHeader ? body.slice(aiHeader.index + aiHeader[0].length).trim() : '';
    const names = pdf.split(/\r?\n/).map(line => {
      const source = line.match(/^.+? — (.+?)(?: \[[^\]]+\])?(?: · [^\r\n()]+)? \(Rig [^\r\n]+, halaman \d+\)$/);
      return source ? source[1].trim() : line.trim();
    }).filter(line => line && line !== 'Ada konteks PDF lain; pilih sumber yang sesuai.');
    return [...new Set(names), ai].filter(Boolean).join('\n').slice(0, 1200);
  }
  async function openImport({ analysisId, datasetItemId, api, onSaved = () => {} }) {
    activeImport?.close();
    const dialog = document.createElement('dialog'); dialog.className = 'dt-dialog'; activeImport = dialog;
    dialog.setAttribute('aria-labelledby', 'dt-import-title');
    dialog.innerHTML = '<header><div><h2 id="dt-import-title">Masukkan ke dataset</h2><p>Memuat foto dan pilihan dataset…</p></div></header><div class="dt-body"><p>Menyiapkan data…</p></div><footer><button type="button" class="btn btn-secondary" data-cancel>Batal</button></footer>';
    document.body.append(dialog); dialog.showModal(); dialog.querySelector('[data-cancel]').focus();
    let busy = false;
    dialog.addEventListener('cancel', e => { if (busy) e.preventDefault(); });
    dialog.addEventListener('click', e => { if (e.target.closest('[data-cancel]') && !busy) dialog.close(); });
    dialog.addEventListener('close', () => { dialog.remove(); if (activeImport === dialog) activeImport = null; }, { once: true });
    try {
      const [detail, data, hazardsData, areaData] = await Promise.all([api(datasetItemId ? `/api/dataset-items/${datasetItemId}/training-review` : `/api/analyses/${analysisId}`), api('/api/datasets'), api('/api/hazard-types'),api('/api/areas')]);
      if (!dialog.isConnected) return;
      const datasets = data.datasets.filter(item => item.status === 'DRAFT' && item.dataset_kind !== 'PPE_OBJECT' && (!datasetItemId || item.dataset_id === detail.item.dataset_id));
      const hazards = (hazardsData.hazards || hazardsData.hazard_types || hazardsData || []).filter(item => item.is_active !== false && item.is_active !== 0);
      const proposal = datasetItemId && !detail.item.reviewed_at && detail.ai_draft ? detail.ai_draft : null;
      const predicted = detail.feedback?.corrected_label || detail.prediction?.predicted_status;
      const defaultLabel = proposal?.overall_label || detail.item?.overall_label || (['TIDAK_AMAN', 'POTENSI_TIDAK_AMAN'].includes(predicted) ? 'RISK' : predicted === 'TIDAK_TAMPAK_BAHAYA' ? 'NO_LISTED_HAZARD_VISIBLE' : 'UNCERTAIN');
      const pdfPrefill = datasetItemId && !detail.item.reviewed_at && !detail.item.curated_description ? detail.pdf_prefill : null;
      const initialArea = Number(detail.item?.review_work_area_id || detail.item?.image_work_area_id || proposal?.work_area_id || pdfPrefill?.work_area_id);
      const initialDescription = reviewDescription(detail.feedback?.notes || detail.item?.curated_description || detail.prediction?.summary || (pdfPrefill ? pdfDescription(pdfPrefill.candidates?.slice(0, 5), pdfPrefill.ai) : '') || proposal?.description || '');
      dialog.innerHTML = `<form data-import-form><header><div><p class="eyebrow">KURASI CONTOH</p><h2 id="dt-import-title">Koreksi menjadi contoh berlabel</h2><p>Periksa foto, tulis deskripsi, lalu tandai bagian yang berbahaya.</p></div></header><div class="dt-body"><section><div class="dt-preview"><img alt="Foto sumber untuk anotasi" src="/api/media/${Number(detail.analysis.image_id)}"><canvas aria-label="Tarik pada gambar untuk menandai bahaya"></canvas></div><p class="dt-muted">Periksa posisi dan kategori tiap kotak. Gunakan Gambar kotak untuk menambah penanda.</p><div class="dt-boxes"></div><div class="dt-notice">Label hasil AI dan koreksi pengguna ikut dicatat sebagai sumber. Foto ini baru masuk dataset setelah Anda menyimpan.</div></section><section class="dt-fields"><label for="dt-dataset">Dataset tujuan</label><select class="select-field" name="dataset_id" id="dt-dataset" required>${datasets.length ? datasets.map(d => `<option value="${d.dataset_id}">${esc(d.name)} · ${esc(d.version)}</option>`).join('') : '<option value="">Buat dataset DRAFT melalui Dataset foto</option>'}</select>${datasetItemId ? `<label for="dt-area">Area / peralatan yang difoto</label><select class="select-field" name="work_area_id" id="dt-area" required><option value="">Pilih area…</option>${areaData.areas.map(a=>`<option value="${a.work_area_id}" ${initialArea===Number(a.work_area_id)?'selected':''}>${esc(a.name)}</option>`).join('')}</select>` : ''}<label for="dt-label">Label yang benar</label><select class="select-field" name="overall_label" id="dt-label">${['RISK', 'NO_LISTED_HAZARD_VISIBLE', 'UNCERTAIN'].map(v => `<option value="${v}" ${v === defaultLabel ? 'selected' : ''}>${label(v)}</option>`).join('')}</select><label for="dt-split">Pembagian data</label><select class="select-field" name="split" id="dt-split"><option value="TRAIN">TRAIN · contoh pengembangan</option><option value="VALIDATION">VALIDATION · penyesuaian</option><option value="TEST">TEST · evaluasi terpisah</option></select><p class="dt-muted">Foto dari satu sesi kamera harus masuk pembagian yang sama pada dataset ini.</p><label for="dt-hazard">Kategori untuk kotak berikutnya</label><select class="select-field" id="dt-hazard"><option value="">Pilih kategori bahaya…</option>${hazards.map(h => `<option value="${h.hazard_type_id}">${esc(h.name)}</option>`).join('')}</select><label for="dt-description">Deskripsi yang telah diperiksa</label><textarea class="textarea-field" name="description" id="dt-description" rows="4" maxlength="1200" required placeholder="Jelaskan yang benar-benar tampak dalam foto">${esc(initialDescription)}</textarea><label class="dt-consent"><input name="license_confirmed" type="checkbox" required><span>Saya berwenang memakai foto ini untuk dataset internal dan sudah memeriksa isi serta labelnya.</span></label><div class="dt-error" role="alert"></div></section></div><footer><button class="btn btn-secondary" type="button" data-cancel>Batal</button><button class="btn btn-primary" type="submit" ${datasets.length ? '' : 'disabled'}>Simpan ke dataset</button></footer></form>`;
      const img = dialog.querySelector('img'), canvas = dialog.querySelector('canvas'), context = canvas.getContext('2d');
      const boxes = (detail.annotations?.length ? detail.annotations : proposal?.annotations || []).map(box => ({ ...box })); let start, draft;
      const submit = dialog.querySelector('[type=submit]'); submit.disabled = true;
      let editor = null;
      function areaHazards() {
        const type=datasetItemId ? areaData.areas.find(a=>a.work_area_id===Number(dialog.querySelector('#dt-area').value))?.area_type : detail.analysis.area_type;
        return hazards.filter(h=>!type || h.area_type===type || h.area_type==='KEDUANYA');
      }
      function updateHazards() {
        const select=dialog.querySelector('#dt-hazard'),old=select.value;
        select.innerHTML='<option value="">Pilih kategori bahaya…</option>'+areaHazards().map(h=>`<option value="${h.hazard_type_id}">${esc(h.name)}</option>`).join('');
        if(areaHazards().some(h=>String(h.hazard_type_id)===old))select.value=old;
        editor?.refresh();
      }
      dialog.querySelector('#dt-area')?.addEventListener('change',updateHazards); updateHazards();
      if (pdfPrefill) {
        const sourcePanel = document.createElement('div'); sourcePanel.className = 'dt-notice';
        sourcePanel.innerHTML = `<strong>Isian awal dari PDF${pdfPrefill.ai ? ' + AI yang tersedia' : ''}</strong><p>${esc(pdfPrefill.note)}</p>${pdfPrefill.ambiguous ? `<label for="dt-pdf-context">Pilih item checklist asal foto</label><select class="select-field" id="dt-pdf-context"><option value="">Pilih sumber yang sesuai…</option>${pdfPrefill.candidates.map((candidate, index) => `<option value="${index}">${esc(candidate.area_name)} · ${esc(candidate.name)} · ${esc(candidate.rig_name)} · hlm. ${candidate.page}</option>`).join('')}</select><p class="dt-muted">Memilih sumber akan mengisi ulang area dan deskripsi. Label serta kotak bahaya tetap perlu diperiksa.</p>` : `<p class="dt-muted">${esc(pdfPrefill.candidates[0].pdf_name)} · halaman ${pdfPrefill.candidates[0].page}</p>`}`;
        dialog.querySelector('label[for="dt-area"]').before(sourcePanel);
        sourcePanel.querySelector('select')?.addEventListener('change', event => {
          if (event.target.value === '' || busy) return;
          const candidate = pdfPrefill.candidates[Number(event.target.value)]; if (!candidate) return;
          if (candidate.work_area_id) dialog.querySelector('#dt-area').value = String(candidate.work_area_id);
          dialog.querySelector('#dt-description').value = pdfDescription([candidate], pdfPrefill.ai);
          updateHazards();
        });
      }

      function photoReady() { return img.naturalWidth > 0 && img.naturalHeight > 0; }
      function loaded() { draw(); submit.disabled = busy || !datasets.length || !photoReady(); }
      function draw() {
        canvas.width = img.naturalWidth || 1; canvas.height = img.naturalHeight || 1;
        context.clearRect(0, 0, canvas.width, canvas.height); context.lineWidth = Math.max(2, canvas.width / 350); context.strokeStyle = '#3c6db2'; context.fillStyle = '#3c6db220';
        [...boxes, ...(draft ? [draft] : [])].forEach((box,index) => {
          context.fillRect(box.x * canvas.width, box.y * canvas.height, box.width * canvas.width, box.height * canvas.height);
          context.strokeRect(box.x * canvas.width, box.y * canvas.height, box.width * canvas.width, box.height * canvas.height);
          const size=Math.max(14,canvas.width/45);context.font=`bold ${size}px sans-serif`;context.fillStyle='#244d83';
          context.fillText(String(index+1),box.x*canvas.width+5,Math.max(size,box.y*canvas.height-5));
          if(editor?.selectedIndex()===index)context.fillRect((box.x+box.width)*canvas.width-6,(box.y+box.height)*canvas.height-6,12,12);
          context.fillStyle='#3c6db220';
        });
      }
      function tags() { if(editor){editor.refresh();return;} dialog.querySelector('.dt-boxes').innerHTML = boxes.map((box, i) => `<button type="button" data-remove="${i}" aria-label="Hapus kotak ${i + 1}">${i + 1}. ${esc(hazards.find(h => Number(h.hazard_type_id) === box.hazard_type_id)?.name || 'Bahaya')} ×</button>`).join(''); }
      function point(e) { const r = canvas.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) }; }
      function rect(a, b) { return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }; }
      img.addEventListener('load', loaded);
      img.addEventListener('error', () => { submit.disabled = true; dialog.querySelector('.dt-error').textContent = 'Foto sumber belum dapat dimuat. Tutup dialog dan coba lagi sebelum memberi label.'; });
      if (img.complete && photoReady()) loaded();
      canvas.addEventListener('pointerdown', e => { if (busy) return; const hazard = Number(dialog.querySelector('#dt-hazard').value); if (!hazard) { dialog.querySelector('.dt-error').textContent = 'Pilih kategori bahaya sebelum menggambar kotak.'; return; } start = { ...point(e), hazard }; canvas.setPointerCapture(e.pointerId); });
      canvas.addEventListener('pointermove', e => { if (!start) return; draft = rect(start, point(e)); draw(); });
      canvas.addEventListener('pointerup', e => { if (!start) return; const box = rect(start, point(e)); if (box.width > .008 && box.height > .008) boxes.push({ ...box, hazard_type_id: start.hazard }); start = null; draft = null; draw(); tags(); });
      canvas.addEventListener('pointercancel', () => { start = null; draft = null; draw(); });
      dialog.addEventListener('click', e => { const b = e.target.closest('[data-remove]'); if (b && !busy) { boxes.splice(Number(b.dataset.remove), 1); draw(); tags(); } });
      editor = window.AnnotationEditorUI?.attach({container:dialog.querySelector('.dt-boxes'),canvas,boxes,draw,isBusy:()=>busy,getHazards:areaHazards});
      if (datasetItemId && detail.item.dataset_status === 'DRAFT' && detail.item.label_status === 'DRAFT' && !detail.item.reviewed_at && !proposal) {
        const panel = document.createElement('div'); panel.className = 'dt-notice';
        panel.innerHTML = '<strong>Bantuan label dari AI</strong><p>Pilih area foto, lalu minta AI mengusulkan label, deskripsi, dan kotak bahaya.</p><button type="button" class="btn btn-secondary" data-generate-proposal>Buat usulan AI</button><p data-proposal-status role="status" aria-live="polite"></p><button type="button" class="btn btn-secondary is-hidden" data-apply-proposal>Terapkan usulan</button><p class="dt-muted">Menerapkan usulan mengganti label, deskripsi, dan kotak di formulir ini. Periksa dan koreksi sebelum menyimpan.</p>';
        dialog.querySelector('.dt-fields').prepend(panel);
        const generate = panel.querySelector('[data-generate-proposal]'), apply = panel.querySelector('[data-apply-proposal]'), status = panel.querySelector('[data-proposal-status]');
        let pendingProposal = null;
        generate.addEventListener('click', async () => {
          if (busy) return;
          const areaId = Number(dialog.querySelector('#dt-area').value), error = dialog.querySelector('.dt-error');
          error.textContent = '';
          if (!areaId) { error.textContent = 'Pilih area foto sebelum membuat usulan AI.'; return; }
          if (!photoReady()) { error.textContent = 'Tunggu foto sumber selesai dimuat.'; return; }
          busy = true; start = null; draft = null; pendingProposal = null; apply.classList.add('is-hidden'); draw();
          const controls = [...dialog.querySelectorAll('button, input, select, textarea')].map(element => [element, element.disabled]);
          controls.forEach(([element]) => { element.disabled = true; });
          status.textContent = 'AI sedang memeriksa foto. Proses dapat memerlukan hingga 3 menit…';
          try {
            const result = await api(`/api/dataset-items/${datasetItemId}/ai-proposal`, post({ work_area_id: areaId }));
            if (!dialog.isConnected || activeImport !== dialog) return;
            pendingProposal = result.ai_draft;
            if (!pendingProposal || pendingProposal.human_reviewed !== false || !Array.isArray(pendingProposal.annotations)) throw new Error('Usulan AI belum dapat dibaca. Coba lagi.');
            status.textContent = `${pendingProposal.model}: ${label(pendingProposal.overall_label)} · ${pendingProposal.annotations.length} kotak. ${pendingProposal.description} ${(pendingProposal.review_notes||[]).join(' ')}`;
            apply.classList.remove('is-hidden');
          } catch (err) { if (dialog.isConnected) { status.textContent = 'Usulan belum berhasil dibuat. Anda tetap dapat mengisi label secara manual.'; error.textContent = err.message; } }
          finally { busy = false; controls.forEach(([element, disabled]) => { element.disabled = disabled; }); submit.disabled = !datasets.length || !photoReady(); }
        });
        apply.addEventListener('click', () => {
          if (busy || !pendingProposal) return;
          if (Number(dialog.querySelector('#dt-area').value) !== pendingProposal.work_area_id) {
            dialog.querySelector('.dt-error').textContent = 'Area telah berubah. Buat usulan baru untuk area yang dipilih.'; return;
          }
          dialog.querySelector('#dt-label').value = pendingProposal.overall_label;
          dialog.querySelector('#dt-description').value = pendingProposal.description;
          boxes.splice(0, boxes.length, ...pendingProposal.annotations.map(box => ({ ...box })));
          dialog.querySelector('[name=license_confirmed]').checked = false;
          dialog.querySelector('.dt-error').textContent = '';
          draw(); tags();
          status.textContent = 'Usulan diterapkan ke formulir. Periksa label, deskripsi, dan posisi kotak, lalu simpan hasil koreksi. Label belum terverifikasi. '+(pendingProposal.review_notes||[]).join(' ');
          apply.classList.add('is-hidden');
        });
      }
      if(proposal?.review_notes?.length) {
        const note=document.createElement('div');note.className='dt-notice';note.setAttribute('role','status');
        note.textContent=proposal.review_notes.join(' ');dialog.querySelector('.dt-fields').prepend(note);
      }
      dialog.querySelector('[data-import-form]').addEventListener('submit', async e => {
        e.preventDefault(); if (busy) return;
        const form = e.currentTarget, fd = new FormData(form), error = dialog.querySelector('.dt-error'); error.textContent = '';
        if (!photoReady()) { error.textContent = 'Tunggu foto sumber selesai dimuat sebelum menyimpan label.'; return; }
        if(boxes.some(box=>!areaHazards().some(h=>Number(h.hazard_type_id)===box.hazard_type_id))){error.textContent='Ada kotak dengan kategori di luar area terpilih. Periksa kategori atau hapus kotaknya.';return;}
        if (fd.get('overall_label') === 'RISK' && !boxes.length) { error.textContent = 'Tandai setidaknya satu bagian berbahaya pada gambar.'; return; }
        if (fd.get('overall_label') === 'NO_LISTED_HAZARD_VISIBLE' && boxes.length) { error.textContent = 'Hapus kotak bahaya atau ubah label menjadi Ada indikasi bahaya.'; return; }
        busy = true; const button = form.querySelector('[type=submit]'); button.disabled = true; button.textContent = 'Menyimpan…';
        try { const result = await api(datasetItemId ? `/api/dataset-items/${datasetItemId}/training-review` : `/api/analyses/${analysisId}/dataset`, post({ dataset_id: Number(fd.get('dataset_id')), work_area_id: Number(fd.get('work_area_id')), overall_label: fd.get('overall_label'), split: fd.get('split'), description: fd.get('description'), license_confirmed: fd.get('license_confirmed') === 'on', annotations: boxes })); busy = false; const current = dialog.isConnected && activeImport === dialog; dialog.close(); if (current) onSaved(result); }
        catch (err) { error.textContent = err.message; }
        finally { busy = false; if (button.isConnected) { button.disabled = false; button.textContent = 'Simpan ke dataset'; } }
      });
      if (datasetItemId) { dialog.querySelector('#dt-import-title').textContent = 'Tinjau contoh pelatihan'; dialog.querySelector('[type=submit]').textContent='Simpan label'; dialog.querySelector('#dt-split').value = detail.item.split; dialog.querySelector('#dt-split').disabled = true; tags(); if (proposal) { const banner=document.createElement('div'); banner.className='dt-notice'; banner.textContent='Usulan awal AI ('+proposal.model+'). Label, deskripsi, dan posisi kotak belum diverifikasi. Periksa dan koreksi sebelum menyimpan.'; dialog.querySelector('.dt-fields').prepend(banner); } const note = dialog.querySelector('.dt-body > section:first-child .dt-notice'); note.textContent = 'Periksa foto, label, dan kotak secara langsung. Pembagian foto PDF diatur per kelompok dokumen melalui Impor PDF rig.'; if (detail.source?.occurrences?.length) { const source = document.createElement('details'); const title = document.createElement('summary'); title.textContent = 'Lihat asal PDF dan konteks halaman'; source.append(title); for (const occurrence of detail.source.occurrences.slice(0, 10)) { const text = document.createElement('pre'); text.style.whiteSpace = 'pre-wrap'; text.textContent = `${occurrence.pdf_name} · Rig ${occurrence.rig_name} · halaman ${occurrence.page}\n${occurrence.context}`; source.append(text); } note.after(source); } }
      dialog.querySelector('[data-cancel]').focus();
    } catch (error) { if (dialog.isConnected) dialog.querySelector('.dt-body').innerHTML = `<div class="dt-error" role="alert">${esc(error.message)}</div>`; }
  }
  async function exportDataset(datasetId, format, button) {
    if (button) { button.disabled = true; button.dataset.originalText = button.textContent; button.textContent = 'Menyiapkan ZIP…'; }
    try {
      const response = await fetch(`/api/datasets/${datasetId}/export`, { credentials: 'same-origin', ...post({ format }) });
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || 'Ekspor dataset gagal.'); }
      const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `dataset-${Number(datasetId)}-${format}.zip`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    } finally { if (button?.isConnected) { button.disabled = false; button.textContent = button.dataset.originalText; } }
  }
  function mountEvaluation({ root, api, user }) {
    let destroyed = false, timer, busy = false, selectedRun = null;
    const statusName = { QUEUED: 'Menunggu', RUNNING: 'Memproses', COMPLETED: 'Selesai', CANCELLED: 'Dibatalkan', FAILED: 'Gagal', INTERRUPTED: 'Terputus' };
    root.innerHTML = `<div class="page-head"><div><p class="eyebrow">UKUR HASIL MODEL</p><h1>Evaluasi model</h1><p class="page-subtitle">Bandingkan model dasar dengan label TEST terverifikasi. Contoh visual tambahan tidak digunakan dalam evaluasi ini.</p></div></div><div class="dt-eval-grid"><article class="card"><h2>Evaluasi baru</h2><form data-eval-form><label for="eval-dataset">Dataset disetujui</label><select id="eval-dataset" name="dataset_id" class="select-field" required><option value="">Memuat…</option></select><label for="eval-model">Model visi lokal</label><select id="eval-model" name="model_name" class="select-field" required><option value="">Memuat…</option></select><div class="dt-notice">Hanya foto TEST yang berlisensi dan berlabel VERIFIED yang dipakai. Label serta gambar dibekukan sebagai acuan evaluasi.</div><button class="btn btn-primary" type="submit" disabled>Mulai evaluasi</button><p class="dt-muted">Satu proses AI pada satu waktu. Evaluasi dapat berjalan beberapa menit dan tidak melatih model.</p></form><div class="dt-error" data-eval-error role="alert"></div></article><section><article class="card"><div class="dt-label-row"><h2>Riwayat evaluasi</h2><button class="btn btn-secondary" data-refresh type="button">Muat ulang</button></div><div data-eval-runs><p class="dt-muted">Memuat riwayat…</p></div></article><article class="card dt-detail is-hidden" data-eval-detail></article></section></div>`;
    const errorEl = root.querySelector('[data-eval-error]');
    function metricsHtml(metrics = {}) {
      const entries = [['missed_hazards', 'Bahaya terlewat'], ['false_alarms', 'Alarm keliru'], ['uncertain_predictions', 'Prediksi belum yakin'], ['failed_items', 'Gagal dianalisis']];
      return `<div class="dt-metrics">${entries.map(([key, title]) => `<div class="dt-metric"><strong>${Number.isFinite(metrics[key]) ? metrics[key] : '—'}</strong><span>${title}</span></div>`).join('')}</div><p class="dt-muted">${esc(metrics.explanation || 'Lihat jumlah acuan berbahaya dan tidak berbahaya di bawah. Kegagalan serta ketidakpastian dilaporkan terpisah.')}</p><div class="dt-muted">Acuan berbahaya: ${esc(metrics.risk_truth_evaluated ?? '—')} · Acuan tanpa bahaya: ${esc(metrics.no_hazard_truth_evaluated ?? '—')} · Latensi rata-rata: ${Number.isFinite(metrics.latency?.mean_ms) ? `${(metrics.latency?.mean_ms / 1000).toFixed(1)} dtk` : '—'}</div>`;
    }
    async function detail(id) {
      selectedRun = Number(id); const response = await api(`/api/evaluations/${id}`);
      if (destroyed || Number(id) !== selectedRun) return;
      const { run, items = [], metrics = {} } = response, panel = root.querySelector('[data-eval-detail]'); panel.classList.remove('is-hidden');
      panel.innerHTML = `<h2>Hasil ${esc(run.model_name)}</h2><p class="dt-muted">${esc(run.dataset_name)} · ${esc(run.dataset_version)}<br>${date(run.created_at)} · ${esc(statusName[run.status] || run.status)}</p>${metricsHtml(metrics)}${run.error_message ? `<div class="dt-error">${esc(run.error_message)}</div>` : ''}<details><summary>Rincian ${items.length} foto</summary><div class="dt-scroll"><table><thead><tr><th>Foto</th><th>Acuan</th><th>Prediksi</th><th>Waktu</th></tr></thead><tbody>${items.map(item => `<tr><td>${esc(item.original_name || item.dataset_item_id || item.evaluation_item_id)}</td><td>${esc(label(item.true_label))}</td><td>${esc(label(item.predicted_status))}${item.error_message ? `<br>${esc(item.error_message)}` : ''}</td><td>${Number.isFinite(item.latency_ms) ? `${(item.latency_ms / 1000).toFixed(1)} dtk` : '—'}</td></tr>`).join('')}</tbody></table></div></details>`;
    }
    async function refresh() {
      if (destroyed || busy) return; busy = true;
      try {
        const { runs = [] } = await api('/api/evaluations'); if (destroyed) return;
        root.querySelector('[data-eval-runs]').innerHTML = runs.length ? runs.map(run => `<div class="dt-run"><div class="dt-run-head"><div><strong>${esc(run.model_name)}</strong><p>${esc(run.dataset_name)} · ${esc(run.dataset_version)}<br>${date(run.created_at)}</p></div><span class="dt-run-status">${esc(statusName[run.status] || run.status)}</span></div><progress max="${Math.max(1, Number(run.total_items))}" value="${Number(run.completed_items) || 0}"></progress><p>${Number(run.completed_items) || 0} / ${Number(run.total_items) || 0} foto</p><div class="dt-eval-actions"><button class="btn btn-secondary" data-run-detail="${run.evaluation_run_id}" type="button">Lihat hasil</button>${['QUEUED', 'RUNNING'].includes(run.status) && (user?.role === 'admin' || Number(run.owner_user_id) === Number(user?.user_id)) ? `<button class="btn btn-secondary" data-cancel-run="${run.evaluation_run_id}" type="button">Batalkan</button>` : ''}</div></div>`).join('') : '<p class="dt-muted">Belum ada evaluasi. Siapkan dataset TEST terlebih dahulu.</p>';
        if (selectedRun) await detail(selectedRun);
        if (runs.some(run => ['QUEUED', 'RUNNING'].includes(run.status))) schedule();
      } catch (err) { if (!destroyed) errorEl.textContent = err.status === 404 ? 'Server perlu dimulai ulang untuk memakai evaluasi model.' : err.message; }
      finally { busy = false; }
    }
    function schedule() { clearTimeout(timer); if (!destroyed) timer = setTimeout(refresh, 3000); }
    root.addEventListener('click', onClick);
    async function onClick(e) {
      const target = e.target.closest('button'); if (!target || destroyed) return;
      try {
        if (target.hasAttribute('data-refresh')) { errorEl.textContent = ''; await refresh(); }
        if (target.dataset.runDetail) await detail(target.dataset.runDetail);
        if (target.dataset.cancelRun) { target.disabled = true; await api(`/api/evaluations/${target.dataset.cancelRun}/cancel`, post({})); await refresh(); }
      } catch (err) { if (!destroyed) errorEl.textContent = err.message; }
      finally { if (target.isConnected) target.disabled = false; }
    }
    const form = root.querySelector('[data-eval-form]');
    form.addEventListener('submit', async e => {
      e.preventDefault(); const button = form.querySelector('[type=submit]'); if (button.disabled) return; button.disabled = true; errorEl.textContent = '';
      try { const fd = new FormData(form), result = await api('/api/evaluations', post({ dataset_id: Number(fd.get('dataset_id')), model_name: fd.get('model_name') })); if (!destroyed) { selectedRun = Number(result.evaluation_run_id || result.run?.evaluation_run_id); await refresh(); schedule(); } }
      catch (err) { if (!destroyed) errorEl.textContent = err.message; }
      finally { if (!destroyed) button.disabled = false; }
    });
    (async () => {
      try {
        const [data, ai] = await Promise.all([api('/api/datasets'), api('/api/ai/status')]); if (destroyed) return;
        const datasets = data.datasets.filter(d => d.status === 'APPROVED' && d.dataset_kind !== 'PPE_OBJECT'), models = ai.vision_models || ai.models || [];
        form.querySelector('[name=dataset_id]').innerHTML = datasets.length ? datasets.map(d => `<option value="${d.dataset_id}">${esc(d.name)} · ${esc(d.version)}</option>`).join('') : '<option value="">Belum ada dataset APPROVED</option>';
        form.querySelector('[name=model_name]').innerHTML = models.length ? models.map(m => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('') : '<option value="">Model visi belum tersedia</option>';
        form.querySelector('[type=submit]').disabled = !datasets.length || !models.length; await refresh();
      } catch (err) { if (!destroyed) errorEl.textContent = err.message; }
    })();
    return { destroy() { destroyed = true; clearTimeout(timer); root.removeEventListener('click', onClick); } };
  }
  window.DatasetToolsUI = { openImport, exportDataset, mountEvaluation, close() { activeImport?.close(); } };
})();
