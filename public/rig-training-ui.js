(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const names = { PREPARING: 'Menyiapkan snapshot', RUNNING: 'Berjalan', COMPLETED: 'Selesai · kandidat', FAILED: 'Gagal', CANCELLED: 'Dibatalkan', INTERRUPTED: 'Terputus' };
  const phases = { VALIDATING: 'Memeriksa data', TRAINING: 'Melatih bobot', EVALUATING: 'Mengukur kotak TEST', EVALUATING_PHOTOS: 'Mengukur foto TEST', EXPORTING: 'Mengekspor model', CANDIDATE: 'Siap ditinjau' };
  const percent = value => Number.isFinite(Number(value)) && value != null ? `${(Number(value) * 100).toFixed(1)}%` : 'Belum terukur';

  function mount({ root, api, user }) {
    let destroyed = false, fetching = false, timer = null, selectionVersion = 0, readiness = null, active = null, trainingBusy = false, actionBusy = false, photoUrl = null;
    root.innerHTML = `<section class="card card-pad rig-training-panel" aria-labelledby="rig-training-title">
      <div class="card-title-row"><div><h2 class="card-title" id="rig-training-title">Latih model rig di laptop</h2><p class="card-caption">Foto terverifikasi → pelatihan → evaluasi TEST → percobaan model.</p></div><button class="btn btn-secondary" type="button" data-rig-refresh>Muat ulang</button></div>
      <p>Model rig belajar dari kotak bahaya terverifikasi. Setelah dipilih, model ini membantu Gemma dan membuat usulan kotak pada foto baru. Foto percobaan di bawah diproses sementara.</p>
      <div class="dt-error" data-rig-error role="alert"></div>
      <form data-rig-train-form class="rig-training-form">
        <label class="inline-label" for="rig-train-dataset">Dataset pelatihan</label><select class="select-field" id="rig-train-dataset" name="dataset_id" required><option value="">Pilih dataset…</option></select>
        <div data-rig-readiness aria-live="polite"><p class="hint-text">Pilih dataset untuk melihat foto yang perlu disiapkan.</p></div>
        <label class="inline-label" for="rig-train-epochs">Jumlah epoch</label><input class="field" id="rig-train-epochs" name="epochs" type="number" min="1" max="200" value="20" required><p class="hint-text">Satu epoch adalah satu putaran belajar pada data TRAIN. Proses memakai CPU dan dapat berlangsung lama. Lebih banyak epoch belum tentu lebih baik.</p>
        <label class="dt-consent"><input type="checkbox" name="confirm_training" required><span>Saya sudah memeriksa label, pembagian kelompok, dan izin foto. Saya ingin memulai pelatihan lokal.</span></label>
        <button class="btn btn-primary" type="submit" disabled>Mulai pelatihan</button><p class="hint-text">Saat pelatihan berjalan, pemeriksaan dan evaluasi AI menunggu. Data yang belum siap tidak akan dilatih.</p>
      </form>
      <h3>Riwayat pelatihan dan hasil TEST</h3><div data-rig-jobs></div>
      <h3 id="rig-scan-title">Coba detektor pada foto</h3><p data-rig-active class="hint-text">Belum ada model terlatih yang dipilih.</p>
      <form data-rig-scan-form><label class="inline-label" for="rig-scan-photo">Foto yang ingin diperiksa</label><input class="field" id="rig-scan-photo" name="image" type="file" accept="image/jpeg,image/png,image/webp" required><p class="hint-text">JPG, PNG, WebP · maksimal 8 MB. Foto dikirim sementara untuk analisis; tidak disimpan di server atau menjadi dataset.</p><button class="btn btn-primary" type="submit" disabled>Periksa dengan model rig</button></form>
      <div data-rig-scan-result role="status"></div><div class="rig-scan-frame is-hidden" data-rig-scan-frame><img alt="Foto percobaan detektor lokal"><div data-rig-scan-boxes></div></div>
    </section>`;
    const datasetSelect = root.querySelector('#rig-train-dataset');
    const trainForm = root.querySelector('[data-rig-train-form]'), scanForm = root.querySelector('[data-rig-scan-form]');
    const error = message => { if (!destroyed) root.querySelector('[data-rig-error]').textContent = message || ''; };
    function updateButtons() {
      trainForm.querySelector('[type=submit]').disabled = actionBusy || trainingBusy || !readiness?.can_train;
      const button = scanForm.querySelector('[type=submit]');
      button.disabled = actionBusy || trainingBusy || !active;
      button.textContent = 'Periksa dengan model rig';
    }
    function readinessHtml(data) {
      return `<p><strong>${data.verified}/${data.total} foto terverifikasi</strong> · ${esc(data.dataset.status)}</p>
        <div class="dt-scroll"><table class="rig-training-table"><thead><tr><th>Pembagian</th><th>Foto</th><th>Bahaya</th><th>Tanpa indikasi</th><th>Kotak</th></tr></thead><tbody>${Object.entries(data.split_counts).map(([split, count]) => `<tr><td>${split}</td><td>${count.photos}</td><td>${count.risk}</td><td>${count.normal}</td><td>${count.boxes}</td></tr>`).join('')}</tbody></table></div>
        ${data.blockers.length ? `<p><strong>Perlu diselesaikan sebelum melatih</strong></p><ul>${data.blockers.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul>` : '<p>Prasyarat teknis terpenuhi. Tetap periksa kecukupan dan keseimbangan foto per kategori.</p>'}
        ${data.categories.length ? `<details><summary>Kotak per kategori</summary><div class="dt-scroll"><table class="rig-training-table"><thead><tr><th>Kategori</th><th>TRAIN</th><th>VALIDATION</th><th>TEST</th></tr></thead><tbody>${data.categories.map(category => `<tr><td>${esc(category.name)}</td><td>${category.TRAIN}</td><td>${category.VALIDATION}</td><td>${category.TEST}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
        ${data.warnings.length ? `<details><summary>Catatan mutu data (${data.warnings.length})</summary><ul>${data.warnings.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul></details>` : ''}`;
    }
    async function checkReadiness() {
      const version = ++selectionVersion, id = datasetSelect.value;
      readiness = null; updateButtons();
      const target = root.querySelector('[data-rig-readiness]');
      if (!id) { target.innerHTML = '<p class="hint-text">Pilih dataset untuk melihat kesiapan.</p>'; return; }
      target.textContent = 'Memeriksa label dan pembagian foto…';
      try {
        const data = await api(`/api/rig-training/readiness/${id}`);
        if (destroyed || version !== selectionVersion) return;
        readiness = data; target.innerHTML = readinessHtml(data); updateButtons();
      } catch (err) { if (!destroyed && version === selectionVersion) { target.textContent = err.message; error(err.status === 404 ? 'Mulai ulang server lokal untuk memuat fitur pelatihan.' : err.message); } }
    }
    function metricsHtml(job) {
      const metrics = job.metrics || {}, photo = job.photo_metrics;
      return `<p><strong>Hasil deteksi kotak pada TEST</strong><br>Precision ${percent(metrics['metrics/precision(B)'])} · Recall ${percent(metrics['metrics/recall(B)'])} · mAP50 ${percent(metrics['metrics/mAP50(B)'])}</p>
        ${photo ? `<p>Foto bahaya tanpa deteksi: <strong>${photo.risk_photos_without_detection}/${photo.risk_photos}</strong>.<br>Foto tanpa indikasi yang diberi alarm: <strong>${photo.normal_photos_with_detection}/${photo.normal_photos}</strong>${photo.normal_photos ? '.' : ' · belum dapat dinilai karena tidak ada foto tanpa indikasi pada TEST.'}<br>Ambang deteksi ${photo.confidence_threshold}; hitungan ini berbeda dari ketepatan kotak.</p>` : ''}
        <p class="hint-text">Metrik ini bukan jaminan keselamatan. Detektor hanya mengenali kategori yang dilatih; tidak ada deteksi harus tetap ditinjau.</p>
        ${job.per_class_metrics?.length ? `<details><summary>Precision dan recall per kategori</summary><div class="dt-scroll"><table class="rig-training-table"><thead><tr><th>Kategori</th><th>Precision</th><th>Recall</th><th>mAP50</th></tr></thead><tbody>${job.per_class_metrics.map(row => `<tr><td>${esc(row.name)}</td><td>${percent(row.precision)}</td><td>${percent(row.recall)}</td><td>${percent(row.map50)}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
        <p class="hint-text">Snapshot ${esc(job.snapshot_sha256?.slice(0, 16))} · ${job.class_map?.length || 0} kategori.</p>`;
    }
    async function refreshJobs() {
      if (destroyed || fetching) return;
      fetching = true; clearTimeout(timer);
      try {
        const data = await api('/api/rig-training');
        if (destroyed) return;
        active = data.active_model; trainingBusy = data.training_busy;
        root.querySelector('[data-rig-active]').textContent = active ? `Model percobaan: ${active.name}. Hanya ${active.class_map.length} kategori yang dilatih.` : 'Belum ada model terlatih. Selesaikan pelatihan, tinjau hasilnya, lalu admin memilih model untuk percobaan lokal.';
        root.querySelector('[data-rig-jobs]').innerHTML = data.jobs.length ? data.jobs.map(job => {
          const running = ['PREPARING', 'RUNNING'].includes(job.status), progress = job.progress || {};
          return `<article class="rig-training-job"><div class="dt-run-head"><div><strong>${esc(job.dataset_name || job.dataset_id)}</strong><p>${esc(names[job.status] || job.status)} · ${esc(phases[job.stage] || job.stage)}${job.active ? ' · Dipilih untuk percobaan' : ''}</p></div><small>${esc(job.created_at?.slice(0, 19).replace('T', ' '))} UTC</small></div>
            ${running ? `<progress max="${job.epochs}" value="${progress.epoch || 0}"></progress><p>Epoch ${progress.epoch || 0}/${job.epochs}${progress.total ? ` · TEST ${progress.completed || 0}/${progress.total}` : ''}</p><button class="btn btn-secondary" type="button" data-rig-cancel="${job.id}">Hentikan pelatihan</button>` : ''}
            ${job.error ? `<p class="dt-error">${esc(job.error)}</p>` : ''}
            ${job.status === 'COMPLETED' ? metricsHtml(job) : ''}
            ${job.status === 'COMPLETED' && user.role === 'admin' && !job.active ? `<label class="dt-consent"><input type="checkbox" data-rig-review="${job.id}"><span>Saya sudah meninjau hasil TEST dan memilih kandidat ini untuk percobaan lokal.</span></label><button class="btn btn-secondary" type="button" data-rig-activate="${job.id}" disabled>Gunakan sebagai pendamping Gemma</button>` : ''}
          </article>`;
        }).join('') : '<p class="hint-text">Belum ada pelatihan. Foto perlu dilabeli dan diverifikasi terlebih dahulu.</p>';
        updateButtons();
        if (trainingBusy || data.jobs.some(job => ['PREPARING', 'RUNNING'].includes(job.status))) timer = setTimeout(refreshJobs, 6000);
      } catch (err) { error(err.status === 404 ? 'Mulai ulang server lokal untuk memuat fitur pelatihan.' : err.message); }
      finally { fetching = false; }
    }
    async function train(event) {
      event.preventDefault(); if (actionBusy || !readiness?.can_train) return;
      actionBusy = true; error(''); updateButtons();
      try {
        await api('/api/rig-training', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataset_id: Number(datasetSelect.value), epochs: Number(trainForm.elements.epochs.value), confirm_training: trainForm.elements.confirm_training.checked }) });
        trainForm.elements.confirm_training.checked = false;
        await refreshJobs();
      } catch (err) { error(err.message); }
      finally { actionBusy = false; updateButtons(); }
    }
    function photoChanged() {
      if (photoUrl) URL.revokeObjectURL(photoUrl);
      photoUrl = null;
      root.querySelector('[data-rig-scan-result]').textContent = '';
      root.querySelector('[data-rig-scan-boxes]').innerHTML = '';
      const photo = scanForm.elements.image.files[0], frame = root.querySelector('[data-rig-scan-frame]');
      frame.classList.add('is-hidden');
      if (!photo) return;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(photo.type) || photo.size < 1 || photo.size > 8 * 1024 * 1024) { error('Pilih JPG, PNG, atau WebP maksimal 8 MB.'); scanForm.elements.image.value = ''; return; }
      photoUrl = URL.createObjectURL(photo); frame.querySelector('img').src = photoUrl; frame.classList.remove('is-hidden');
    }
    async function scan(event) {
      event.preventDefault();
      if (actionBusy || trainingBusy || !active || !photoUrl) return;
      actionBusy = true; error(''); updateButtons(); scanForm.elements.image.disabled = true;

      const result = root.querySelector('[data-rig-scan-result]'); result.textContent = 'Model rig sedang memeriksa foto…';
      try {
        const body = new FormData(); body.append('image', scanForm.elements.image.files[0]);
        const data = await api('/api/rig-training/scan', { method: 'POST', body });
        if (destroyed) return;
        result.innerHTML = `<p><strong>${esc(data.summary)}</strong></p><p>${esc(data.model_name)} · ${(data.latency_ms / 1000).toFixed(2)} detik · foto tidak disimpan di server.</p>${data.detections.length ? `<ul>${data.detections.map(row => `<li>${esc(row.display_name || row.class_name)} · skor deteksi ${percent(row.confidence)}</li>`).join('')}</ul>` : ''}${data.review_questions?.length ? `<p><strong>Periksa secara manual</strong></p><ul>${data.review_questions.map(text => `<li>${esc(text)}</li>`).join('')}</ul>` : ''}`;
        root.querySelector('[data-rig-scan-boxes]').innerHTML = data.detections.map(row => `<span class="rig-scan-box" style="left:${row.box.x * 100}%;top:${row.box.y * 100}%;width:${row.box.width * 100}%;height:${row.box.height * 100}%"><span>${esc(row.display_name || row.class_name)}</span></span>`).join('');
      } catch (err) { if (!destroyed) { result.textContent = ''; error(err.message); } }
      finally { actionBusy = false; if (!destroyed) { scanForm.elements.image.disabled = false;  updateButtons(); } }
    }
    async function click(event) {
      const button = event.target.closest('button'); if (!button || destroyed) return;
      if (button.hasAttribute('data-rig-refresh')) { await checkReadiness(); await refreshJobs(); return; }
      const id = button.dataset.rigCancel || button.dataset.rigActivate;
      if (!id || actionBusy) return;
      actionBusy = true; button.disabled = true; error(''); updateButtons();
      try {
        const activating = Boolean(button.dataset.rigActivate);
        const reviewed = root.querySelector(`[data-rig-review="${id}"]`)?.checked;
        await api(`/api/rig-training/${id}/${activating ? 'activate' : 'cancel'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(activating ? { review_confirmed: reviewed === true } : {}) });
        await refreshJobs();
      } catch (err) { error(err.message); if (button.isConnected) button.disabled = false; }
      finally { actionBusy = false; updateButtons(); }
    }
    function change(event) {
      if (event.target === datasetSelect) checkReadiness();
      else if (event.target.dataset.rigReview) root.querySelector(`[data-rig-activate="${event.target.dataset.rigReview}"]`).disabled = !event.target.checked || actionBusy || trainingBusy;
      else if (event.target === scanForm.elements.image) photoChanged();

    }
    trainForm.addEventListener('submit', train); scanForm.addEventListener('submit', scan); root.addEventListener('click', click); root.addEventListener('change', change);
    refreshJobs();
    return {
      setDatasets(datasets) {
        if (destroyed) return;
        const selected = datasetSelect.value;
        datasetSelect.innerHTML = '<option value="">Pilih dataset…</option>' + datasets.map(dataset => `<option value="${Number(dataset.dataset_id)}">${esc(dataset.name)} · ${esc(dataset.status)}</option>`).join('');
        datasetSelect.value = datasets.some(dataset => String(dataset.dataset_id) === selected) ? selected : datasets[0] ? String(datasets[0].dataset_id) : '';
        checkReadiness();
      },
      destroy() { destroyed = true; selectionVersion++; clearTimeout(timer); if (photoUrl) URL.revokeObjectURL(photoUrl); root.removeEventListener('click', click); root.removeEventListener('change', change); trainForm.removeEventListener('submit', train); scanForm.removeEventListener('submit', scan); }
    };
  }
  window.RigTrainingUI = Object.freeze({ mount });
})();
