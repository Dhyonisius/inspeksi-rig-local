(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  function mount({ root, api, user }) {
    let destroyed = false, loading = false, working = false, data = null, offset = 0, state = 'included', dialog = null;
    const selected = new Set();
    root.innerHTML = `<div class="page-head"><div><p class="eyebrow">SELEKSI DATA PELATIHAN</p><h1>Kurasi foto Protect</h1><p class="page-subtitle">Pisahkan foto dokumen atau foto yang tidak relevan sebelum memberi label dan melatih model.</p></div><button class="btn btn-secondary" type="button" data-view="learning">Belajar dari foto</button></div>
      <div class="dt-error" data-curation-error role="alert"></div><p data-curation-notice role="status"></p>
      <form class="card card-pad protect-filters" data-curation-filter><div><label for="protect-dataset">Dataset Protect</label><select class="select-field" id="protect-dataset" name="dataset_id"><option value="">Memuat…</option></select></div><div><label for="protect-rig">Rig asal</label><select class="select-field" id="protect-rig" name="rig"><option value="">Semua rig</option></select></div><div><label for="protect-pdf">PDF asal</label><select class="select-field" id="protect-pdf" name="pdf"><option value="">Semua PDF</option></select></div><div><label for="protect-page">Halaman PDF</label><input class="field" id="protect-page" name="page" type="number" min="1" max="10000" placeholder="Semua halaman"></div><div><label for="protect-search">Nama foto</label><input class="field" id="protect-search" name="q" maxlength="120" placeholder="Cari nama foto…"></div><div class="protect-filter-buttons"><button class="btn btn-primary" type="submit">Terapkan filter</button><button class="btn btn-secondary" type="button" data-curation-reset>Reset filter</button></div></form>
      <div class="protect-stats" data-curation-stats></div>
      <div class="history-tabs" role="group" aria-label="Status kurasi"><button type="button" data-curation-state="included" class="is-active" aria-pressed="true">Dipakai</button><button type="button" data-curation-state="excluded" aria-pressed="false">Dikecualikan</button><button type="button" data-curation-state="all" aria-pressed="false">Semua foto</button></div>
      <section class="card card-pad protect-actions"><div class="protect-selection"><label><input type="checkbox" data-curation-all> Pilih semua di halaman ini</label><span data-curation-selected>0 foto dipilih</span><button class="quiet-link" type="button" data-curation-clear>Batalkan pilihan</button></div><div class="protect-reason"><label for="protect-reason">Alasan pengecualian</label><select class="select-field" id="protect-reason"><option>Foto dokumen atau formulir</option><option>Tidak memperlihatkan kondisi peralatan atau lingkungan</option><option>Gambar terlalu buram atau tidak terbaca</option><option>Foto berulang dan tidak menambah contoh</option><option value="other">Alasan lain</option></select><input class="field" data-curation-reason-note maxlength="250" placeholder="Catatan tambahan (opsional)" aria-label="Catatan alasan pengecualian"></div><div class="learning-actions"><button class="btn btn-secondary" type="button" data-curation-exclude disabled>Pindahkan ke Dikecualikan</button><button class="btn btn-primary" type="button" data-curation-restore disabled>Kembalikan ke Dipakai</button>${user.role === 'admin' ? '<button class="btn btn-danger" type="button" data-curation-delete disabled>Hapus permanen pilihan</button>' : ''}</div><p class="hint-text" data-curation-policy>Foto yang dikecualikan tidak masuk antrean belajar, contoh AI, ekspor, atau pelatihan. Dapat dikembalikan selama dataset masih Draft.</p></section>
      <div class="protect-gallery" data-curation-gallery aria-live="polite"></div><div class="protect-pagination" data-curation-pages></div>`;
    const form = root.querySelector('[data-curation-filter]');
    root.querySelector('[data-curation-all]').disabled = true;
    const error = message => { if (!destroyed) root.querySelector('[data-curation-error]').textContent = message || ''; };
    const notice = message => { if (!destroyed) root.querySelector('[data-curation-notice]').textContent = message || ''; };
    const rows = () => (data?.items || []).filter(row => selected.has(row.dataset_item_id));
    function buttons() {
      if (destroyed) return;
      const selection = rows(), editable = data?.dataset.status === 'DRAFT' && !loading && !working;
      root.querySelector('[data-curation-selected]').textContent = `${selected.size} foto dipilih`;
      root.querySelector('[data-curation-exclude]').disabled = !editable || !selection.length || selection.some(row => row.is_excluded);
      root.querySelector('[data-curation-restore]').disabled = !editable || !selection.length || selection.some(row => !row.is_excluded);
      const remove = root.querySelector('[data-curation-delete]'); if (remove) remove.disabled = !editable || !selection.length || selection.some(row => !row.is_excluded);
      const all = root.querySelector('[data-curation-all]'); all.disabled = !editable || !data?.items.length; all.checked = !!data?.items.length && selected.size === data.items.length; all.indeterminate = selected.size > 0 && !all.checked;
      root.querySelectorAll('[data-curation-item]').forEach(input => { input.checked = selected.has(Number(input.dataset.curationItem)); input.disabled = !editable; });
      form.querySelectorAll('input,select,button').forEach(control => { control.disabled = loading || working; });
      root.querySelectorAll('[data-curation-state]').forEach(button => { button.disabled = loading || working; });
    }
    function facets(origins) {
      for (const [name, key, text] of [['rig', 'rig_name', 'Semua rig'], ['pdf', 'pdf_name', 'Semua PDF']]) {
        const control = form.elements[name], value = control.value;
        const values = [...new Set(origins.map(row => row[key]).filter(Boolean))];
        control.innerHTML = `<option value="">${text}</option>` + values.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join('');
        if (values.includes(value)) control.value = value;
      }
    }
    async function load() {
      if (destroyed || loading || !form.elements.dataset_id.value) return;
      loading = true; selected.clear(); error(''); buttons(); root.querySelector('[data-curation-gallery]').textContent = 'Memuat foto Protect…';
      try {
        const query = new URLSearchParams({ state, offset: String(offset) });
        for (const name of ['rig', 'pdf', 'page', 'q']) if (form.elements[name].value) query.set(name, form.elements[name].value);
        const result = await api(`/api/protect-curation/${form.elements.dataset_id.value}?${query}`);
        if (destroyed) return;
        data = result; offset = result.offset; facets(result.origins);
        root.querySelector('[data-curation-stats]').innerHTML = [['Dipakai', result.stats.included], ['Dikecualikan', result.stats.excluded], ['Dihapus dari dataset', result.stats.deleted]].map(([name, count]) => `<article class="card card-pad"><span>${name}</span><strong>${Number(count) || 0}</strong></article>`).join('');
        root.querySelector('[data-curation-policy]').textContent = result.dataset.status === 'DRAFT' ? 'Foto yang dikecualikan tidak masuk antrean belajar, contoh AI, ekspor, atau pelatihan. Dapat dikembalikan selama dataset masih Draft. PDF sumber tetap dipertahankan.' : `Dataset ${result.dataset.status} dibekukan. Kurasi di sini hanya dapat dilihat. Jika masih Tinjauan, admin dapat mengembalikannya ke Draft melalui Kelola dataset.`;
        root.querySelector('[data-curation-gallery]').innerHTML = result.items.length ? result.items.map(row => {
          const origins = typeof row.origins === 'string' ? JSON.parse(row.origins) : row.origins || [];
          return `<article class="card protect-photo"><label class="protect-pick"><input type="checkbox" data-curation-item="${row.dataset_item_id}" aria-label="Pilih ${esc(row.original_name)}"><span>${row.is_excluded ? 'Dikecualikan' : 'Dipakai'}</span></label><button type="button" class="protect-preview" data-curation-preview="${row.dataset_item_id}" aria-label="Perbesar ${esc(row.original_name)}"><img src="/api/media/${row.image_id}/thumbnail" alt="${esc(row.original_name)}" loading="lazy"></button><div class="protect-photo-copy"><h2>${esc(row.original_name)}</h2><p>${esc(origins[0]?.rig_name || 'Rig')} · halaman ${Number(origins[0]?.page) || '—'}</p><details><summary>Asal PDF${origins.length > 1 ? ` (${origins.length})` : ''}</summary><ul>${origins.map(origin => `<li>${esc(origin.pdf_name)} · halaman ${Number(origin.page)}</li>`).join('')}</ul></details><p class="hint-text">${esc(row.label_status)} · ${esc(row.split)}</p>${!row.is_excluded && result.dataset.status === "DRAFT" ? `<button type="button" class="btn btn-secondary" data-curation-review="${row.dataset_item_id}">Tinjau contoh pelatihan</button>` : ""}${row.exclusion_reason ? `<p class="protect-exclusion">${esc(row.exclusion_reason)}</p>` : ''}</div></article>`;
        }).join('') : '<div class="card card-pad">Tidak ada foto pada filter ini.</div>';
        root.querySelector('[data-curation-pages]').innerHTML = `<button class="btn btn-secondary" type="button" data-curation-page="${Math.max(0, offset - 24)}" ${offset ? '' : 'disabled'}>Sebelumnya</button><span>${result.total ? offset + 1 : 0}–${Math.min(offset + 24, result.total)} dari ${result.total} foto</span><button class="btn btn-secondary" type="button" data-curation-page="${offset + 24}" ${offset + 24 < result.total ? '' : 'disabled'}>Berikutnya</button>`;
      } catch (err) { error(err.message); root.querySelector('[data-curation-gallery]').textContent = 'Galeri belum dapat dimuat.'; }
      finally { loading = false; buttons(); }
    }
    function closeDialog() { dialog?.close(); dialog = null; }
    function createDialog(title) {
      closeDialog(); const popup = document.createElement('dialog'); popup.className = 'protect-dialog'; dialog = popup;
      popup.setAttribute('aria-label', title); popup.addEventListener('close', () => { popup.remove(); if (dialog === popup) dialog = null; }, { once: true });
      document.body.append(popup); popup.showModal(); return popup;
    }
    function preview(id) {
      const row = data.items.find(row => row.dataset_item_id === id); if (!row) return;
      const popup = createDialog('Pratinjau foto Protect');
      popup.innerHTML = `<h2>${esc(row.original_name)}</h2><img class="protect-full-photo" src="/api/media/${row.image_id}" alt="${esc(row.original_name)}"><p>${row.is_excluded ? 'Dikecualikan dari pembelajaran' : 'Dipakai sebagai calon pelatihan'}</p><button class="btn btn-secondary" type="button">Tutup pratinjau</button>`;
      popup.querySelector('button').addEventListener('click', () => popup.close()); popup.querySelector('button').focus();
    }
    async function move(excluded) {
      const selection = rows(); if (!selection.length || data.dataset.status !== 'DRAFT' || working || loading) return;
      const preset = root.querySelector('#protect-reason').value, note = root.querySelector('[data-curation-reason-note]').value.trim();
      const reason = [preset === 'other' ? '' : preset, note].filter(Boolean).join(' · ').slice(0, 300);
      if (excluded && !reason) { error('Isi catatan alasan untuk mengecualikan foto.'); return; }
      working = true; let succeeded = false; error(''); notice(''); buttons();
      try {
        const result = await api(`/api/protect-curation/${data.dataset.dataset_id}/selection`, json('PATCH', { item_ids: selection.map(row => row.dataset_item_id), excluded, reason }));
        notice(`${result.changed} foto ${excluded ? 'dipindahkan ke Dikecualikan' : 'dikembalikan ke Dipakai'}.`);
        succeeded = true;
      } catch (err) { error(err.message); }
      finally { working = false; buttons(); }
      if (succeeded) await load();
    }
    async function remove() {
      const selection = rows(); if (!selection.length || selection.some(row => !row.is_excluded) || working || loading || user.role !== 'admin') return;
      working = true; buttons(); error('');
      try {
        const datasetId = data.dataset.dataset_id, ids = selection.map(row => row.dataset_item_id);
        const result = await api(`/api/protect-curation/${datasetId}/delete-preview`, json('POST', { item_ids: ids }));
        if (destroyed) return;
        const popup = createDialog('Konfirmasi penghapusan foto Protect');
        popup.innerHTML = `<h2>Hapus ${result.count} foto dari dataset?</h2><p>Foto pilihan sudah dikecualikan. Penghapusan ini permanen. PDF asli tetap disimpan.</p><p>${result.photos_retained ? `${result.photos_retained} berkas foto masih dipakai dataset, pemeriksaan, atau evaluasi lain dan akan dipertahankan.` : 'Berkas foto tanpa referensi lain dan salinan hasil ekstraksinya akan dibersihkan.'}</p><ul class="protect-delete-list">${result.items.map(row => `<li>${esc(row.original_name)}</li>`).join('')}</ul><form><label for="protect-delete-confirm">Ketik ${esc(result.confirmation)}</label><input class="field" id="protect-delete-confirm" name="confirmation" autocomplete="off" required><label class="dt-consent"><input name="permanent" type="checkbox" required><span>Saya sudah memeriksa daftar ini dan ingin menghapusnya permanen.</span></label><div class="dt-error" role="alert"></div><div class="learning-actions"><button type="button" class="btn btn-secondary" data-delete-cancel>Batal</button><button type="submit" class="btn btn-danger" disabled>Hapus permanen ${result.count} foto</button></div></form>`;
        let deleting = false;
        const deleteForm = popup.querySelector('form'), cancel = popup.querySelector('[data-delete-cancel]'), submit = popup.querySelector('[type=submit]');
        const enabled = () => { submit.disabled = deleting || deleteForm.elements.confirmation.value !== result.confirmation || !deleteForm.elements.permanent.checked; };
        deleteForm.addEventListener('input', enabled); deleteForm.addEventListener('change', enabled);
        cancel.addEventListener('click', () => popup.close()); popup.addEventListener('cancel', event => { if (deleting) event.preventDefault(); });
        deleteForm.addEventListener('submit', async event => {
          event.preventDefault(); if (deleting || submit.disabled) return; deleting = true; cancel.disabled = true; enabled();
          try {
            const removed = await api(`/api/protect-curation/${datasetId}`, json('DELETE', { item_ids: ids, permanent: true, confirmation: deleteForm.elements.confirmation.value, preview_token: result.preview_token }));
            popup.close(); notice(`${removed.deleted} foto dihapus dari dataset. ${removed.files_deleted} berkas unggahan dibersihkan; ${removed.photos_retained} berkas dipertahankan karena masih dipakai.${removed.cleanup_warning ? ' ' + removed.cleanup_warning : ''}${removed.prepared_warning ? ' ' + removed.prepared_warning : ''}`); await load();
          } catch (err) { if (popup.isConnected) popup.querySelector('.dt-error').textContent = err.message; }
          finally { deleting = false; if (popup.isConnected) { cancel.disabled = false; enabled(); } }
        }); cancel.focus();
      } catch (err) { error(err.message); }
      finally { working = false; buttons(); }
    }
    async function click(event) {
      const button = event.target.closest('button'); if (!button || destroyed || working || loading) return;
      if (button.dataset.curationState) { state = button.dataset.curationState; offset = 0; notice(''); root.querySelectorAll('[data-curation-state]').forEach(tab => { const active = tab === button; tab.classList.toggle('is-active', active); tab.setAttribute('aria-pressed', String(active)); }); await load(); }
      else if (button.hasAttribute('data-curation-page')) { offset = Number(button.dataset.curationPage); await load(); root.querySelector('.protect-actions').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      else if (button.dataset.curationPreview) preview(Number(button.dataset.curationPreview));
      else if (button.dataset.curationReview) await window.DatasetToolsUI.openImport({ datasetItemId: Number(button.dataset.curationReview), api, onSaved: load });
      else if (button.hasAttribute('data-curation-clear')) { selected.clear(); buttons(); }
      else if (button.hasAttribute('data-curation-exclude')) await move(true);
      else if (button.hasAttribute('data-curation-restore')) await move(false);
      else if (button.hasAttribute('data-curation-delete')) await remove();
      else if (button.hasAttribute('data-curation-reset')) { for (const key of ['rig', 'pdf', 'page', 'q']) form.elements[key].value = ''; offset = 0; await load(); }
    }
    async function change(event) {
      if (working || loading || destroyed) return;
      if (event.target === form.elements.dataset_id) { for (const key of ['rig', 'pdf', 'page', 'q']) form.elements[key].value = ''; offset = 0; notice(''); await load(); }
      else if (event.target.hasAttribute('data-curation-all')) { selected.clear(); if (event.target.checked) data.items.forEach(row => selected.add(row.dataset_item_id)); buttons(); }
      else if (event.target.dataset.curationItem) { const id = Number(event.target.dataset.curationItem); if (event.target.checked) selected.add(id); else selected.delete(id); buttons(); }
    }
    async function filter(event) { event.preventDefault(); offset = 0; notice(''); await load(); }
    root.addEventListener('click', click); root.addEventListener('change', change); form.addEventListener('submit', filter);
    (async () => { try { const catalog = await api('/api/protect-curation'); if (destroyed) return; form.elements.dataset_id.innerHTML = catalog.datasets.map(dataset => `<option value="${dataset.dataset_id}">${esc(dataset.name)} · ${esc(dataset.status)}</option>`).join('') || '<option value="">Belum ada dataset Protect</option>'; if (catalog.datasets.length) await load(); else { root.querySelector('[data-curation-gallery]').textContent = 'Impor foto PDF Protect terlebih dahulu melalui PDF rig.'; buttons(); } } catch (err) { error(err.message); } })();
    return { destroy() { destroyed = true; closeDialog(); root.removeEventListener('click', click); root.removeEventListener('change', change); form.removeEventListener('submit', filter); } };
  }
  window.ProtectCurationUI = Object.freeze({ mount });
})();
