(() => {
  const root = document.getElementById('page-root');
  const loginScreen = document.getElementById('login-screen');
  const appShell = document.getElementById('app-shell');
  const toast = document.getElementById('toast');
  const state = { user: null, view: 'dashboard', analysisId: null, selectedFile: null, objectUrl: null, dbHealth: null, inspectionError: '', areas: [], hazards: [], datasets: [], datasetOffset: 0, datasetLimit: 24, boxes: [], dragStart: null, filter: { q: '', area: '', status: '' } };
  const roleText = { operator: 'Pengguna', admin: 'Administrator' };
  const titles = { dashboard: 'Ringkasan', inspection: 'Pemeriksaan baru', history: 'Riwayat pemeriksaan', datasets: 'Dataset foto', 'dataset-detail': 'Isi dataset', settings: 'Konfigurasi', 'analysis-detail': 'Hasil pemeriksaan' };
  titles.evaluation = 'Evaluasi model';
  titles.learning = 'Belajar dari foto'; titles['rig-dataset'] = 'PDF rig dan calon pelatihan';
  titles['protect-curation'] = 'Kurasi foto Protect';
  titles['inspection-ai'] = 'AI Inspeksi Visual'; titles['pdf-library'] = 'Dataset PDF';
  state.inspectionProfile = 'hemat';
  let toastTimer, pageController, renderGeneration = 0, healthGeneration = 0;
  let inspectionFlight = null, loginFlight = false, logoutFlight = null, authGeneration = 0;
  const pendingForms = new WeakSet();
  function resetDatasetPhoto() {
    if (state.datasetUrl) URL.revokeObjectURL(state.datasetUrl);
    state.datasetUrl = null; state.datasetFile = null; state.datasetReadyFile = null;
    state.boxes = []; state.drawBoxes = null; state.dragStart = null;
  }
  function closePageTools() {
    resetDatasetPhoto();
    pageController?.destroy(); pageController = null;
    window.DatasetToolsUI?.close();
  }

  const sidebar = document.getElementById('sidebar');
  const mobileMenu = document.getElementById('mobile-menu');
  const mobileLayout = window.matchMedia?.('(max-width: 850px)');
  const mainArea = document.querySelector('.main-area');
  const sidebarBackdrop = document.createElement('button');
  sidebarBackdrop.type = 'button'; sidebarBackdrop.className = 'sidebar-backdrop is-hidden'; sidebarBackdrop.tabIndex = -1;
  sidebarBackdrop.setAttribute('aria-label', 'Tutup menu navigasi');
  const sidebarClose = document.createElement('button');
  sidebarClose.type = 'button'; sidebarClose.className = 'sidebar-close';
  sidebarClose.setAttribute('aria-label', 'Tutup menu navigasi'); sidebarClose.textContent = '×';
  appShell.append(sidebarBackdrop); sidebar?.prepend(sidebarClose);
  mobileMenu?.setAttribute('aria-controls', 'sidebar');
  function setSidebarOpen(open, { restoreFocus = false } = {}) {
    if (!sidebar) return;
    const mobile = Boolean(mobileLayout?.matches), visible = mobile && open;
    sidebar.classList.toggle('is-open', visible);
    sidebarBackdrop.classList.toggle('is-hidden', !visible);
    mobileMenu?.setAttribute('aria-expanded', String(visible));
    mobileMenu?.setAttribute('aria-label', visible ? 'Tutup navigasi' : 'Buka navigasi');
    sidebar.inert = mobile && !visible;
    if (mainArea) mainArea.inert = visible;
    if (mobile) sidebar.setAttribute('aria-hidden', String(!visible));
    else sidebar.removeAttribute('aria-hidden');
    if (visible) { sidebar.setAttribute('role', 'dialog'); sidebar.setAttribute('aria-modal', 'true'); sidebar.setAttribute('aria-label', 'Menu navigasi'); sidebarClose.focus(); }
    else { sidebar.removeAttribute('role'); sidebar.removeAttribute('aria-modal'); if (restoreFocus && mobileMenu?.isConnected) mobileMenu.focus(); }
  }
  sidebarBackdrop.addEventListener('click', () => setSidebarOpen(false, { restoreFocus: true }));
  sidebarClose.addEventListener('click', () => setSidebarOpen(false, { restoreFocus: true }));
  mobileLayout?.addEventListener('change', () => setSidebarOpen(false));
  setSidebarOpen(false);
  const brand = document.querySelector('.brand');
  if (brand) { brand.dataset.view = 'dashboard'; brand.setAttribute('aria-label', 'Buka Ringkasan'); }
  document.addEventListener('keydown', event => {
    if (!mobileLayout?.matches || !sidebar?.classList.contains('is-open')) return;
    if (event.key === 'Escape') { event.preventDefault(); setSidebarOpen(false, { restoreFocus: true }); }
    else if (event.key === 'Tab') {
      const controls = [...sidebar.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled)')];
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });

  const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = async (url, options = {}) => {
    let response;
    try { response = await fetch(url, { credentials: 'same-origin', ...options }); }
    catch { throw Object.assign(new Error('Server lokal belum dapat dihubungi. Pastikan aplikasi sedang berjalan, lalu coba lagi.'), { status: 0, code: 'SERVER_UNREACHABLE' }); }
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data?.error || 'Permintaan belum dapat diproses.'), { status: response.status, code: data?.code || '' });
    return data;
  };
  const showToast = (message, error = false) => {
    toast.textContent = message;
    toast.classList.toggle('is-error', error);
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3600);
  };
  const initials = name => (name || 'K3').split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase();
  const formatDate = value => value ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`)) : '—';
  const statusLabel = status => ({ HAZARD_FOUND: 'Indikasi berisiko ditemukan', REVIEW_REQUIRED: 'Perlu perhatian', NO_VISIBLE_HAZARD: 'Tidak tampak indikasi bahaya', UNABLE_TO_ASSESS: 'Belum dapat dinilai', FAILED: 'Analisis gagal' }[status] || status || '—');
  const statusClass = status => ({ HAZARD_FOUND: 'status--found', REVIEW_REQUIRED: 'status--unassessed', NO_VISIBLE_HAZARD: 'status--none', UNABLE_TO_ASSESS: 'status--unassessed', FAILED: 'status--failed' }[status] || '');
  const areaLabel = type => type === 'GUDANG' ? 'Gudang' : type === 'KANTOR' ? 'Kantor' : type === 'RIG' ? 'Rig' : type || '—';
  const severityLabel = severity => ({ TINGGI: 'Tinggi', SEDANG: 'Sedang', RENDAH: 'Rendah' }[severity] || severity || '—');
  const feedbackLabel = label => ({ TIDAK_AMAN: 'Ditandai tidak aman', TIDAK_TAMPAK_BAHAYA: 'Tidak tampak bahaya', RAGU: 'Masih ragu' }[label] || 'Belum ada koreksi');
  function modelOptions(models = []) {
    if (!models.length) return '<option value="">Ollama belum menyediakan model visi</option>';
    const preferred = models.find(model => model.name === 'gemma3:4b')?.name || models[0].name;
    return models.map(model => `<option value="${escapeHtml(model.name)}" ${model.name === preferred ? 'selected' : ''}>${escapeHtml(model.name)}${model.parameter_size ? ` · ${escapeHtml(model.parameter_size)}` : ''}</option>`).join('');
  }

  const databaseStatusLabel = health => health?.database === 'ready' ? 'Tersambung' : health?.database === 'schema_pending' ? 'Perlu disiapkan' : health?.database === 'permission_denied' ? 'Akses tulis terbatas' : health ? 'Belum tersambung' : 'Sedang diperiksa';
  function databaseStatusContent(health = state.dbHealth) {
    const ready = health?.database === 'ready';
    const detail = ready ? 'Tabel pemeriksaan dan izin penyimpanan siap.' : health?.error || (health ? 'Pastikan SQL Server lokal berjalan, lalu coba lagi.' : 'Memeriksa tempat penyimpanan lokal…');
    const technical = /Sqlcmd:|ODBC Driver|Msg \d+, Level/.test(detail);
    const description = technical ? 'Koneksi database gagal. Jalankan aplikasi dengan akun Windows yang digunakan untuk mengakses SQL Server di SSMS.' : detail;
    return `<div class="connection-status-head"><span><span class="status-dot ${ready ? '' : 'status-dot--amber'}"></span><strong>SQL Server lokal</strong></span><span>${escapeHtml(databaseStatusLabel(health))}</span></div><p>${escapeHtml(description)}</p>${technical ? `<details><summary>Detail kesalahan SQL</summary><p>${escapeHtml(detail)}</p></details>` : ''}`;
  }
  const databaseStatusPanel = () => `<div class="connection-status" data-db-status-panel aria-live="polite">${databaseStatusContent()}</div>`;
  function updateDatabaseStatus() {
    document.querySelectorAll('[data-db-status-panel]').forEach(panel => { panel.innerHTML = databaseStatusContent(); });
    if (state.user) updateChrome();
  }
  async function refreshDatabaseHealth() {
    const generation = ++healthGeneration;
    let health;
    try { health = await api('/api/health', { cache: 'no-store' }); }
    catch (error) { health = { database: 'unavailable', error: error.message || 'Server lokal belum dapat dihubungi.' }; }
    if (generation === healthGeneration) { state.dbHealth = health; updateDatabaseStatus(); }
    return health;
  }
  async function loadWithDatabaseHealth(urls) {
    const [results] = await Promise.all([Promise.allSettled(urls.map(url => api(url))), refreshDatabaseHealth()]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    return results.map(result => result.value);
  }
  function showInspectionError(message = '') {
    state.inspectionError = message;
    const alert = document.getElementById('inspection-error');
    if (alert) { alert.textContent = message; alert.classList.toggle('is-hidden', !message); }
  }
  const inspectionErrorPanel = () => `<div id="inspection-error" class="analysis-error ${state.inspectionError ? '' : 'is-hidden'}" role="alert">${escapeHtml(state.inspectionError)}</div><p id="inspection-progress" class="inspection-progress is-hidden" role="status" aria-live="polite"></p>`;
  const cameraSourceControls = () => `<div class="photo-source-actions"><button class="btn btn-secondary" id="inspection-camera" type="button"><span aria-hidden="true">▣</span> Ambil foto</button><p class="hint-text">Gunakan kamera laptop / USB atau pilih berkas di atas.</p></div>`;

  function resetInspectionPhoto() {
    window.InspectionCamera?.close({ restoreFocus: false });
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
    state.selectedFile = null;
    state.inspectionError = '';
  }

  function showLogin(errorText = '') {
    const localDemo = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) && location.protocol === 'http:';
    renderGeneration += 1; authGeneration += 1; state.user = null;
    clearTimeout(searchTimer);
    closePageTools();
    resetInspectionPhoto();
    setSidebarOpen(false);
    document.querySelectorAll('dialog.archive-dialog, dialog.form-dialog').forEach(dialog => { dialog.close(); dialog.remove(); });
    root.innerHTML = ''; root.removeAttribute('aria-busy');
    state.deleteNotice = '';
    state.datasetDeleteNotice = '';
    appShell.classList.add('is-hidden');
    loginScreen.classList.remove('is-hidden');
    loginScreen.innerHTML = `
      <form class="login-card" id="login-form">
        <div class="login-brand"><strong class="login-title">Inspeksi Lokal</strong></div>
        <p class="eyebrow">RUANG KERJA INSPEKSI LOKAL</p><h1>Selamat datang</h1><p class="page-subtitle">Masuk untuk menganalisis foto dengan model visi lokal dan menyimpan koreksi label.</p>
        <label class="inline-label" for="login-email">Email</label><input class="field" id="login-email" name="email" type="email" autocomplete="username" value="${localDemo ? 'operator@k3.local' : ''}" required>
        <label class="inline-label" for="login-password">Kata sandi</label><input class="field" id="login-password" name="password" type="password" autocomplete="current-password" value="${localDemo ? 'K3-demo-2026' : ''}" required>
        ${errorText ? `<p class="form-error" role="alert">${escapeHtml(errorText)}</p>` : ''}
        ${databaseStatusPanel()}
        <button class="btn btn-primary" style="width:100%;margin-top:17px" type="submit" ${logoutFlight || loginFlight ? 'disabled' : ''}>${logoutFlight ? 'Menyelesaikan keluar…' : 'Masuk ke workspace <span class="btn-icon">→</span>'}</button>
        ${localDemo ? '<div class="login-demo"><strong>Akun demonstrasi lokal</strong><br>Pengguna: operator@k3.local · Admin: admin@k3.local<br>Kata sandi: <strong>K3-demo-2026</strong></div>' : ''}
        <div class="login-note"><span>▣</span><span>Gunakan akun yang diberikan administrator dan foto yang diizinkan untuk pemeriksaan.</span></div>
      </form>`;
  }

  function updateChrome() {
    if (!state.user) return;
    document.getElementById('user-name').textContent = state.user.full_name;
    document.getElementById('user-role').textContent = roleText[state.user.role] || state.user.role;
    document.getElementById('avatar-initials').textContent = initials(state.user.full_name);
    document.getElementById('today-label').textContent = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
    document.getElementById('breadcrumb-current').textContent = titles[state.view] || 'Ringkasan';
    const statusTitle = document.getElementById('model-status-title');
    const statusDetail = document.getElementById('model-status-detail');
    const statusDot = document.getElementById('model-status-dot');
    if (statusTitle && statusDetail && statusDot) {
      const models = state.ai?.vision_models || [];
      const connected = Boolean(state.ai?.available && models.length);
      statusTitle.textContent = connected ? 'Ollama terhubung' : 'Model vision belum aktif';
      statusDetail.textContent = connected ? `${models.length} model siap dipilih` : 'Jalankan Ollama dan pasang model vision';
      statusDot.classList.toggle('status-dot--amber', !connected);
      let databaseStatus = document.getElementById('database-sidebar-status');
      if (!databaseStatus) {
        databaseStatus = document.createElement('div'); databaseStatus.id = 'database-sidebar-status'; databaseStatus.className = 'model-status';
        statusTitle.closest('.model-status').after(databaseStatus);
      }
      databaseStatus.innerHTML = `<span class="status-dot ${state.dbHealth?.database === 'ready' ? '' : 'status-dot--amber'}"></span><span><strong>SQL Server · ${escapeHtml(databaseStatusLabel(state.dbHealth))}</strong><small>${state.dbHealth?.database === 'ready' ? 'Penyimpanan foto dan hasil siap' : state.dbHealth?.database === 'schema_pending' ? 'Struktur database belum lengkap' : 'Penyimpanan lokal belum siap'}</small></span>`;
    }
    document.querySelectorAll('.nav-link').forEach(button => {
      const active = button.dataset.view === (state.view === 'analysis-detail' ? 'history' : ['dataset-detail', 'public-datasets', 'object-dataset-detail'].includes(state.view) ? 'datasets' : state.view);
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    appShell.classList.remove('is-hidden');
    loginScreen.classList.add('is-hidden');
  }

  function pageHead(kicker, title, subtitle, action = '') {
    return `<div class="page-head"><div><p class="eyebrow">${escapeHtml(kicker)}</p><h1>${escapeHtml(title)}</h1><p class="page-subtitle">${escapeHtml(subtitle)}</p></div>${action}</div>`;
  }
  function emptyState(title, text, icon = '◷') {
    return `<div class="empty-state"><div><span class="empty-icon">${icon}</span><strong>${escapeHtml(title)}</strong><p>${escapeHtml(text)}</p></div></div>`;
  }
  function renderAnalysisRows(rows, { archived = false } = {}) {
    if (!rows?.length) return emptyState(archived ? 'Arsip dihapus masih kosong' : 'Belum ada pemeriksaan', archived ? 'Pemeriksaan yang dihapus admin akan muncul di sini dan dapat dipulihkan.' : 'Unggah foto pertama untuk mulai menyimpan riwayat pemeriksaan.');
    const admin = state.user?.role === 'admin';
    return `<div class="table-scroll"><table><thead><tr><th>Foto & area</th><th>Waktu</th><th>Status AI</th><th>Koreksi pengguna</th>${admin ? '<th>Aksi admin</th>' : ''}</tr></thead><tbody>${rows.map(item => {
      const isArchived = Boolean(item.archived || item.archived_at);
      return `<tr data-analysis-id="${item.analysis_id}"><td><button type="button" class="table-title analysis-open" data-open-analysis="${item.analysis_id}" aria-label="Buka pemeriksaan ${escapeHtml(item.original_name || 'foto')}">${escapeHtml(item.original_name || 'Foto pemeriksaan')}</button><span class="table-subtitle">${escapeHtml(item.area_name || '—')} · ${areaLabel(item.area_type)}</span>${isArchived ? '<span class="archive-tag">Diarsipkan</span>' : ''}</td><td>${escapeHtml(formatDate(item.analyzed_at))}${isArchived ? `<span class="table-subtitle">Dihapus ${escapeHtml(formatDate(item.archived_at))}</span>` : ''}</td><td><span class="status-pill ${statusClass(item.result_status)}">${escapeHtml(statusLabel(item.result_status))}</span></td><td>${item.feedback_label ? `<span class="role-tag">${escapeHtml(feedbackLabel(item.feedback_label))}</span>` : '<span class="table-subtitle">Belum diberi label</span>'}</td>${admin ? `<td><div class="row-actions"><button type="button" class="btn btn-secondary btn-small row-action" data-archive-analysis="${item.analysis_id}" data-archive-value="${isArchived ? 'false' : 'true'}" data-photo-name="${escapeHtml(item.original_name || 'Foto pemeriksaan')}" aria-label="${isArchived ? 'Pulihkan' : 'Hapus'} ${escapeHtml(item.original_name || 'pemeriksaan')}">${isArchived ? '↶ Pulihkan' : 'Hapus'}</button>${isArchived ? permanentDeleteButton(item.analysis_id, item.original_name, true) : ''}</div></td>` : ''}</tr>`;
    }).join('')}</tbody></table></div>`;
  }

  function permanentDeleteButton(id, name, compact = false) {
    return `<button type="button" class="btn btn-danger ${compact ? 'btn-small row-action' : ''}" data-delete-analysis="${id}" data-photo-name="${escapeHtml(name || 'Foto pemeriksaan')}" aria-label="Delete permanen ${escapeHtml(name || 'pemeriksaan')}">Delete</button>`;
  }

  function datasetDeleteButton(dataset) {
    if (state.user?.role !== 'admin') return '';
    return `<button type="button" class="btn btn-danger btn-small" data-delete-dataset="${dataset.dataset_id}" data-dataset-name="${escapeHtml(dataset.name)}" data-dataset-version="${escapeHtml(dataset.version)}" data-dataset-kind="${escapeHtml(dataset.dataset_kind || 'HAZARD')}" data-dataset-count="${Number(dataset.item_count || 0)}" aria-label="Hapus seluruh dataset ${escapeHtml(dataset.name)}">Hapus dataset</button>`;
  }

  function datasetCard(dataset) {
    const status = { DRAFT: 'Draft', REVIEW: 'Dalam tinjauan', APPROVED: 'Disetujui', ARCHIVED: 'Diarsipkan' }[dataset.status] || dataset.status;
    return `<article class="card dataset-card"><div style="display:flex;justify-content:space-between;gap:10px"><div><h3>${escapeHtml(dataset.name)}</h3><p>${dataset.dataset_kind === 'PPE_OBJECT' ? 'Objek / APD' : 'Label bahaya'} · Versi ${escapeHtml(dataset.version)} · dibuat ${escapeHtml(formatDate(dataset.created_at))}</p></div><span class="role-tag">${escapeHtml(status)}</span></div><div class="dataset-card-foot"><span>${Number(dataset.item_count).toLocaleString('id-ID')} foto · ${Number(dataset.verified_count).toLocaleString('id-ID')} terverifikasi</span><div class="row-actions"><button type="button" class="quiet-link" data-dataset-items="${dataset.dataset_id}">Lihat foto →</button>${datasetDeleteButton(dataset)}</div></div></article>`;
  }

  function openDatasetDeleteDialog(button) {
    if (state.user?.role !== 'admin') return;
    const owner = state.user, generation = renderGeneration;
    const isCurrent = () => state.user === owner && renderGeneration === generation;
    window.InspectionCamera?.close({ restoreFocus: false });
    const id = button.dataset.deleteDataset, name = button.dataset.datasetName;
    const version = button.dataset.datasetVersion || '-';
    const count = Number(button.dataset.datasetCount || 0).toLocaleString('id-ID');
    const publicDataset = button.dataset.datasetKind === 'PPE_OBJECT';
    const dialog = document.createElement('dialog');
    dialog.className = 'archive-dialog permanent-delete-dialog dataset-delete-dialog';
    dialog.setAttribute('aria-labelledby', 'dataset-delete-title');
    dialog.setAttribute('aria-describedby', 'dataset-delete-description');
    dialog.innerHTML = `<div class="archive-dialog-icon" aria-hidden="true">×</div><p class="eyebrow">AKSI ADMIN</p><h2 id="dataset-delete-title">Hapus seluruh dataset ini secara permanen?</h2><div class="archive-photo-name"><strong>${escapeHtml(name)}</strong><small>Versi ${escapeHtml(version)} · ${count} foto · ${publicDataset ? 'Objek / APD' : 'Label bahaya'}</small></div><p id="dataset-delete-description">Dataset, seluruh foto berlabel, anotasi, dan riwayat evaluasinya akan dihapus dari database. Tindakan ini tidak dapat dipulihkan.</p><p class="archive-audit-note">Foto yang masih dipakai pemeriksaan, dataset lain, atau evaluasi lain tetap tersimpan. Penghapusan dicatat beserta akun admin dan waktunya.</p>${publicDataset ? '<p class="dataset-delete-source-note">Paket sumber dan pelatihan lokal tetap tersedia. Dataset ini tidak diimpor lagi secara otomatis; impor ulang dinonaktifkan.</p>' : ''}<p class="dataset-delete-progress is-hidden" data-dataset-delete-progress role="status" aria-live="polite">Sedang menghapus dataset. Proses dapat memerlukan waktu untuk dataset besar.</p><div class="analysis-error is-hidden" data-dataset-delete-error role="alert"></div><div class="archive-dialog-actions"><button type="button" class="btn btn-secondary" data-dataset-delete-cancel autofocus>Batal</button><button type="button" class="btn btn-danger" data-dataset-delete-confirm>Delete permanen</button></div>`;
    let busy = false;
    const confirm = dialog.querySelector('[data-dataset-delete-confirm]');
    const cancel = dialog.querySelector('[data-dataset-delete-cancel]');
    const errorPanel = dialog.querySelector('[data-dataset-delete-error]');
    const progress = dialog.querySelector('[data-dataset-delete-progress]');
    cancel.addEventListener('click', () => { if (!busy) dialog.close(); });
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => { dialog.remove(); if (button.isConnected) button.focus(); }, { once: true });
    confirm.addEventListener('click', async () => {
      if (busy || confirm.disabled || !isCurrent()) return;
      busy = true; confirm.disabled = true; cancel.disabled = true;
      confirm.textContent = 'Menghapus…';
      errorPanel.classList.add('is-hidden'); progress.classList.remove('is-hidden');
      let result;
      try {
        result = await api(`/api/datasets/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permanent: true, confirmation_name: name }) });
        if (result?.deleted !== true || String(result.dataset_id) !== String(id)) throw Object.assign(new Error('Hasil penghapusan belum terkonfirmasi. Tutup popup dan muat ulang daftar dataset.'), { code: 'DATASET_DELETE_RESULT_UNKNOWN' });
      } catch (error) {
        if (!isCurrent()) { dialog.close(); return; }
        if (error.status === 401) { showLogin('Sesi berakhir. Silakan masuk kembali.'); return; }
        busy = false; cancel.disabled = false; confirm.disabled = false;
        confirm.textContent = 'Delete permanen'; progress.classList.add('is-hidden');
        const uncertain = error.status === 0 || error.status === 503 || error.code === 'DATASET_DELETE_RESULT_UNKNOWN';
        errorPanel.textContent = error.status === 404 && error.message === 'Endpoint tidak ditemukan.' ? 'Mulai ulang server dengan start-local.cmd untuk mengaktifkan penghapusan dataset, lalu muat ulang halaman.' : uncertain ? 'Hasil penghapusan belum dapat dipastikan. Tutup popup lalu muat ulang daftar dataset sebelum mencoba kembali.' : error.message;
        if (uncertain || error.status === 404 || error.code === 'DATASET_DELETE_NAME_MISMATCH') confirm.disabled = true;
        errorPanel.classList.remove('is-hidden'); return;
      }
      busy = false; dialog.close();
      if (!isCurrent()) return;
      state.datasetId = null; state.view = 'datasets';
      state.datasetDeleteNotice = result.cleanup_warning || '';
      const refresh = render(), refreshedGeneration = renderGeneration;
      await refresh;
      if (state.user !== owner || renderGeneration !== refreshedGeneration) return;
      showToast(result.cleanup_warning ? 'Dataset dihapus. Sebagian berkas foto perlu diperhatikan.' : 'Seluruh dataset dihapus permanen.');
    });
    document.body.append(dialog); dialog.showModal();
  }

  function openPermanentDeleteDialog(button) {
    if (state.user?.role !== 'admin') return;
    const owner = state.user, generation = renderGeneration;
    const isCurrent = () => state.user === owner && renderGeneration === generation;
    window.InspectionCamera?.close({ restoreFocus: false });
    const id = button.dataset.deleteAnalysis;
    const name = button.dataset.photoName || 'Foto pemeriksaan';
    const dialog = document.createElement('dialog');
    dialog.className = 'archive-dialog permanent-delete-dialog';
    dialog.setAttribute('aria-labelledby', 'permanent-delete-title');
    dialog.setAttribute('aria-describedby', 'permanent-delete-description');
    dialog.innerHTML = `<div class="archive-dialog-icon" aria-hidden="true">×</div><p class="eyebrow">AKSI ADMIN</p><h2 id="permanent-delete-title">Yakin ingin menghapus data ini secara permanen?</h2><p class="archive-photo-name">${escapeHtml(name)}</p><p id="permanent-delete-description">Data pemeriksaan, hasil AI, temuan, dan koreksi akan dihapus dari database dan tidak dapat dipulihkan melalui aplikasi.</p><p class="archive-audit-note">Foto yang masih digunakan pemeriksaan lain atau dataset tetap tersimpan. Tindakan ini dicatat beserta akun admin dan waktunya.</p><div class="analysis-error is-hidden" data-delete-error role="alert"></div><div class="archive-dialog-actions"><button type="button" class="btn btn-secondary" data-delete-cancel autofocus>Batal</button><button type="button" class="btn btn-danger" data-delete-confirm>Delete permanen</button></div>`;
    let busy = false;
    dialog.querySelector('[data-delete-cancel]').addEventListener('click', () => { if (!busy) dialog.close(); });
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => { dialog.remove(); if (button.isConnected) button.focus(); }, { once: true });
    dialog.querySelector('[data-delete-confirm]').addEventListener('click', async () => {
      if (busy || !isCurrent()) return;
      busy = true;
      const controls = [...dialog.querySelectorAll('button')];
      const confirm = dialog.querySelector('[data-delete-confirm]');
      controls.forEach(control => { control.disabled = true; });
      dialog.querySelector('[data-delete-error]').classList.add('is-hidden');
      confirm.textContent = 'Menghapus…';
      let result;
      try {
        result = await api(`/api/analyses/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permanent: true }) });
        if (result?.deleted !== true) throw Object.assign(new Error('Penghapusan permanen belum dikonfirmasi oleh server. Muat ulang riwayat sebelum mencoba lagi.'), { code: 'DELETE_RESULT_UNKNOWN' });
      } catch (error) {
        if (!isCurrent()) { dialog.close(); return; }
        if (error.status === 401) { showLogin('Sesi berakhir. Silakan masuk kembali.'); return; }
        busy = false;
        controls.forEach(control => { control.disabled = false; });
        confirm.textContent = 'Delete permanen';
        const alert = dialog.querySelector('[data-delete-error]');
        alert.textContent = error.status === 404 && error.message === 'Endpoint tidak ditemukan.' ? 'Server lokal perlu dimulai ulang untuk mengaktifkan Delete permanen. Hentikan server lama, lalu jalankan start-local.cmd.' : error.status === 0 ? 'Server belum memberikan konfirmasi penghapusan. Tutup dialog lalu muat ulang arsip untuk memeriksa status data sebelum mencoba kembali.' : error.message;
        if (error.status === 0 || error.status === 503 || error.code === 'DELETE_RESULT_UNKNOWN') confirm.disabled = true;
        alert.classList.remove('is-hidden');
        return;
      }
      busy = false;
      dialog.close();
      if (!isCurrent()) return;
      state.analysisId = null;
      state.view = 'history';
      state.historyArchived = true;
      state.deleteNotice = result.cleanup_warning || '';
      const refresh = render(), refreshedGeneration = renderGeneration;
      await refresh;
      if (state.user !== owner || renderGeneration !== refreshedGeneration) return;
      showToast(result.cleanup_warning ? 'Data pemeriksaan dihapus. Pembersihan foto perlu diperhatikan.' : 'Pemeriksaan dihapus permanen dari database.');
    });
    document.body.append(dialog);
    dialog.showModal();
  }

  function openArchiveDialog(button) {
    if (state.user?.role !== 'admin') return;
    const owner = state.user, generation = renderGeneration;
    const isCurrent = () => state.user === owner && renderGeneration === generation;
    window.InspectionCamera?.close({ restoreFocus: false });
    const id = button.dataset.archiveAnalysis;
    const archived = button.dataset.archiveValue === 'true';
    const name = button.dataset.photoName || 'Foto pemeriksaan';
    const dialog = document.createElement('dialog');
    dialog.className = 'archive-dialog';
    dialog.setAttribute('aria-labelledby', 'archive-dialog-title');
    dialog.setAttribute('aria-describedby', 'archive-dialog-description');
    dialog.innerHTML = `<div class="archive-dialog-icon" aria-hidden="true">${archived ? '▣' : '↶'}</div><p class="eyebrow">AKSI ADMIN</p><h2 id="archive-dialog-title">${archived ? 'Hapus pemeriksaan ini?' : 'Pulihkan pemeriksaan ini?'}</h2><p class="archive-photo-name">${escapeHtml(name)}</p><p id="archive-dialog-description">${archived ? 'Pemeriksaan dipindahkan ke Arsip dihapus. Foto, hasil AI, dan koreksi tetap tersimpan dan bisa dipulihkan oleh admin.' : 'Pemeriksaan akan kembali muncul pada riwayat aktif dan dapat digunakan untuk koreksi.'}</p><p class="archive-audit-note">Aksi ini dicatat beserta akun admin dan waktunya.</p><div class="analysis-error is-hidden" data-archive-error role="alert"></div><div class="archive-dialog-actions"><button type="button" class="btn btn-secondary" data-archive-cancel autofocus>Batal</button><button type="button" class="btn ${archived ? 'btn-danger' : 'btn-primary'}" data-archive-confirm>${archived ? 'Hapus ke arsip' : 'Pulihkan pemeriksaan'}</button></div>`;
    let busy = false;
    const close = () => { if (!busy) dialog.close(); };
    dialog.querySelector('[data-archive-cancel]').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => { dialog.remove(); if (button.isConnected) button.focus(); }, { once: true });
    dialog.querySelector('[data-archive-confirm]').addEventListener('click', async () => {
      if (busy || !isCurrent()) return;
      busy = true;
      const controls = [...dialog.querySelectorAll('button')];
      controls.forEach(control => { control.disabled = true; });
      const confirm = dialog.querySelector('[data-archive-confirm]');
      confirm.textContent = 'Menyimpan…';
      try {
        await api(`/api/analyses/${id}/archive`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived }) });
        busy = false;
        dialog.close();
        if (!isCurrent()) return;
        const refresh = render(), refreshedGeneration = renderGeneration;
        await refresh;
        if (state.user !== owner || renderGeneration !== refreshedGeneration) return;
        showToast(archived ? 'Pemeriksaan dipindahkan ke arsip. Admin dapat memulihkannya.' : 'Pemeriksaan dipulihkan ke riwayat aktif.');
      } catch (error) {
        if (!isCurrent()) { dialog.close(); return; }
        if (error.status === 401) { showLogin('Sesi berakhir. Silakan masuk kembali.'); return; }
        busy = false;
        controls.forEach(control => { control.disabled = false; });
        confirm.textContent = archived ? 'Hapus ke arsip' : 'Pulihkan pemeriksaan';
        const alert = dialog.querySelector('[data-archive-error]');
        alert.textContent = error.status === 404 && error.message === 'Endpoint tidak ditemukan.' ? 'Server lokal perlu dimulai ulang untuk mengaktifkan fungsi arsip. Hentikan server lama, lalu jalankan start-local.cmd.' : error.message;
        alert.classList.remove('is-hidden');
      }
    });
    document.body.append(dialog);
    dialog.showModal();
  }
  function inspectionUploadCard(areas, models = [], compact = false) {
    return `<form class="${compact ? 'upload-card card' : 'form-card card'}" id="inspection-form">
      <div class="card-title-row"><div><p class="section-kicker">LANGKAH 1</p><h2 class="card-title">Pilih area dan foto</h2><p class="card-caption">Pastikan objek dan konteks area terlihat jelas.</p></div><span class="nav-icon" style="color:#596b83;font-size:21px">⌖</span></div>
      <label class="inline-label" for="inspection-area">Lokasi kerja</label><select class="select-field" id="inspection-area" name="work_area_id" required><option value="">Pilih area…</option>${areas.map(area => `<option value="${area.work_area_id}">${escapeHtml(area.name)} — ${areaLabel(area.area_type)}</option>`).join('')}</select>
      <details class="inspection-options"><summary>Pengaturan analisis</summary><label class="inline-label" for="vision-model">Model visi lokal</label><select class="select-field" id="vision-model" name="vision_model">${modelOptions(models)}</select><p class="hint-text">Daftar ini hanya menampilkan model Ollama yang mendukung gambar.</p>
      ${inspectionProfileControls()}<label class="inline-label" for="inspection-examples">Contoh terverifikasi</label><select class="select-field" id="inspection-examples" name="use_examples"><option value="on">Gunakan contoh dari area yang sama</option><option value="off">Model dasar · lebih ringan</option></select></details>
      <label class="dropzone" id="inspection-dropzone"><span class="drop-icon">↥</span><span class="drop-copy"><strong id="inspection-file-title">Pilih atau letakkan foto di sini</strong><small>JPG, PNG, WebP · maks. 8 MB</small></span><span class="drop-file" id="inspection-file-name"></span><input id="inspection-file" name="image" type="file" accept="image/jpeg,image/png,image/webp" aria-label="Pilih foto"></label>
      ${cameraSourceControls()}
      <div id="inspection-preview-wrap" class="is-hidden" style="margin-top:11px"><img id="inspection-preview" alt="Pratinjau foto" style="max-height:230px;max-width:100%;border-radius:8px;object-fit:contain"></div>
      ${databaseStatusPanel()}${inspectionErrorPanel()}
      <div class="upload-controls"><p class="hint-text">Foto dikirim ke Ollama pada laptop ini dan diproses lokal. Metadata EXIF dihapus saat penyimpanan.</p><button class="btn btn-primary" type="submit"><span class="btn-icon">✦</span> Analisis dengan AI</button></div>
    </form>`;
  }

  function inspectionProfileControls() {
    return `<label class="inline-label" for="inspection-profile">Mode analisis</label><select class="select-field" id="inspection-profile" name="performance_profile"><option value="hemat" ${state.inspectionProfile !== 'detail' ? 'selected' : ''}>Hemat · pemakaian lebih ringan</option><option value="detail" ${state.inspectionProfile === 'detail' ? 'selected' : ''}>Detail · tinjau objek kecil</option></select><p class="hint-text" id="inspection-profile-note">${state.inspectionProfile === 'detail' ? 'AI menerima foto maksimal 1.024 piksel untuk meninjau detail. Pemrosesan dapat lebih lama.' : 'AI menerima foto maksimal 768 piksel agar proses lebih ringan.'} Foto asli tetap tersimpan.</p>`;
  }

  async function renderDashboard(context) {
    const [data, areaData, ai] = await loadWithDatabaseHealth(['/api/dashboard', '/api/areas', '/api/ai/status']);
    if (!context.isCurrent()) return;
    state.areas = areaData.areas; state.ai = ai;
    root.innerHTML = `${pageHead('RINGKASAN HARI INI', 'Pemeriksaan K3', 'Pantau inspeksi visual gudang dan kantor dalam satu ruang kerja.', '<button class="btn btn-primary" data-view="inspection"><span class="btn-icon">+</span> Pemeriksaan baru</button>')}
      <div class="stats-grid">
        <article class="card stat-card"><div class="stat-top"><span>Total pemeriksaan</span><span class="stat-icon">◷</span></div><p class="stat-number">${data.stats.total}</p><p class="stat-note">tersimpan di perangkat ini</p></article>
        <article class="card stat-card"><div class="stat-top"><span>Koreksi tersimpan</span><span class="stat-icon" style="color:#6b4bac;background:#f1ecff">◎</span></div><p class="stat-number">${data.stats.feedback_count}</p><p class="stat-note">label pengguna untuk evaluasi model</p></article>
        <article class="card stat-card"><div class="stat-top"><span>Bahaya terdeteksi</span><span class="stat-icon" style="color:#a83a45;background:#fff0f1">⌁</span></div><p class="stat-number">${data.stats.found}</p><p class="stat-note">indikasi yang terlihat pada foto</p></article>
        <article class="card stat-card"><div class="stat-top"><span>Dataset terkurasi</span><span class="stat-icon">▤</span></div><p class="stat-number">${data.stats.dataset_items}</p><p class="stat-note">foto berlabel dan bersumber</p></article>
      </div>
      <div class="dashboard-grid">
        <div class="card upload-card">
          <div class="card-title-row"><div><p class="section-kicker">PEMERIKSAAN VISUAL</p><h2 class="card-title">Mulai dengan satu foto</h2><p class="card-caption">Pilih lokasi, unggah foto, lalu tinjau hasil awal.</p></div><span class="nav-icon" style="color:#596b83;font-size:21px">⌖</span></div>
          <label class="inline-label" for="inspection-area">Area kerja</label><select class="select-field" id="inspection-area" form="inspection-form" name="work_area_id"><option value="">Pilih area…</option>${state.areas.map(area => `<option value="${area.work_area_id}">${escapeHtml(area.name)} — ${areaLabel(area.area_type)}</option>`).join('')}</select>
          <form id="inspection-form"><input type="hidden" name="work_area_id" id="inspection-area-hidden"></form>
          <label class="dropzone" id="inspection-dropzone"><span class="drop-icon">↥</span><span class="drop-copy"><strong id="inspection-file-title">Pilih foto untuk diperiksa</strong><small>JPG, PNG, WebP · maks. 8 MB</small></span><span class="drop-file" id="inspection-file-name"></span><input id="inspection-file" type="file" accept="image/jpeg,image/png,image/webp" aria-label="Pilih foto"></label>
          ${cameraSourceControls()}
          <div id="inspection-preview-wrap" class="is-hidden" style="margin-top:10px"><img id="inspection-preview" alt="Pratinjau foto" style="max-height:200px;max-width:100%;border-radius:8px;object-fit:contain"></div>
          <label class="inline-label" for="vision-model">Model visi lokal</label><select class="select-field" id="vision-model">${modelOptions(ai.vision_models)}</select>
          ${inspectionProfileControls()}
          ${databaseStatusPanel()}${inspectionErrorPanel()}
          <div class="upload-controls"><p class="hint-text">${ai.available && ai.vision_models.length ? 'Foto diproses oleh Ollama di laptop ini.' : 'Ollama atau model visi lokal belum tersedia.'}</p><button class="btn btn-primary" id="dashboard-inspect" type="button"><span class="btn-icon">✦</span> Analisis dengan AI</button></div>
        </div>
        <div class="right-stack">
          <article class="card model-card"><div class="card-title-row" style="margin-bottom:0"><div><h2 class="card-title">Ollama lokal</h2><p class="card-caption">Model yang bisa membaca gambar</p></div></div><div style="margin-top:12px"><span class="model-chip"><span class="status-dot ${ai.available && ai.vision_models.length ? '' : 'status-dot--amber'}"></span>${ai.available && ai.vision_models.length ? `${ai.vision_models.length} model visi tersedia` : 'Belum tersambung'}</span></div><div class="model-explain"><span class="model-explain-icon">ⓘ</span><p>${ai.available && ai.vision_models.length ? `${escapeHtml(ai.vision_models.map(model => model.name).join(', '))}. Pilih model saat mengunggah foto.` : escapeHtml(ai.error || 'Pasang model lokal berkemampuan vision pada Ollama untuk menganalisis foto.')}</p></div></article>
          <article class="card quick-guide"><div class="card-title-row" style="margin-bottom:6px"><div><h2 class="card-title">Memahami status</h2><p class="card-caption">Setiap status punya arti yang berbeda.</p></div></div><div class="guide-row"><span class="guide-dot orange"></span><span><strong>Belum dapat dinilai</strong><small>Model belum aktif, foto buram, atau konteks kurang.</small></span></div><div class="guide-row"><span class="guide-dot green"></span><span><strong>Tanpa indikasi yang dikenali</strong><small>Bukan jaminan seluruh area aman.</small></span></div></article>
        </div>
      </div>
      <article class="card table-card" style="margin-top:15px"><div class="card-pad" style="padding-bottom:8px"><div class="card-title-row" style="margin-bottom:7px"><div><h2 class="card-title">Pemeriksaan terbaru</h2><p class="card-caption">Riwayat foto yang baru diunggah</p></div><button class="quiet-link" data-view="history">Lihat semua →</button></div></div>${renderAnalysisRows(data.recent)}</article>
      <div class="warning-banner" style="margin-top:14px"><span>ⓘ</span><span>Jika AI belum memahami foto rig, gunakan Ajarkan foto ini. Label yang diverifikasi menjadi contoh visual; pelatihan bobot tersedia setelah data siap.</span></div>`;
    wireInspectionForm({ compact: true });
  }

  async function renderInspection(context) {
    const [areaData, ai] = await loadWithDatabaseHealth(['/api/areas', '/api/ai/status']);
    if (!context.isCurrent()) return;
    state.areas = areaData.areas;
    state.ai = ai;
    root.innerHTML = `${pageHead('PEMERIKSAAN BARU', 'Analisis foto area kerja', 'Pilih area dan foto. Jika AI belum mengenali peralatannya, ajarkan lewat foto yang sudah Anda verifikasi.', '')}
      <div class="section-grid"><div>${inspectionUploadCard(state.areas, ai.vision_models)}</div><div class="right-stack"><article class="card card-pad"><p class="section-kicker">PEMROSESAN LOKAL</p><h2 class="card-title">Model VLM</h2><p class="card-caption" style="line-height:1.6;margin-top:9px">Foto dikirim hanya ke Ollama pada laptop ini. Model dan waktu inferensi dicatat pada hasil.</p><div style="height:1px;background:#e6ecf5;margin:15px 0"></div><div class="meta-row"><span>Status Ollama</span><strong>${ai.available ? 'Tersambung' : 'Belum tersambung'}</strong></div><div class="meta-row"><span>Model vision</span><strong>${ai.vision_models.length} tersedia</strong></div><div class="meta-row"><span>Model teks saja</span><strong>Tidak ditawarkan untuk foto</strong></div></article><div class="warning-banner"><span>ⓘ</span><span>Model dapat keliru. “Tidak tampak bahaya” bukan sertifikat aman; tandai prediksi agar label koreksi tersimpan.</span></div></div></div>`;
    wireInspectionForm();
  }

  function selectInspectionFile(file, { compact = false, camera = false } = {}) {
    const fileInput = document.getElementById('inspection-file');
    if (!fileInput) return;
    if (file && (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size <= 0 || file.size > 8 * 1024 * 1024)) {
      fileInput.value = '';
      selectInspectionFile(null, { compact });
      showInspectionError('Gunakan foto JPG, PNG, atau WebP yang tidak kosong dan berukuran paling besar 8 MB.');
      return;
    }
    showInspectionError();
    if (camera) fileInput.value = '';
    state.selectedFile = file || null;
    const title = document.getElementById('inspection-file-title');
    if (title) title.textContent = file ? (camera ? 'Foto kamera siap diperiksa' : file.name) : (compact ? 'Pilih foto untuk diperiksa' : 'Pilih atau letakkan foto di sini');
    const name = document.getElementById('inspection-file-name');
    if (name) name.textContent = file ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : '';
    const preview = document.getElementById('inspection-preview');
    const wrap = document.getElementById('inspection-preview-wrap');
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = file ? URL.createObjectURL(file) : null;
    if (preview && wrap) {
      if (state.objectUrl) { preview.src = state.objectUrl; wrap.classList.remove('is-hidden'); }
      else { preview.removeAttribute('src'); wrap.classList.add('is-hidden'); }
    }
  }

  function wireInspectionForm({ compact = false } = {}) {
    const fileInput = document.getElementById('inspection-file');
    if (!fileInput) return;
    fileInput.addEventListener('change', () => {
      selectInspectionFile(fileInput.files?.[0] || null, { compact });
    });
    document.getElementById('inspection-camera')?.addEventListener('click', event => {
      if (!window.InspectionCamera) { showInspectionError('Fitur kamera belum dimuat. Muat ulang halaman lalu coba lagi.'); return; }
      window.InspectionCamera.open({ trigger: event.currentTarget, onPhoto: file => selectInspectionFile(file, { compact, camera: true }) });
    });
    const dropzone = document.getElementById('inspection-dropzone');
    if (dropzone) {
      dropzone.addEventListener('dragover', event => { event.preventDefault(); dropzone.classList.add('is-dragging'); });
      dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragging'));
      dropzone.addEventListener('drop', event => { event.preventDefault(); dropzone.classList.remove('is-dragging'); if (event.dataTransfer?.files?.length) { fileInput.files = event.dataTransfer.files; fileInput.dispatchEvent(new Event('change', { bubbles: true })); } });
    }
    updateInspectionBusy();
  }

  function updateInspectionBusy() {
    const current = inspectionFlight && inspectionFlight.owner === state.user && inspectionFlight.generation === renderGeneration;
    const label = !inspectionFlight ? 'Analisis dengan AI' : current ? inspectionFlight.phase : 'Menunggu analisis sebelumnya…';
    const buttons = [document.getElementById('dashboard-inspect'), document.querySelector('#inspection-form button[type="submit"]')];
    buttons.filter(Boolean).forEach(button => { button.disabled = Boolean(inspectionFlight); button.innerHTML = `<span class="btn-icon" aria-hidden="true">${inspectionFlight ? '◌' : '✦'}</span> ${label}`; });
    ['inspection-area', 'vision-model', 'inspection-profile', 'inspection-file', 'inspection-camera'].forEach(id => { const control = document.getElementById(id); if (control) control.disabled = Boolean(current); });
    const progress = document.getElementById('inspection-progress');
    if (progress) { progress.textContent = !inspectionFlight ? '' : current ? `${inspectionFlight.phase} Anda dapat membuka menu lain; hasil yang sudah dikirim tetap tersimpan di riwayat.` : 'Ada analisis yang masih berjalan. Tunggu hingga prosesnya selesai sebelum memulai pemeriksaan berikutnya.'; progress.classList.toggle('is-hidden', !inspectionFlight); }
    document.getElementById('inspection-dropzone')?.classList.toggle('is-disabled', Boolean(current));
  }

  async function runInspection(form) {
    if (!state.user || !form?.isConnected || !['dashboard', 'inspection'].includes(state.view) || inspectionFlight) return;
    const owner = state.user, generation = renderGeneration, view = state.view;
    const isCurrent = () => state.user === owner && generation === renderGeneration && state.view === view;
    const file = state.selectedFile;
    const areaId = document.getElementById('inspection-area')?.value;
    const modelName = document.getElementById('vision-model')?.value || '';
    const profile = document.getElementById('inspection-profile')?.value === 'detail' ? 'detail' : 'hemat';
    if (!areaId) { showInspectionError('Pilih lokasi kerja terlebih dahulu.'); return; }
    if (!file) { showInspectionError('Pilih berkas foto atau ambil foto melalui kamera terlebih dahulu.'); return; }
    if (!modelName) { showInspectionError('Pilih model visi lokal yang tersedia sebelum menganalisis foto.'); return; }
    window.InspectionCamera?.close({ restoreFocus: false });
    showInspectionError();
    const operation = { owner, generation, phase: 'Memeriksa penyimpanan…' };
    inspectionFlight = operation; updateInspectionBusy();
    try {
      const health = await refreshDatabaseHealth();
      if (!isCurrent()) return;
      if (health.database !== 'ready') throw Object.assign(new Error(health.error || 'SQL Server lokal belum siap menyimpan pemeriksaan. Periksa status penyimpanan, lalu coba lagi.'), { code: health.database === 'schema_pending' ? 'DATABASE_SCHEMA_PENDING' : 'DATABASE_UNAVAILABLE' });
      operation.phase = 'Model sedang menganalisis…'; updateInspectionBusy();
      const body = new FormData(); body.append('work_area_id', areaId); body.append('image', file, file.name); body.append('vision_model', modelName); body.append('performance_profile', profile); body.append('use_examples', document.getElementById('inspection-examples')?.value || 'on');
      const result = await api('/api/analyses', { method: 'POST', body });
      if (!isCurrent()) return;
      if (!result?.analysis_id) throw new Error('Server belum mengonfirmasi hasil pemeriksaan. Periksa riwayat sebelum mencoba kembali.');
      state.selectedFile = null; state.analysisId = result.analysis_id; state.view = 'analysis-detail'; await render();
      if (state.user !== owner || state.view !== 'analysis-detail' || String(state.analysisId) !== String(result.analysis_id)) return;
      showToast(result.result_status === 'HAZARD_FOUND' ? 'AI menemukan indikasi. Silakan koreksi label jika perlu.' : result.result_status === 'NO_VISIBLE_HAZARD' ? 'Analisis selesai. Foto tidak tampak bahaya yang dikenali.' : 'Analisis belum pasti; foto tetap tersimpan untuk koreksi.');
    } catch (error) {
      if (!isCurrent()) return;
      if (error.status === 401) { showLogin('Sesi berakhir. Silakan masuk kembali.'); return; }
      showInspectionError(error.message);
      showToast(error.message, true);
      if (String(error.code || '').startsWith('DATABASE')) await refreshDatabaseHealth();
    } finally { if (inspectionFlight === operation) inspectionFlight = null; updateInspectionBusy(); }
  }

  async function renderAnalysisDetail(context) {
    const { analysis, findings, prediction, feedback } = await api(`/api/analyses/${state.analysisId}`);
    if (!context.isCurrent()) return;
    const image = `<div class="result-image"><img src="/api/media/${analysis.image_id}" alt="Foto pemeriksaan" loading="lazy"></div>`;
    const findingContent = findings.length ? `<div class="finding-list">${findings.map(f => `<article class="finding-item"><div class="finding-item-head"><strong>${escapeHtml(f.hazard_name)}</strong><span class="severity">${escapeHtml(severityLabel(f.severity))}</span></div><p>${escapeHtml(f.description)}<br><b>Saran pemeriksaan:</b> ${escapeHtml(f.recommended_action)}</p></article>`).join('')}</div>` : `<div class="empty-state" style="min-height:105px;padding:15px"><div><strong>${prediction?.predicted_status === 'TIDAK_TAMPAK_BAHAYA' ? 'Tidak ada indikasi yang dikenali model' : 'Belum ada temuan'}</strong><p>Hasil ini hanya menilai hal yang tampak di foto, bukan memastikan lokasi aman.</p></div></div>`;
    const resultClass = analysis.result_status === 'HAZARD_FOUND' ? 'status--found' : analysis.result_status === 'NO_VISIBLE_HAZARD' ? 'status--none' : 'status--unassessed';
    const isArchived = Boolean(analysis.archived || analysis.archived_at);
    const detailActions = `<div class="page-actions"><button class="btn btn-secondary" data-view="history">← Kembali ke riwayat</button>${state.user.role === 'admin' ? `<button type="button" class="btn ${isArchived ? 'btn-primary' : 'btn-secondary'}" data-archive-analysis="${analysis.analysis_id}" data-archive-value="${isArchived ? 'false' : 'true'}" data-photo-name="${escapeHtml(analysis.original_name)}">${isArchived ? '↶ Pulihkan pemeriksaan' : 'Hapus pemeriksaan'}</button>${isArchived ? permanentDeleteButton(analysis.analysis_id, analysis.original_name) : ''}` : ''}</div>`;
    const archiveNotice = isArchived ? `<div class="archive-notice"><span aria-hidden="true">▣</span><span><strong>Pemeriksaan berada di Arsip dihapus.</strong><br>Dihapus ${escapeHtml(formatDate(analysis.archived_at))} oleh ${escapeHtml(analysis.archived_by_name || 'admin')}. Pulihkan untuk menampilkan kembali pemeriksaan dan menambah koreksi.</span></div>` : '';
    const archivedFeedback = `<article class="feedback-panel"><p class="section-kicker">KOREKSI TERSIMPAN</p><h3 class="card-title">${escapeHtml(feedbackLabel(feedback?.corrected_label))}</h3>${feedback ? `<p class="review-note">${escapeHtml(feedback.user_name)} · ${escapeHtml(formatDate(feedback.created_at))}${feedback.notes ? `<br>${escapeHtml(feedback.notes)}` : ''}</p>` : '<p class="review-note">Pemeriksaan ini belum memiliki koreksi pengguna.</p>'}<p class="hint-text">Koreksi tetap tersimpan selama pemeriksaan diarsipkan.</p></article>`;
    const modelDetails = prediction ? `<div class="ai-summary"><strong>Ringkasan model</strong>${(() => {try{const context=prediction.learning_context;return context?.examples?.length?`<p class="hint-text">Memakai ${context.examples.length} contoh visual terverifikasi · ${context.examples.map(e=>'#'+e.dataset_item_id).join(', ')} · bobot model tetap</p>`:'<p class="hint-text">Model dasar · belum ada contoh terverifikasi yang sesuai untuk foto ini</p>';}catch{return '';}})()}<p>${escapeHtml(prediction.summary)}</p></div>` : `<div class="ai-summary is-warning"><strong>Model belum dapat menganalisis foto</strong><p>${escapeHtml(analysis.error_message || 'Pastikan Ollama berjalan dan pilih model yang mendukung gambar.')}</p></div>`;
    const feedbackForm = `<article class="feedback-panel"><div class="card-title-row"><div><p class="section-kicker">KOREKSI PENGGUNA</p><h3 class="card-title">Apakah prediksi AI sesuai?</h3></div></div><p class="review-note">Contoh: AI tidak melihat bahaya, tetapi kamu melihat kabel menghalangi jalan. Tandai <strong>Tidak aman</strong> agar koreksi ini tersimpan.</p>${feedback ? `<div class="feedback-current"><strong>Label terakhir: ${escapeHtml(feedbackLabel(feedback.corrected_label))}</strong><small>${escapeHtml(feedback.user_name)} · ${escapeHtml(formatDate(feedback.created_at))}${feedback.notes ? ` · ${escapeHtml(feedback.notes)}` : ''}</small></div>` : ''}<form id="feedback-form"><label class="inline-label" for="feedback-label">Penilaian gambar</label><select class="select-field" id="feedback-label" name="corrected_label" required><option value="" disabled ${feedback ? '' : 'selected'}>Pilih label…</option><option value="TIDAK_AMAN" ${feedback?.corrected_label === 'TIDAK_AMAN' ? 'selected' : ''}>Tidak aman / ada indikasi bahaya</option><option value="TIDAK_TAMPAK_BAHAYA" ${feedback?.corrected_label === 'TIDAK_TAMPAK_BAHAYA' ? 'selected' : ''}>Tidak tampak bahaya pada foto</option><option value="RAGU" ${feedback?.corrected_label === 'RAGU' ? 'selected' : ''}>Belum yakin</option></select><label class="inline-label" for="feedback-notes">Catatan koreksi (opsional)</label><textarea class="textarea-field" id="feedback-notes" name="notes" maxlength="1200" placeholder="Apa yang terlihat atau bagian mana yang luput?">${escapeHtml(feedback?.notes || '')}</textarea><button class="btn btn-primary" type="submit">${feedback ? 'Simpan koreksi terbaru' : 'Simpan koreksi'}</button></form><p class="hint-text">Koreksi tersimpan sebagai data evaluasi. Model tidak belajar ulang otomatis dari satu label.</p></article>`;
    root.innerHTML = `${pageHead(isArchived ? 'ARSIP DIHAPUS' : 'HASIL VLM LOKAL', 'Analisis foto', `${escapeHtml(analysis.area_name)} · ${escapeHtml(formatDate(analysis.analyzed_at))}`, detailActions)}${archiveNotice}
      <div class="section-grid"><div class="card card-pad"><div class="card-title-row"><div><p class="section-kicker">FOTO PEMERIKSAAN</p><h2 class="card-title">${escapeHtml(analysis.original_name)}</h2><p class="card-caption">${escapeHtml(analysis.area_name)} · ${areaLabel(analysis.area_type)}</p></div><span class="role-tag">#${analysis.analysis_id}</span></div>${image}<div style="display:flex;gap:8px;align-items:center;margin-top:12px;color:#596b83;font-size:9px"><span>▣</span> Foto privat · disimpan lokal · metadata kamera dihapus</div></div>
      <div class="card result-card"><div class="card-title-row"><div><p class="section-kicker">STATUS VLM</p><h2 class="card-title">Indikasi awal</h2></div></div><div class="result-status ${resultClass}"><span class="result-icon">${analysis.result_status === 'HAZARD_FOUND' ? '⚑' : 'ⓘ'}</span><span><strong>${escapeHtml(statusLabel(analysis.result_status))}</strong><small>${analysis.result_status === 'UNABLE_TO_ASSESS' ? 'Cek Ollama dan model visi lokal.' : 'Gunakan koreksi pengguna bila hasil model keliru.'}</small></span></div>${modelDetails}${findingContent}<div style="margin-top:15px"><div class="meta-row"><span>Model</span><strong>${escapeHtml(analysis.model_name)} ${escapeHtml(analysis.model_version)}</strong></div><div class="meta-row"><span>Waktu analisis</span><strong>${escapeHtml(formatDate(analysis.analyzed_at))}</strong></div><div class="meta-row"><span>Lama inferensi</span><strong>${prediction ? `${(prediction.latency_ms / 1000).toFixed(1)} detik` : '—'}</strong></div></div></div></div>
      ${isArchived ? archivedFeedback : feedbackForm}${!isArchived ? '<div class="dt-notice">Prediksi kurang tepat atau peralatan belum dikenali? Tekan Ajarkan foto ini, periksa label, lalu verifikasi pada Belajar dari foto.</div>' : ''}${!isArchived ? `<div class="dt-export" style="margin-top:18px"><button type="button" class="btn btn-primary" data-training-candidate="${analysis.analysis_id}">Ajarkan foto ini</button><button type="button" class="btn btn-secondary" data-curate-analysis="${analysis.analysis_id}">Masukkan ke dataset</button><p>Periksa label dan tandai bagian berbahaya untuk menjadi contoh.</p></div>` : ''}<div class="warning-banner" style="margin-top:13px"><span>ⓘ</span><span>“Tidak tampak bahaya” bukan pernyataan aman. Foto tunggal tidak selalu memperlihatkan konteks risiko di lokasi.</span></div>`;
  }

  async function renderHistory(context) {
    const areaData = await api('/api/areas');
    if (!context.isCurrent()) return;
    state.areas = areaData.areas;
    const admin = state.user.role === 'admin';
    if (!admin) state.historyArchived = false;
    const params = new URLSearchParams(); if (state.filter.q) params.set('q', state.filter.q); if (state.filter.area) params.set('area', state.filter.area); if (state.filter.status) params.set('status', state.filter.status);
    if (admin && state.historyArchived) params.set('archived', '1');
    const result = await api(`/api/analyses?${params.toString()}`);
    if (!context.isCurrent()) return;
    if (state.historyArchived && result.archived !== true) throw Object.assign(new Error('Server lokal perlu dimulai ulang untuk mengaktifkan arsip pemeriksaan.'), { code: 'API_RESTART_REQUIRED' });
    root.innerHTML = `${pageHead('ARSIP LOKAL', 'Riwayat pemeriksaan', 'Cari foto, buka hasil model, dan lihat koreksi label yang sudah disimpan.', '<button class="btn btn-primary" data-view="inspection"><span class="btn-icon">+</span> Pemeriksaan baru</button>')}
      ${admin ? `<div class="history-tabs" aria-label="Jenis riwayat"><button type="button" data-history-scope="active" aria-pressed="${!state.historyArchived}" class="${!state.historyArchived ? 'is-active' : ''}">Pemeriksaan aktif</button><button type="button" data-history-scope="archived" aria-pressed="${Boolean(state.historyArchived)}" class="${state.historyArchived ? 'is-active' : ''}">Arsip dihapus</button></div>` : ''}
      <div class="card filter-bar"><div class="filter-search"><label class="sr-only" for="history-search">Cari pemeriksaan berdasarkan nama foto atau lokasi</label><input class="field" id="history-search" type="search" placeholder="Cari nama foto atau lokasi…" value="${escapeHtml(state.filter.q)}"></div><label class="sr-only" for="history-area">Filter area kerja</label><select class="select-field" id="history-area" aria-label="Filter area kerja"><option value="">Semua area</option>${state.areas.map(area => `<option value="${area.work_area_id}" ${String(state.filter.area) === String(area.work_area_id) ? 'selected' : ''}>${escapeHtml(area.name)}</option>`).join('')}</select><label class="sr-only" for="history-status">Filter status AI</label><select class="select-field" id="history-status" aria-label="Filter status AI"><option value="">Semua status</option>${[['UNABLE_TO_ASSESS','Belum dapat dinilai'],['REVIEW_REQUIRED','Perlu ditinjau'],['HAZARD_FOUND','Bahaya terdeteksi'],['NO_VISIBLE_HAZARD','Tanpa indikasi yang dikenali'],['FAILED','Gagal']].map(([key,label]) => `<option value="${key}" ${state.filter.status === key ? 'selected' : ''}>${label}</option>`).join('')}</select><button class="btn btn-secondary btn-small" id="history-clear">Atur ulang</button></div>
      ${state.historyArchived ? '<div class="archive-notice"><span aria-hidden="true">▣</span><span>Arsip ini hanya terlihat oleh admin. Gunakan Pulihkan untuk mengembalikan pemeriksaan, atau Delete untuk menghapusnya permanen setelah konfirmasi.</span></div>' : ''}
      ${admin && state.deleteNotice ? `<div class="warning-banner delete-cleanup-notice" role="alert"><span aria-hidden="true">ⓘ</span><span><strong>Data pemeriksaan sudah dihapus.</strong><br>${escapeHtml(state.deleteNotice)}</span><button type="button" class="btn btn-secondary btn-small" data-dismiss-delete-notice>Tutup</button></div>` : ''}
      <div class="card table-card"><div class="card-pad" style="padding-bottom:8px"><div class="card-title-row"><div><h2 class="card-title">${result.total} pemeriksaan ${state.historyArchived ? 'diarsipkan' : 'aktif'}</h2><p class="card-caption">Terbaru tampil lebih dahulu</p></div></div></div>${renderAnalysisRows(result.analyses, { archived: Boolean(state.historyArchived) })}<div class="pager"><span>${result.total ? `Menampilkan ${result.analyses.length} dari ${result.total}` : 'Tidak ada hasil untuk filter ini'}</span><span>▣ Data lokal</span></div></div>`;
  }

  async function renderDatasets(context) {
    const [data, hazards] = await Promise.all([api('/api/datasets'), api('/api/hazard-types')]);
    if (!context.isCurrent()) return;
    state.datasets = data.datasets; state.hazards = hazards.hazards;
    data.datasets=data.datasets.filter(d=>d.dataset_kind!=='PPE_OBJECT');
    const editable = ['operator', 'admin'].includes(state.user.role);
    const hazardDrafts = data.datasets.filter(ds => ds.status === 'DRAFT' && ds.dataset_kind !== 'PPE_OBJECT');
    const cards = data.datasets.length ? `<div class="dataset-list">${data.datasets.map(datasetCard).join('')}</div>` : emptyState('Belum ada dataset foto', 'Buat dataset terpisah untuk foto yang memang telah disetujui untuk pelabelan. Foto unggahan pemeriksaan tidak ditambahkan otomatis.', '+');
    root.innerHTML = `${pageHead('DATA BERLABEL', 'Dataset foto', 'Catat sumber, lisensi, label acuan, dan anotasi secara terpisah dari hasil prediksi.', editable ? '<button class="btn btn-primary" data-action="create-dataset"><span class="btn-icon">+</span> Buat dataset</button>' : '')}
      <div class="dataset-intro"><div><strong>Label untuk evaluasi model</strong><p>Gunakan Belajar dari foto untuk menambah, memberi label, dan memverifikasi contoh. Halaman ini menyediakan pengelolaan dataset dan ekspor.</p></div><span class="role-tag">${editable ? 'Pengguna / Admin' : 'Akses baca'}</span></div>
      ${state.user.role === 'admin' && state.datasetDeleteNotice ? `<div class="warning-banner dataset-delete-cleanup-notice" role="alert"><span><strong>Dataset sudah dihapus.</strong><br>${escapeHtml(state.datasetDeleteNotice)}</span><button type="button" class="btn btn-secondary btn-small" data-dismiss-dataset-delete-notice>Tutup</button></div>` : ''}
      <article class="card card-pad" style="margin:14px 0"><div class="card-title-row"><div><h2 class="card-title">PDF rig dan calon pelatihan</h2><p class="card-caption">Foto Protect, asal dokumen, antrean label, dan pembagian kelompok rig.</p></div><button class="btn btn-primary" data-view="rig-dataset">Buka calon pelatihan</button></div></article>
      ${cards}
      ${editable ? `<article class="card card-pad" style="margin-top:14px"><div class="card-title-row"><div><h2 class="card-title">Tambah foto berlabel bahaya</h2><p class="card-caption">Pilih dataset inspeksi, catat lisensi, lalu gambar kotak pada bagian yang berbahaya.</p></div></div>${hazardDrafts.length ? renderDatasetItemForm(hazardDrafts) : emptyState('Tidak ada dataset inspeksi draft', 'Buat dataset baru untuk menambahkan foto dan anotasi bahaya.', '+')}</article>` : ''}
      <div id="dataset-modal-root"></div>`;
    if (editable && hazardDrafts.length) wireDatasetItemForm();
  }

  async function renderDatasetItems(context) {
    const requestedOffset = Math.max(0, Number(state.datasetOffset) || 0);
    const result = await api(`/api/datasets/${state.datasetId}/items?offset=${requestedOffset}&limit=24`);
    if (!context.isCurrent()) return;
    const { dataset } = result;
    const paginated = Number.isSafeInteger(result.total) && Number.isSafeInteger(result.offset);
    const total = paginated ? result.total : (result.items?.length || 0);
    const offset = paginated ? result.offset : requestedOffset;
    const items = paginated ? result.items : (result.items || []).slice(offset, offset + 24);
    state.datasetOffset = offset;
    const status = { DRAFT: 'Draft', REVIEW: 'Dalam tinjauan', APPROVED: 'Disetujui', ARCHIVED: 'Diarsipkan' }[dataset.status] || dataset.status;
    const label = value => ({ RISK: 'Ada indikasi bahaya', NO_LISTED_HAZARD_VISIBLE: 'Tidak tampak bahaya', UNCERTAIN: 'Belum pasti' }[value] || value || 'Belum berlabel');
    const splitLabel = value => ({ TRAIN: 'Latih', VALIDATION: 'Validasi', TEST: 'Uji' }[value] || value || '—');
    const reviewLabel = value => ({ DRAFT: 'Belum ditinjau', REVIEWED: 'Telah ditinjau', VERIFIED: 'Terverifikasi' }[value] || value || '—');
    const pager = `<div class="dataset-pagination"><p role="status" aria-live="polite">${items.length ? `Menampilkan ${(offset + 1).toLocaleString('id-ID')}–${Math.min(offset + items.length, total).toLocaleString('id-ID')} dari ${total.toLocaleString('id-ID')} foto` : 'Belum ada foto'}<small>24 foto per halaman · foto asli tetap tersimpan</small></p><div><button class="btn btn-secondary" type="button" data-dataset-page="${Math.max(0, offset - 24)}" ${offset === 0 ? 'disabled' : ''}>← Sebelumnya</button><button class="btn btn-secondary" type="button" data-dataset-page="${offset + 24}" ${offset + 24 >= total ? 'disabled' : ''}>Berikutnya →</button></div></div>`;
    const canVerify = ['operator','admin'].includes(state.user.role);
    const statusAction = canVerify && dataset.status === 'DRAFT' ? '<button class="btn btn-secondary" data-dataset-status="REVIEW">Ajukan tinjauan</button>' : canVerify && dataset.status === 'REVIEW' ? '<button class="btn btn-primary" data-dataset-status="APPROVED">Setujui dataset</button>' : '';
    const backToDraft = state.user.role === 'admin' && dataset.status === 'REVIEW' ? '<button class="btn btn-secondary" data-dataset-status="DRAFT">Kembali ke Draft</button>' : '';
    root.innerHTML = `${pageHead('FOTO DAN ANOTASI', dataset.name, `Versi ${dataset.version} · ${status} · ${total.toLocaleString('id-ID')} foto berlabel`, `<div class="page-actions">${backToDraft}${statusAction}${datasetDeleteButton({ ...dataset, item_count: total })}<button class="btn btn-secondary" data-view="datasets">← Kembali ke dataset</button></div>`)}
      ${dataset.status === 'APPROVED' ? `<div class="dt-export"><button class="btn btn-secondary" data-export-dataset="${dataset.dataset_id}" data-format="jsonl">Ekspor JSONL</button><button class="btn btn-secondary" data-export-dataset="${dataset.dataset_id}" data-format="yolo">Ekspor YOLO</button><button class="btn btn-primary" data-view="evaluation">Evaluasi model</button><p>ZIP berisi foto, label, dan manifest versi.</p></div>` : `<div class="dt-notice">Verifikasi label, ajukan tinjauan, lalu setujui dataset untuk mengaktifkan ekspor dan evaluasi.</div>`}
      ${items.length ? `<div class="dataset-list dataset-item-grid">${items.map(item => { const annotations = Array.isArray(item.annotations) ? item.annotations : []; return `<article class="card dataset-item-card"><a href="/api/media/${Number(item.image_id)}" target="_blank" rel="noopener" class="dataset-item-photo" aria-label="Buka foto asli ${escapeHtml(item.original_name)}"><img src="/api/media/${Number(item.image_id)}/thumbnail" data-dataset-thumbnail="${Number(item.image_id)}" alt="Foto dataset ${escapeHtml(item.original_name)}" loading="lazy" decoding="async" width="320" height="170"><span>Buka foto asli ↗</span></a><div class="card-pad"><h2 class="card-title">${escapeHtml(item.original_name)}</h2>${canVerify && dataset.status === 'DRAFT' ? `<button class="btn btn-secondary btn-small" type="button" data-training-review="${item.dataset_item_id}">${item.needs_review ? 'Tinjau calon pelatihan' : 'Ubah label / anotasi'}</button>` : ''}<p class="card-caption">${escapeHtml(label(item.overall_label))} · ${escapeHtml(splitLabel(item.split))} · ${annotations.length} kotak</p><div class="meta-row"><span>Lisensi</span><strong>${escapeHtml(item.license_name || '—')}${item.license_verified ? ' ✓' : ''}</strong></div><div class="meta-row"><span>Label oleh</span><strong>${escapeHtml(item.labeled_by || '—')}</strong></div><div class="meta-row"><span>Status label</span><strong>${escapeHtml(reviewLabel(item.label_status))}${item.verified_by ? ` · ${escapeHtml(item.verified_by)}` : ''}</strong></div><div class="box-list">${annotations.map(annotation => `<span class="box-tag">${escapeHtml(annotation.hazard_name)}</span>`).join('') || '<span class="hint-text">Tanpa kotak bahaya</span>'}</div>${canVerify && !item.needs_review && item.label_status !== 'VERIFIED' ? `<button class="btn btn-secondary btn-small" data-verify-item="${item.dataset_item_id}">Verifikasi label</button>` : ''}</div></article>`; }).join('')}</div>${pager}` : emptyState('Dataset ini belum berisi foto', 'Tambahkan foto sumber yang sudah diperiksa izinnya dari halaman dataset.', '▤')}`;
    root.querySelectorAll('[data-dataset-thumbnail]').forEach(image => { image.addEventListener('error', () => { if (!image.dataset.fallback) { image.dataset.fallback = '1'; image.src = `/api/media/${image.dataset.datasetThumbnail}`; } else { image.alt = 'Foto belum tersedia'; image.classList.add('dataset-photo-unavailable'); } }); });
  }

  function renderDatasetItemForm(datasets) {
    return `<form id="dataset-item-form"><div class="section-grid"><div>
      <div class="form-row"><div class="field-wrap"><label class="inline-label" for="dataset-id">Dataset</label><select class="select-field" id="dataset-id" name="dataset_id" required>${datasets.map(ds => `<option value="${ds.dataset_id}" ${ds.status !== 'DRAFT' ? 'disabled' : ''}>${escapeHtml(ds.name)} · ${escapeHtml(ds.version)}${ds.status !== 'DRAFT' ? ` (${escapeHtml(ds.status)})` : ''}</option>`).join('')}</select></div><div class="field-wrap"><label class="inline-label" for="dataset-split">Pembagian data</label><select class="select-field" id="dataset-split" name="split"><option value="TRAIN">Latih</option><option value="VALIDATION">Validasi</option><option value="TEST">Uji</option></select></div></div>
      <label class="inline-label" for="dataset-photo">Foto berizin</label><label class="dropzone"><span class="drop-icon">↥</span><span class="drop-copy"><strong id="dataset-file-name">Pilih foto sumber</strong><small>JPG, PNG, WebP · maks. 8 MB</small></span><input id="dataset-photo" type="file" accept="image/jpeg,image/png,image/webp" required aria-label="Pilih foto dataset"></label>
      <div class="photo-preview" id="dataset-preview-wrap"><div class="photo-placeholder"><span class="empty-icon">▧</span><br>Pratinjau foto dan penanda kotak akan muncul di sini.</div></div>
      <div class="draw-help">⌖ Seret pada foto untuk menandai satu bahaya. Kotak memakai koordinat relatif 0–1.</div><div id="box-list" class="box-list"></div>
      <div class="form-row"><div><label class="inline-label" for="annotation-hazard">Kategori kotak berikutnya</label><select class="select-field" id="annotation-hazard"><option value="">Pilih kategori…</option>${state.hazards.filter(h => h.is_active).map(h => `<option value="${h.hazard_type_id}">${escapeHtml(h.name)}</option>`).join('')}</select></div><div><label class="inline-label" for="dataset-label">Label keseluruhan</label><select class="select-field" id="dataset-label" name="overall_label"><option value="RISK">RISK · indikasi bahaya terlihat</option><option value="NO_LISTED_HAZARD_VISIBLE">NO_LISTED_HAZARD_VISIBLE</option><option value="UNCERTAIN">UNCERTAIN · belum pasti</option></select></div></div>
      </div><div>
      <div class="warning-banner"><span>ⓘ</span><span>Pastikan Anda memiliki izin penggunaan foto. Lisensi nonkomersial dapat membatasi pemakaian selanjutnya.</span></div>
      <label class="inline-label" for="source-url">URL sumber (jika ada)</label><input class="field" id="source-url" name="source_url" type="url" maxlength="1200" placeholder="https://…">
      <label class="inline-label" for="author-name">Pembuat foto</label><input class="field" id="author-name" name="author_name" maxlength="200" placeholder="Nama pembuat, jika tersedia">
      <label class="inline-label" for="license-name">Lisensi</label><input class="field" id="license-name" name="license_name" maxlength="200" placeholder="Mis. izin organisasi / CC BY 4.0" required>
      <label class="inline-label" for="license-url">URL lisensi</label><input class="field" id="license-url" name="license_url" maxlength="1200" type="url" placeholder="https://…">
      <label class="inline-label" for="attribution">Atribusi</label><textarea class="textarea-field" id="attribution" name="attribution_text" maxlength="1000" placeholder="Teks atribusi yang diminta lisensi"></textarea>
      <label class="check-row" style="margin-top:12px"><input type="checkbox" id="license-verified" name="license_verified"><span>Saya telah memeriksa sumber dan syarat lisensi foto ini.</span></label>
      <div style="display:flex;justify-content:flex-end;margin-top:15px"><button class="btn btn-primary" type="submit">Simpan foto & label</button></div>
      </div></div></form>`;
  }

  function wireDatasetItemForm() {
    const input = document.getElementById('dataset-photo'), wrap = document.getElementById('dataset-preview-wrap');
    const owner = state.user, generation = renderGeneration;
    let imageGeneration = 0;
    const submit = document.querySelector('#dataset-item-form button[type="submit"]');
    if (submit) submit.disabled = true;
    input?.addEventListener('change', () => {
      if (state.user !== owner || generation !== renderGeneration || !input.isConnected || !wrap.isConnected) return;
      const selection = ++imageGeneration, file = input.files?.[0];
      resetDatasetPhoto(); renderBoxTags();
      if (submit) submit.disabled = true;
      document.getElementById('dataset-file-name').textContent = file?.name || 'Pilih foto sumber';
      wrap.innerHTML = '<div class="photo-placeholder">Pratinjau foto dan penanda kotak akan muncul di sini.</div>';
      if (!file) return;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size <= 0 || file.size > 8 * 1024 * 1024) {
        input.value = ''; document.getElementById('dataset-file-name').textContent = 'Pilih foto sumber';
        showToast('Gunakan foto JPG, PNG, atau WebP yang tidak kosong dan berukuran paling besar 8 MB.', true); return;
      }
      state.datasetFile = file; state.datasetUrl = URL.createObjectURL(file);
      const url = state.datasetUrl, image = new Image(); image.alt = 'Foto untuk anotasi';
      const isCurrent = () => selection === imageGeneration && state.user === owner && generation === renderGeneration && input.isConnected && wrap.isConnected && state.datasetFile === file;
      const holder = document.createElement('div'); holder.className = 'draw-canvas-wrap'; holder.id = 'draw-canvas-wrap';
      const canvas = document.createElement('canvas'); canvas.id = 'annotation-canvas';
      wrap.innerHTML = '<div class="photo-placeholder" role="status">Memuat foto untuk anotasi.</div>';
      image.onload = () => {
        if (!isCurrent()) return;
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        holder.append(image, canvas); wrap.replaceChildren(holder); bindCanvas(canvas, image); renderBoxTags();
        state.datasetReadyFile = file; if (submit) submit.disabled = pendingForms.has(document.getElementById('dataset-item-form'));
      };
      image.onerror = () => {
        if (!isCurrent()) return;
        input.value = ''; resetDatasetPhoto(); renderBoxTags();
        document.getElementById('dataset-file-name').textContent = 'Pilih foto sumber';
        wrap.innerHTML = '<div class="photo-placeholder" role="alert">Foto tidak dapat dibaca. Pilih foto lain.</div>';
        showToast('Foto tidak dapat dibaca. Pilih foto JPG, PNG, atau WebP lain.', true);
      };
      image.src = url;
    });
  }
  function bindCanvas(canvas, image) {
    const ctx = canvas.getContext('2d');
    const owner = state.user, generation = renderGeneration, file = state.datasetFile;
    const isCurrent = () => canvas.isConnected && state.user === owner && renderGeneration === generation && state.datasetFile === file;
    const point = event => { const rect = canvas.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }; };
    canvas.addEventListener('pointerdown', event => { if (!isCurrent()) return; if (!document.getElementById('annotation-hazard').value) return showToast('Pilih kategori bahaya untuk kotak ini.', true); canvas.setPointerCapture(event.pointerId); state.dragStart = point(event); });
    canvas.addEventListener('pointerup', event => { if (!isCurrent() || !state.dragStart) return; const end = point(event); const x = Math.min(state.dragStart.x, end.x), y = Math.min(state.dragStart.y, end.y), width = Math.abs(end.x - state.dragStart.x), height = Math.abs(end.y - state.dragStart.y); if (width > .008 && height > .008) state.boxes.push({ hazard_type_id: Number(document.getElementById('annotation-hazard').value), x, y, width, height }); state.dragStart = null; drawBoxes(); renderBoxTags(); });
    canvas.addEventListener('pointercancel', () => { if (isCurrent()) { state.dragStart = null; drawBoxes(); } });
    function drawBoxes() { ctx.clearRect(0, 0, canvas.width, canvas.height); state.boxes.forEach(box => { ctx.strokeStyle = '#3157d5'; ctx.lineWidth = Math.max(3, canvas.width / 280); ctx.strokeRect(box.x * canvas.width, box.y * canvas.height, box.width * canvas.width, box.height * canvas.height); ctx.fillStyle = 'rgba(49,87,213,.12)'; ctx.fillRect(box.x * canvas.width, box.y * canvas.height, box.width * canvas.width, box.height * canvas.height); }); }
    state.drawBoxes = drawBoxes;
  }
  function renderBoxTags() {
    const holder = document.getElementById('box-list'); if (!holder) return;
    holder.innerHTML = state.boxes.map((box, index) => { const hazard = state.hazards.find(item => item.hazard_type_id === box.hazard_type_id); return `<span class="box-tag">${escapeHtml(hazard?.name || 'Kategori')} · kotak ${index + 1}<button type="button" data-remove-box="${index}" aria-label="Hapus anotasi ${index + 1}">×</button></span>`; }).join('') || '<span class="hint-text">Belum ada kotak anotasi.</span>';
  }

  async function renderSettings(context) {
    const isAdmin = state.user.role === 'admin';
    const [areas, hazards, ai, datasets] = await Promise.all([api(`/api/areas${isAdmin ? '?include_inactive=1' : ''}`), api(`/api/hazard-types${isAdmin ? '?include_inactive=1' : ''}`), api('/api/ai/status'), api('/api/datasets')]);
    if (!context.isCurrent()) return;
    let users = [];
    if (isAdmin) users = (await api('/api/users')).users;
    if (!context.isCurrent()) return;
    state.areas = areas.areas; state.hazards = hazards.hazards; state.datasets = datasets.datasets; state.ai = ai;
    root.innerHTML = `${pageHead('ATURAN DAN MODEL', 'Konfigurasi sistem', 'Atur katalog area dan kategori; setiap foto dapat memakai model visi lokal yang berbeda.', '')}
      <div class="section-grid"><div class="card card-pad"><div class="card-title-row"><div><h2 class="card-title">Model visi yang terpasang</h2><p class="card-caption">Ollama lokal · dipilih saat setiap analisis</p></div></div>${ai.available && ai.vision_models.length ? `<div class="catalog-list">${ai.vision_models.map(model => `<article class="catalog-item"><div><strong>${escapeHtml(model.name)}</strong><p>${escapeHtml(model.family || 'Vision')} ${escapeHtml(model.parameter_size || '')}</p><small>Ukuran lokal ${model.size ? `${(model.size / 1e9).toFixed(1)} GB` : 'tidak diketahui'}</small></div><span class="status-pill status--none">Tersedia</span></article>`).join('')}</div>` : `<div class="warning-banner"><span>ⓘ</span><span>${escapeHtml(ai.error || 'Tidak ada model vision yang terpasang pada Ollama.')}</span></div>`}<div class="warning-banner" style="margin-top:13px"><span>ⓘ</span><span>Model teks saja tidak dapat membaca foto. Koreksi pengguna disimpan untuk evaluasi, bukan fine-tuning otomatis.</span></div></div>
      <div class="card card-pad"><div class="card-title-row"><div><h2 class="card-title">Area kerja</h2><p class="card-caption">Lokasi yang bisa dipilih operator</p></div><span class="role-tag">Lingkup PDF CRSSC + kantor</span></div><div class="area-list">${state.areas.filter(area=>area.scope_key==='CRSSC-20261005').map(area => `<div class="area-item"><span><strong>${escapeHtml(area.name)}${area.is_active ? '' : ' · nonaktif'}</strong><small>${escapeHtml(area.description || '')}</small></span><span style="display:flex;align-items:center;gap:7px"><span class="area-type">${areaLabel(area.area_type)}</span>${isAdmin ? `<button class="btn btn-secondary btn-small" data-edit-area="${area.work_area_id}">Ubah</button>` : ''}</span></div>`).join('')}</div></div></div>
      <article class="card card-pad" style="margin-top:15px"><div class="card-title-row"><div><h2 class="card-title">Katalog indikasi visual</h2><p class="card-caption">Kategori membantu model membandingkan tanda yang terlihat.</p></div><span style="display:flex;align-items:center;gap:9px"><span class="role-tag">${state.hazards.length} kategori</span>${isAdmin ? '<button class="btn btn-secondary btn-small" data-config="hazard">+ Kategori</button>' : ''}</span></div><div class="warning-banner" style="margin-bottom:13px"><span>ⓘ</span><span>Lingkup pemeriksaan mengikuti PDF CRSSC dan Ruangan Kantor. Definisi bahaya tetap perlu diperiksa oleh penanggung jawab area.</span></div><div class="catalog-list">${state.hazards.map(h => `<article class="catalog-item"><div><strong>${escapeHtml(h.name)}${h.is_active ? '' : ' · nonaktif'}</strong><p>${escapeHtml(h.description)}</p><small>${areaLabel(h.area_type)} · ${escapeHtml(h.recommended_action)}</small></div><span style="display:flex;align-items:center;gap:7px"><span class="severity-chip ${h.default_severity === 'SEDANG' ? 'medium' : ''}">${severityLabel(h.default_severity)}</span>${isAdmin ? `<button class="btn btn-secondary btn-small" data-edit-hazard="${h.hazard_type_id}">Ubah</button>` : ''}</span></article>`).join('')}</div></article>
      ${isAdmin ? `<article class="card card-pad" style="margin-top:15px"><div class="card-title-row"><div><h2 class="card-title">Pengguna</h2><p class="card-caption">Hak akses: pengguna dan admin.</p></div><button class="btn btn-secondary btn-small" data-config="user">+ Pengguna</button></div><div class="table-scroll"><table><thead><tr><th>Nama</th><th>Email</th><th>Peran</th><th>Akses</th></tr></thead><tbody>${users.map(account => `<tr><td>${escapeHtml(account.full_name)}</td><td>${escapeHtml(account.email)}</td><td><span class="role-tag">${escapeHtml(roleText[account.role] || account.role)}</span></td><td>${account.user_id === state.user.user_id ? '<span class="table-subtitle">Akun Anda</span>' : `<button class="btn ${account.is_active ? 'btn-danger' : 'btn-secondary'} btn-small" data-toggle-user="${account.user_id}" data-active="${account.is_active ? '1' : '0'}">${account.is_active ? 'Nonaktifkan' : 'Aktifkan'}</button>`}</td></tr>`).join('')}</tbody></table></div></article>` : ''}
      <div id="settings-modal-root"></div>`;
  }

  function showFormDialog(host) {
    const dialog = host?.querySelector('dialog'); if (!dialog) return;
    const trigger = document.activeElement;
    dialog.querySelectorAll('.inline-label').forEach((label, index) => {
      const control = label.nextElementSibling;
      if (!control?.matches('input,select,textarea')) return;
      if (!control.id) control.id = `${host.id}-field-${index}`;
      label.htmlFor = control.id;
    });
    dialog.addEventListener('close', () => { dialog.remove(); if (trigger?.isConnected) trigger.focus(); }, { once: true });
    dialog.showModal();
    dialog.querySelector('input:not([type="hidden"]),textarea,select')?.focus();
  }
  function openConfigModal(kind, item = null) {
    const edit = Boolean(item), title = { area: edit ? 'Ubah area kerja' : 'Tambah area kerja', hazard: edit ? 'Ubah kategori bahaya' : 'Tambah kategori bahaya', user: 'Tambah pengguna', model: 'Daftarkan versi model' }[kind];
    let fields = '';
    if (kind === 'area') fields = `<label class="inline-label">Nama area dari katalog PDF</label><input class="field" name="name" maxlength="120" value="${escapeHtml(item?.name || '')}" readonly required><label class="inline-label">Jenis area</label><input type="hidden" name="area_type" value="${escapeHtml(item?.area_type||'RIG')}"><select class="select-field" disabled><option value="GUDANG" ${item?.area_type === 'GUDANG' ? 'selected' : ''}>Gudang</option><option value="KANTOR" ${item?.area_type === 'KANTOR' ? 'selected' : ''}>Kantor</option><option value="RIG" ${item?.area_type === 'RIG' ? 'selected' : ''}>Rig</option></select><label class="inline-label">Deskripsi</label><textarea class="textarea-field" name="description" maxlength="500">${escapeHtml(item?.description || '')}</textarea>${edit ? `<label class="check-row" style="margin-top:12px"><input type="checkbox" name="is_active" ${item.is_active ? 'checked' : ''}><span>Area aktif dan tersedia untuk pemeriksaan.</span></label>` : ''}`;
    if (kind === 'hazard') fields = `${edit ? '' : '<label class="inline-label">Kode unik</label><input class="field" name="code" pattern="[A-Za-z0-9_]{2,48}" maxlength="48" placeholder="MISALNYA_KABEL" required>'}<label class="inline-label">Nama kategori</label><input class="field" name="name" maxlength="140" value="${escapeHtml(item?.name || '')}" required><label class="inline-label">Area</label><select class="select-field" name="area_type"><option value="GUDANG" ${item?.area_type === 'GUDANG' ? 'selected' : ''}>Gudang</option><option value="KANTOR" ${item?.area_type === 'KANTOR' ? 'selected' : ''}>Kantor</option><option value="RIG" ${item?.area_type === 'RIG' ? 'selected' : ''}>Rig</option><option value="KEDUANYA" ${item?.area_type === 'KEDUANYA' ? 'selected' : ''}>Keduanya</option></select><label class="inline-label">Tingkat risiko awal</label><select class="select-field" name="default_severity"><option value="RENDAH" ${item?.default_severity === 'RENDAH' ? 'selected' : ''}>Rendah</option><option value="SEDANG" ${!item || item?.default_severity === 'SEDANG' ? 'selected' : ''}>Sedang</option><option value="TINGGI" ${item?.default_severity === 'TINGGI' ? 'selected' : ''}>Tinggi</option></select><label class="inline-label">Definisi visual</label><textarea class="textarea-field" name="description" maxlength="700" required>${escapeHtml(item?.description || '')}</textarea><label class="inline-label">Saran tindak lanjut</label><textarea class="textarea-field" name="recommended_action" maxlength="700" required>${escapeHtml(item?.recommended_action || '')}</textarea>${edit ? `<label class="check-row" style="margin-top:12px"><input type="checkbox" name="is_active" ${item.is_active ? 'checked' : ''}><span>Kategori aktif untuk pelabelan dataset.</span></label>` : ''}`;
    if (kind === 'user') fields = `<label class="inline-label">Nama</label><input class="field" name="full_name" maxlength="120" required><label class="inline-label">Email</label><input class="field" type="email" name="email" maxlength="254" required><label class="inline-label">Peran</label><select class="select-field" name="role"><option value="operator">Pengguna</option><option value="admin">Admin</option></select><label class="inline-label">Kata sandi awal</label><input class="field" type="password" name="password" minlength="12" maxlength="128" required><p class="hint-text">Panjang minimal 12 karakter. Sistem hanya menyimpan hash kata sandi.</p>`;
    if (kind === 'model') { const approved = state.datasets.filter(dataset => dataset.status === 'APPROVED'); fields = `<label class="inline-label">Nama model</label><input class="field" name="name" maxlength="120" required placeholder="Mis. Model PPE baseline"><label class="inline-label">Versi</label><input class="field" name="version" maxlength="60" required placeholder="0.2.0"><label class="inline-label">Engine</label><input class="field" name="engine" maxlength="80" required placeholder="ONNX Runtime, Ultralytics…"><label class="inline-label">Lokasi artefak lokal</label><input class="field" name="artifact_uri" maxlength="500" placeholder="models/model.onnx"><label class="inline-label">Dataset pelatihan yang disetujui</label><select class="select-field" name="training_dataset_id"><option value="">Belum dicatat</option>${approved.map(ds => `<option value="${ds.dataset_id}">${escapeHtml(ds.name)} · ${escapeHtml(ds.version)}</option>`).join('')}</select><label class="inline-label">Tanggal pelatihan</label><input class="field" type="date" name="trained_at"><label class="inline-label">Catatan evaluasi</label><textarea class="textarea-field" name="notes" maxlength="700"></textarea><p class="hint-text">Versi ini tetap disimpan sebagai DEMO_ONLY sampai validasi dan persetujuan operasional dilakukan.</p>`; }
    const hidden = edit ? `<input type="hidden" name="record_id" value="${item.work_area_id || item.hazard_type_id}">` : '';
    document.getElementById('settings-modal-root').innerHTML = `<dialog class="modal form-dialog" aria-labelledby="config-modal-title"><form id="config-form" data-kind="${kind}" data-edit="${edit ? '1' : '0'}"><div class="modal-head"><div><p class="eyebrow">KONFIGURASI LOKAL</p><h2 id="config-modal-title">${title}</h2></div><button type="button" class="modal-close" data-close-modal aria-label="Tutup">×</button></div>${fields}${hidden}<div class="modal-actions"><button class="btn btn-secondary" type="button" data-close-modal>Batal</button><button class="btn btn-primary" type="submit">Simpan</button></div></form></dialog>`;
    showFormDialog(document.getElementById('settings-modal-root'));
  }

  async function render({ focus = false } = {}) {
    if (!state.user) return;
    const generation = ++renderGeneration;
    const owner = state.user;
    if (!titles[state.view]) state.view = 'dashboard';
    const view = state.view;
    const context = { isCurrent: () => generation === renderGeneration && owner === state.user && view === state.view };
    clearTimeout(searchTimer);
    closePageTools();
    resetInspectionPhoto();
    updateChrome();
    root.setAttribute('aria-busy', 'true');
    root.innerHTML = '<div class="card page-loading" role="status">Memuat halaman…</div>';
    try {
      if (view === 'dashboard') await renderDashboard(context);
      else if (view === 'inspection') await renderInspection(context);
      else if (view === 'learning') pageController = window.LearningUI.mount({root,api,user:state.user,onModels:data=>{if(context.isCurrent()){state.ai=data;updateChrome();}},onError:error=>{if(context.isCurrent()&&error.status===401)showLogin('Sesi berakhir. Masuk kembali.');}});
      else if (view === 'rig-dataset') pageController = window.RigDatasetUI.mount({ root, api, user: state.user });
      else if (view === 'protect-curation') pageController = window.ProtectCurationUI.mount({ root, api, user: state.user });
      else if (view === 'evaluation') pageController = window.DatasetToolsUI.mountEvaluation({ root, api, user: state.user });
      else if (view === 'history') await renderHistory(context);
      else if (view === 'analysis-detail') await renderAnalysisDetail(context);
      else if (view === 'datasets') await renderDatasets(context);
      else if (view === 'dataset-detail') await renderDatasetItems(context);
      else if (view === 'settings') {
        await renderSettings(context);
        if (context.isCurrent()) { const slot=document.createElement('div');slot.className='pdf-settings-slot';root.prepend(slot);pageController=window.InspectionHub.mountSource({root:slot,api,user:state.user}); }
      }
      else if (view === 'inspection-ai') pageController=window.InspectionHub.mountChat({root,api,user:state.user,onModels:data=>{if(context.isCurrent()){state.ai=data;updateChrome();}}});
      else if (view === 'pdf-library') pageController=window.InspectionHub.mountLibrary({root,api,user:state.user,onModels:data=>{if(context.isCurrent()){state.ai=data;updateChrome();}}});
    } catch (error) {
      if (!context.isCurrent()) return;
      if (error.status === 401) { showLogin('Sesi Anda berakhir. Masuk kembali untuk melanjutkan.'); return; }
      const oldServer = error.message === 'Endpoint tidak ditemukan.' || error.code === 'API_RESTART_REQUIRED';
      const title = oldServer ? 'Server lokal perlu dimulai ulang' : 'Data belum dapat dimuat';
      const message = oldServer ? 'Server yang sedang berjalan memakai API versi sebelumnya. Jalankan start-local.cmd dari folder proyek; peluncur memilih port kosong dan mencetak alamat yang perlu dibuka.' : error.message;
      root.innerHTML = `<div class="card card-pad">${databaseStatusPanel()}<div role="alert">${emptyState(title, message, 'ⓘ')}</div><button class="btn btn-secondary" data-reload>Muat ulang</button></div>`;
    } finally {
      if (context.isCurrent()) root.removeAttribute('aria-busy');
    }
    if (!context.isCurrent()) return;
    updateChrome();
    if (focus) { const heading = root.querySelector('h1'); if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); } }
  }

  function openDatasetModal() {
    document.getElementById('dataset-modal-root').innerHTML = `<dialog class="modal form-dialog" id="dataset-modal" aria-labelledby="dataset-modal-title"><form id="dataset-form"><div class="modal-head"><div><p class="eyebrow">DATASET TERKURASI</p><h2 id="dataset-modal-title">Buat dataset foto</h2></div><button type="button" class="modal-close" data-close-modal aria-label="Tutup">×</button></div><label class="inline-label" for="dataset-name">Nama dataset</label><input class="field" id="dataset-name" name="name" maxlength="160" required placeholder="Mis. Pemeriksaan gudang tahap 1"><label class="inline-label" for="dataset-version">Versi</label><input class="field" id="dataset-version" name="version" maxlength="40" value="1.0" required><label class="inline-label" for="dataset-notes">Catatan tujuan dan cakupan</label><textarea class="textarea-field" id="dataset-notes" name="notes" maxlength="700" placeholder="Lokasi foto, periode, kategori yang dicakup…"></textarea><div class="modal-actions"><button class="btn btn-secondary" type="button" data-close-modal>Batal</button><button class="btn btn-primary" type="submit">Buat dataset</button></div></form></dialog>`;
    showFormDialog(document.getElementById('dataset-modal-root'));
  }

  document.addEventListener('submit', async event => {
    const form = event.target;
    const owner = state.user, generation = renderGeneration, view = state.view;
    const isCurrent = () => state.user === owner && renderGeneration === generation && state.view === view;
    const actionError = error => { if (!isCurrent()) return; if (error.status === 401) showLogin('Sesi berakhir. Silakan masuk kembali.'); else showToast(error.message, true); };
    const tracked = ['feedback-form', 'dataset-form', 'dataset-item-form', 'config-form'].includes(form.id);
    const submit = tracked ? form.querySelector('button[type="submit"]') : null;
    const previousDisabled = submit?.disabled;
    if (tracked) {
      event.preventDefault(); if (pendingForms.has(form)) return;
      pendingForms.add(form); if (submit) submit.disabled = true;
    }
    try {
    if (form.id === 'login-form') {
      event.preventDefault();
      if (loginFlight || logoutFlight) return;
      const fd = new FormData(form), auth = authGeneration;
      loginFlight = true;
      const button = form.querySelector('button[type="submit"]');
      if (button) { button.disabled = true; button.textContent = 'Sedang masuk…'; }
      try {
        const data = await api('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') }) });
        if (auth !== authGeneration || state.user || logoutFlight) return;
        state.user = data.user; state.view = 'dashboard'; await render({ focus: true });
      } catch (error) {
        if (auth !== authGeneration) return;
        await refreshDatabaseHealth();
        if (auth === authGeneration) showLogin(error.message);
      } finally {
        loginFlight = false;
        const currentButton = document.querySelector('#login-form button[type="submit"]');
        if (!state.user && currentButton && !logoutFlight) { currentButton.disabled = false; currentButton.innerHTML = 'Masuk ke workspace <span class="btn-icon">→</span>'; }
      }
    } else if (form.id === 'inspection-form') { event.preventDefault(); await runInspection(form); }
    else if (form.id === 'feedback-form') {
      event.preventDefault(); const fd = new FormData(form);
      try { await api(`/api/analyses/${state.analysisId}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ corrected_label: fd.get('corrected_label'), notes: fd.get('notes') }) }); if (!isCurrent()) return; showToast('Koreksi tersimpan untuk evaluasi model.'); await render(); }
      catch (error) { actionError(error); }
    } else if (form.id === 'dataset-form') {
      event.preventDefault(); const fd = new FormData(form);
      try { await api('/api/datasets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: fd.get('name'), version: fd.get('version'), notes: fd.get('notes') }) }); if (!isCurrent()) return; showToast('Dataset dibuat.'); await render(); }
      catch (error) { actionError(error); }
    } else if (form.id === 'dataset-item-form') {
      event.preventDefault(); const file = document.getElementById('dataset-photo').files?.[0]; if (!file) return showToast('Pilih foto berlabel.', true);
      if (file !== state.datasetFile || file !== state.datasetReadyFile) return showToast('Tunggu pratinjau foto siap sebelum menyimpan label.', true);
      const fd = new FormData(form); fd.append('image', file, file.name); fd.set('annotations', JSON.stringify(state.boxes)); fd.set('license_verified', document.getElementById('license-verified').checked ? '1' : '0');
      try { const result = await api(`/api/datasets/${fd.get('dataset_id')}/items`, { method: 'POST', body: fd }); if (!isCurrent()) return; if (file !== state.datasetFile) { showToast(`Foto ${file.name} tersimpan. Pilihan foto saat ini tetap tersedia.`); return; } showToast(`Foto tersimpan dengan ${result.annotation_count} anotasi.`); state.boxes = []; state.datasetFile = null; await render(); }
      catch (error) { actionError(error); }
    } else if (form.id === 'config-form') {
      event.preventDefault(); const fd=new FormData(form), body=Object.fromEntries(fd.entries()), kind=form.dataset.kind, edit=form.dataset.edit==='1', id=body.record_id;
      if (fd.has('is_active')) body.is_active=fd.get('is_active')==='on';
      const route={area:'/api/areas',hazard:'/api/hazard-types',user:'/api/users',model:'/api/models'}[kind];
      const url=edit?`${route}/${id}`:route, method=edit?'PATCH':'POST';
      if (kind==='user'&&edit) return;
      try { await api(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); if (!isCurrent()) return; document.getElementById('settings-modal-root').innerHTML=''; showToast(kind==='model'?'Versi model dicatat sebagai DEMO_ONLY.':'Konfigurasi berhasil disimpan.'); await render(); }
      catch(error){actionError(error);}
    }
    } finally {
      if (tracked) {
        pendingForms.delete(form);
        if (submit?.isConnected) submit.disabled = form.id === 'dataset-item-form' ? !state.datasetReadyFile || state.datasetReadyFile !== state.datasetFile : Boolean(previousDisabled);
      }
    }
  });

  document.addEventListener('click', async event => {
    const owner = state.user, generation = renderGeneration, view = state.view;
    const isCurrent = () => Boolean(owner) && state.user === owner && renderGeneration === generation && state.view === view;
    const actionError = error => { if (!isCurrent()) return; if (error.status === 401) showLogin('Sesi berakhir. Silakan masuk kembali.'); else showToast(error.message, true); };
    const training = event.target.closest('[data-training-candidate]');
    if (training) { await window.RigDatasetUI.openCandidate({ analysisId: Number(training.dataset.trainingCandidate), api, onSaved: () => { if (isCurrent()) showToast('Foto masuk antrean. Buka Belajar dari foto untuk memeriksa labelnya.'); } }); return; }
    const review = event.target.closest('[data-training-review]');
    if (review) { await window.DatasetToolsUI.openImport({ datasetItemId: Number(review.dataset.trainingReview), api, onSaved: async () => { if (isCurrent()) { showToast('Label ditinjau. Verifikasi sebelum menyetujui dataset.'); await render(); } } }); return; }
    const curate = event.target.closest('[data-curate-analysis]');
    if (curate) { event.preventDefault(); await window.DatasetToolsUI.openImport({ analysisId: Number(curate.dataset.curateAnalysis), api, onSaved: () => { if (isCurrent()) showToast('Contoh berlabel masuk ke dataset. Verifikasi sebelum menyetujuinya.'); } }); return; }
    const exportButton = event.target.closest('[data-export-dataset]');
    if (exportButton) { event.preventDefault(); try { await window.DatasetToolsUI.exportDataset(Number(exportButton.dataset.exportDataset), exportButton.dataset.format, exportButton); if (isCurrent()) showToast('Paket dataset berhasil diunduh.'); } catch (error) { actionError(error); } return; }
    if (event.target.closest('[data-dismiss-dataset-delete-notice]')) { state.datasetDeleteNotice = ''; event.target.closest('.dataset-delete-cleanup-notice')?.remove(); return; }
    const datasetDelete = event.target.closest('[data-delete-dataset]');
    if (datasetDelete) { event.preventDefault(); openDatasetDeleteDialog(datasetDelete); return; }
    if (event.target.closest('[data-dismiss-delete-notice]')) { state.deleteNotice = ''; event.target.closest('.delete-cleanup-notice')?.remove(); return; }
    const deleteButton = event.target.closest('[data-delete-analysis]');
    if (deleteButton) { event.preventDefault(); openPermanentDeleteDialog(deleteButton); return; }
    const archiveButton = event.target.closest('[data-archive-analysis]');
    if (archiveButton) { event.preventDefault(); openArchiveDialog(archiveButton); return; }
    const historyScope = event.target.closest('[data-history-scope]');
    if (historyScope && state.user?.role === 'admin') { state.historyArchived = historyScope.dataset.historyScope === 'archived'; await render(); return; }
    const viewButton = event.target.closest('[data-view]');
    if (viewButton) { event.preventDefault(); if (!state.user) return; state.view = viewButton.dataset.view; setSidebarOpen(false); await render({ focus: true }); return; }
    if (event.target.closest('#dashboard-inspect')) { const form = document.getElementById('inspection-form'); await runInspection(form); return; }
    if (event.target.closest('[data-action="create-dataset"]')) { openDatasetModal(); return; }
    const datasetItems = event.target.closest('[data-dataset-items]'); if (datasetItems) { state.datasetId = datasetItems.dataset.datasetItems; state.datasetOffset = 0; state.view = 'dataset-detail'; await render(); return; }
    const datasetPage = event.target.closest('[data-dataset-page]'); if (datasetPage && state.view === 'dataset-detail') { const offset = Number(datasetPage.dataset.datasetPage); if (Number.isSafeInteger(offset) && offset >= 0 && !datasetPage.disabled) { state.datasetOffset = offset; await render({ focus: true }); } return; }
    const verifyItem = event.target.closest('[data-verify-item]'); if (verifyItem) { try { await api(`/api/dataset-items/${verifyItem.dataset.verifyItem}/verify`, { method: 'PATCH' }); if (!isCurrent()) return; showToast('Label dataset sudah diverifikasi.'); await render(); } catch (error) { actionError(error); } return; }
    const config = event.target.closest('[data-config]'); if (config) { openConfigModal(config.dataset.config); return; }
    const editArea = event.target.closest('[data-edit-area]'); if (editArea) { openConfigModal('area',state.areas.find(area=>String(area.work_area_id)===editArea.dataset.editArea)); return; }
    const editHazard = event.target.closest('[data-edit-hazard]'); if (editHazard) { openConfigModal('hazard',state.hazards.find(hazard=>String(hazard.hazard_type_id)===editHazard.dataset.editHazard)); return; }
    const toggleUser = event.target.closest('[data-toggle-user]'); if (toggleUser) { try { await api(`/api/users/${toggleUser.dataset.toggleUser}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({is_active:toggleUser.dataset.active!=='1'})}); if (!isCurrent()) return; showToast('Akses pengguna diperbarui.'); await render(); } catch(error) { actionError(error); } return; }
    const datasetStatus = event.target.closest('[data-dataset-status]'); if (datasetStatus) { try { const data=await api(`/api/datasets/${state.datasetId}/status`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:datasetStatus.dataset.datasetStatus})}); if (!isCurrent()) return; showToast(`Status dataset: ${data.status}.`); await render(); } catch(error) { actionError(error); } return; }
    const removeBox = event.target.closest('[data-remove-box]'); if (removeBox) { state.boxes.splice(Number(removeBox.dataset.removeBox), 1); state.drawBoxes?.(); renderBoxTags(); return; }
    if (event.target.closest('[data-close-modal]') || event.target.classList.contains('modal-backdrop')) { const dialog = event.target.closest('dialog.form-dialog'); if (dialog) dialog.close(); else event.target.closest('.modal-backdrop')?.remove(); return; }
    if (event.target.closest('#logout-button')) {
      if (logoutFlight) return;
      logoutFlight = api('/api/auth/logout', { method: 'POST' });
      showLogin();
      let errorText = '';
      try { await logoutFlight; } catch (error) { errorText = `Server belum mengonfirmasi keluar: ${error.message}`; }
      finally { logoutFlight = null; if (!state.user) showLogin(errorText); }
      return;
    }
    if (event.target.closest('[data-reload]')) { await render(); return; }
    if (event.target.closest('#mobile-menu')) { setSidebarOpen(!sidebar.classList.contains('is-open')); return; }
    const row = event.target.closest('[data-open-analysis],[data-analysis-id]'); if (row) { state.analysisId = row.dataset.openAnalysis || row.dataset.analysisId; state.view = 'analysis-detail'; await render({ focus: true }); return; }
    const clear = event.target.closest('#history-clear'); if (clear) { state.filter = { q: '', area: '', status: '' }; await render(); return; }
  });

  document.addEventListener('change', async event => {
    if (event.target.id === 'inspection-profile') { state.inspectionProfile = event.target.value === 'detail' ? 'detail' : 'hemat'; const note = document.getElementById('inspection-profile-note'); if (note) note.textContent = `${state.inspectionProfile === 'detail' ? 'AI menerima foto maksimal 1.024 piksel untuk meninjau detail. Pemrosesan dapat lebih lama.' : 'AI menerima foto maksimal 768 piksel agar proses lebih ringan.'} Foto asli tetap tersimpan.`; }
    if (event.target.id === 'history-area') { state.filter.area = event.target.value; await render(); }
    if (event.target.id === 'history-status') { state.filter.status = event.target.value; await render(); }
  });
  let searchTimer;
  document.addEventListener('input', event => {
    if (event.target.id === 'history-search') {
      clearTimeout(searchTimer);
      const owner = state.user, generation = renderGeneration, value = event.target.value;
      const selectionStart = event.target.selectionStart, selectionEnd = event.target.selectionEnd;
      searchTimer = setTimeout(async () => {
        if (!owner || owner !== state.user || generation !== renderGeneration || state.view !== 'history') return;
        state.filter.q = value; await render();
        if (owner !== state.user || state.view !== 'history' || renderGeneration !== generation + 1) return;
        const input = document.getElementById('history-search');
        if (input) { input.focus(); input.setSelectionRange(selectionStart ?? value.length, selectionEnd ?? value.length); }
      }, 300);
    }
  });

  async function start() {
    const auth = authGeneration;
    const [account] = await Promise.all([api('/api/auth/me').then(data => ({ data }), error => ({ error })), refreshDatabaseHealth()]);
    if (auth !== authGeneration) return;
    if (account.data) { state.user = account.data.user; await render(); }
    else showLogin(account.error?.status === 503 ? account.error.message : '');
  }
  window.addEventListener('pagehide', () => { renderGeneration += 1; authGeneration += 1; clearTimeout(searchTimer); resetInspectionPhoto(); closePageTools(); setSidebarOpen(false); });
  start();
})();
