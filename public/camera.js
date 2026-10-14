(() => {
  'use strict';

  const maxPhotoBytes = 8 * 1024 * 1024;
  let dialog;
  let stream = null;
  let captureFile = null;
  let captureUrl = null;
  let requestId = 0;
  let trigger = null;
  let onPhoto = null;
  let selectedDevice = '';
  let cancelPreviewWait = null;

  function stopStream(value) {
    value?.getTracks().forEach(track => track.stop());
  }

  function clearCapture() {
    if (captureUrl) URL.revokeObjectURL(captureUrl);
    captureUrl = null;
    captureFile = null;
    dialog?.querySelector('[data-camera-photo]')?.removeAttribute('src');
  }

  function close({ restoreFocus = true } = {}) {
    requestId += 1;
    cancelPreviewWait?.();
    stopStream(stream);
    stream = null;
    if (dialog) {
      dialog.querySelector('video').srcObject = null;
      if (dialog.open) dialog.close();
    }
    clearCapture();
    onPhoto = null;
    const previousTrigger = trigger;
    trigger = null;
    if (restoreFocus && previousTrigger?.isConnected) previousTrigger.focus();
  }

  function message(text, error = false) {
    const status = dialog.querySelector('[data-camera-status]');
    status.textContent = text;
    status.classList.toggle('is-error', error);
    status.setAttribute('role', error ? 'alert' : 'status');
  }

  function cameraError(error) {
    switch (error?.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
      case 'SecurityError':
        return 'Akses kamera belum diizinkan. Izinkan kamera untuk alamat lokal ini melalui pengaturan izin browser, lalu tekan Coba lagi.';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'Kamera tidak ditemukan. Hubungkan kamera laptop atau USB, lalu tekan Coba lagi. Anda juga bisa memilih foto dari berkas.';
      case 'NotReadableError':
      case 'TrackStartError':
      case 'AbortError':
        return 'Kamera belum dapat dibuka. Tutup aplikasi lain yang sedang memakai kamera, periksa sambungannya, lalu tekan Coba lagi.';
      case 'OverconstrainedError':
        return 'Kamera yang dipilih tidak tersedia. Pilih kamera lain atau hubungkan kembali kameranya.';
      case 'PreviewTimeoutError':
        return 'Pratinjau kamera belum muncul setelah 10 detik. Periksa sambungan kamera atau tutup aplikasi lain yang memakainya, lalu tekan Coba lagi.';
      default:
        return 'Kamera belum dapat digunakan. Periksa izin dan sambungan kamera, lalu tekan Coba lagi atau pilih foto dari berkas.';
    }
  }

  function setLiveMode() {
    clearCapture();
    dialog.querySelector('[data-camera-live]').classList.remove('is-hidden');
    dialog.querySelector('[data-camera-review]').classList.add('is-hidden');
    dialog.querySelector('[data-camera-capture]').disabled = true;
    dialog.querySelector('[data-camera-retry]').classList.add('is-hidden');
  }

  async function populateDevices(id) {
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
      if (id !== requestId || !dialog.open) return;
      const select = dialog.querySelector('[data-camera-device]');
      select.replaceChildren();
      devices.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Kamera ${index + 1}`;
        select.append(option);
      });
      const actualDevice = stream?.getVideoTracks()[0]?.getSettings?.().deviceId;
      if (devices.some(device => device.deviceId === actualDevice)) select.value = actualDevice;
      selectedDevice = select.value || '';
      select.disabled = devices.length < 2;
      dialog.querySelector('[data-camera-device-note]').textContent = devices.length > 1
        ? 'Pilih kamera laptop atau USB yang ingin digunakan.'
        : 'Kamera yang terhubung ditampilkan setelah izin diberikan.';
    } catch {
      // A working preview remains usable if the browser cannot list devices.
    }
  }

  async function startCamera(deviceId = '') {
    const id = ++requestId;
    cancelPreviewWait?.();
    stopStream(stream);
    stream = null;
    const video = dialog.querySelector('video');
    video.srcObject = null;
    setLiveMode();
    dialog.querySelector('[data-camera-device]').disabled = true;
    dialog.querySelector('[data-camera-retry]').textContent = 'Coba lagi';
    if (document.hidden) {
      message('Buka tab ini kembali, lalu tekan Lanjutkan kamera. Kamera dijeda saat tab tidak terlihat.');
      dialog.querySelector('[data-camera-retry]').textContent = 'Lanjutkan kamera';
      dialog.querySelector('[data-camera-retry]').classList.remove('is-hidden');
      return;
    }
    if (!window.isSecureContext) {
      message('Kamera memerlukan alamat localhost atau HTTPS. Buka aplikasi melalui alamat lokal yang dicetak saat server dijalankan.', true);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      message('Browser ini belum mendukung akses kamera. Gunakan Chrome atau Edge terbaru, atau pilih foto dari berkas.', true);
      return;
    }
    message('Membuka kamera… Izinkan akses kamera jika browser meminta izin.');
    try {
      const openedStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
          width: { ideal: 1600 },
          height: { ideal: 1200 },
          frameRate: { ideal: 15, max: 15 }
        }
      });
      if (id !== requestId || !dialog.open) { stopStream(openedStream); return; }
      stream = openedStream;
      video.srcObject = stream;
      const capture = dialog.querySelector('[data-camera-capture]');
      openedStream.getVideoTracks().forEach(track => {
        track.onended = () => {
          if (stream !== openedStream || !dialog.open) return;
          requestId += 1;
          cancelPreviewWait?.();
          stopStream(openedStream);
          stream = null;
          video.srcObject = null;
          capture.disabled = true;
          message('Sambungan kamera terputus. Hubungkan kembali kamera, lalu tekan Coba lagi.', true);
          dialog.querySelector('[data-camera-retry]').classList.remove('is-hidden');
        };
      });
      await new Promise((resolve, reject) => {
        let timeout, settled = false, playbackReady = false;
        const finish = error => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          video.removeEventListener('loadeddata', ready);
          video.removeEventListener('canplay', ready);
          cancelPreviewWait = null;
          if (error) reject(error); else resolve();
        };
        const ready = () => {
          if (id !== requestId || !dialog.open) return finish();
          if (playbackReady && video.srcObject === openedStream && video.videoWidth && video.videoHeight && video.readyState >= 2) finish();
        };
        cancelPreviewWait = () => finish();
        video.addEventListener('loadeddata', ready);
        video.addEventListener('canplay', ready);
        timeout = setTimeout(() => finish(Object.assign(new Error('Preview not ready'), { name: 'PreviewTimeoutError' })), 10000);
        Promise.resolve().then(() => video.play()).then(() => { playbackReady = true; ready(); }, finish);
        ready();
      });
      if (id !== requestId || !dialog.open) return;
      capture.disabled = false;
      message('Arahkan kamera ke kondisi yang ingin diperiksa, lalu tekan Foto sekarang.');
      await populateDevices(id);
    } catch (error) {
      if (id !== requestId || !dialog.open) return;
      stopStream(stream);
      stream = null;
      video.srcObject = null;
      message(cameraError(error), true);
      dialog.querySelector('[data-camera-retry]').classList.remove('is-hidden');
      const deviceSelect = dialog.querySelector('[data-camera-device]');
      deviceSelect.disabled = deviceSelect.options.length < 2;
    }
  }

  async function capturePhoto() {
    const id = requestId;
    const video = dialog.querySelector('video');
    if (!stream || !video.videoWidth || !video.videoHeight || video.readyState < 2) return;
    const button = dialog.querySelector('[data-camera-capture]');
    button.disabled = true;
    const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    try {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas unavailable');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      if (id !== requestId || !dialog.open) return;
      if (!blob || !blob.size || blob.size > maxPhotoBytes) throw new Error('Photo size invalid');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      captureFile = new File([blob], `kamera-${timestamp}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
      captureUrl = URL.createObjectURL(captureFile);
      dialog.querySelector('[data-camera-photo]').src = captureUrl;
      stopStream(stream);
      stream = null;
      video.srcObject = null;
      dialog.querySelector('[data-camera-live]').classList.add('is-hidden');
      dialog.querySelector('[data-camera-review]').classList.remove('is-hidden');
      message('Periksa foto ini. Gunakan foto untuk memasukkannya ke pemeriksaan, atau ambil ulang.');
      dialog.querySelector('[data-camera-use]').focus();
    } catch {
      if (id !== requestId || !dialog.open) return;
      message('Foto belum berhasil diambil. Coba lagi dan pastikan pratinjau kamera sudah terlihat.', true);
      button.disabled = false;
    }
  }

  function ensureDialog() {
    if (dialog) return;
    dialog = document.createElement('dialog');
    dialog.className = 'camera-dialog';
    dialog.setAttribute('aria-labelledby', 'camera-dialog-title');
    dialog.setAttribute('aria-describedby', 'camera-dialog-description');
    dialog.innerHTML = `<div class="camera-dialog-head"><div><p class="section-kicker">FOTO LANGSUNG</p><h2 id="camera-dialog-title">Ambil foto</h2></div><button class="camera-close" type="button" data-camera-close aria-label="Tutup kamera">×</button></div>
      <p class="camera-description" id="camera-dialog-description">Gunakan kamera yang terhubung ke laptop. Foto akan dipilih untuk analisis setelah Anda menyetujuinya.</p>
      <div data-camera-live><label class="inline-label" for="camera-device">Kamera</label><select class="select-field" id="camera-device" data-camera-device disabled><option value="">Kamera bawaan / terhubung</option></select><p class="hint-text" data-camera-device-note>Kamera yang terhubung ditampilkan setelah izin diberikan.</p><div class="camera-stage"><video autoplay muted playsinline aria-label="Pratinjau kamera langsung"></video></div><div class="camera-actions"><button class="btn btn-secondary" type="button" data-camera-close>Batal</button><button class="btn btn-secondary is-hidden" type="button" data-camera-retry>Coba lagi</button><button class="btn btn-primary" type="button" data-camera-capture disabled>Foto sekarang</button></div></div>
      <div class="is-hidden" data-camera-review><div class="camera-stage"><img data-camera-photo alt="Pratinjau foto yang baru diambil"></div><div class="camera-actions"><button class="btn btn-secondary" type="button" data-camera-retake>Ambil ulang</button><button class="btn btn-primary" type="button" data-camera-use>Gunakan foto</button></div></div>
      <p class="camera-status" data-camera-status role="status" aria-live="polite"></p><p class="camera-privacy">Kamera berhenti setelah foto diambil atau jendela ditutup. Foto diproses oleh server lokal setelah Anda menekan Analisis dengan AI.</p>`;
    document.body.append(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('click', event => {
      if (event.target.closest('[data-camera-close]')) close();
      else if (event.target.closest('[data-camera-capture]')) capturePhoto();
      else if (event.target.closest('[data-camera-retry]') || event.target.closest('[data-camera-retake]')) startCamera(selectedDevice);
      else if (event.target.closest('[data-camera-use]') && captureFile) {
        const file = captureFile;
        const callback = onPhoto;
        close();
        callback?.(file);
      }
    });
    dialog.querySelector('[data-camera-device]').addEventListener('change', event => {
      selectedDevice = event.target.value;
      startCamera(selectedDevice);
    });
  }

  function open(options = {}) {
    close({ restoreFocus: false });
    ensureDialog();
    trigger = options.trigger || document.activeElement;
    onPhoto = options.onPhoto || null;
    selectedDevice = '';
    dialog.showModal();
    startCamera();
  }

  window.addEventListener('pagehide', () => close({ restoreFocus: false }));
  window.addEventListener('beforeunload', () => close({ restoreFocus: false }));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden || !dialog?.open || captureFile) return;
    requestId += 1;
    cancelPreviewWait?.();
    stopStream(stream); stream = null;
    dialog.querySelector('video').srcObject = null;
    dialog.querySelector('[data-camera-capture]').disabled = true;
    dialog.querySelector('[data-camera-retry]').textContent = 'Lanjutkan kamera';
    dialog.querySelector('[data-camera-retry]').classList.remove('is-hidden');
    message('Kamera dijeda saat tab tidak terlihat. Tekan Lanjutkan kamera untuk membuka kamera kembali.');
  });
  window.InspectionCamera = Object.freeze({ open, close });
})();
