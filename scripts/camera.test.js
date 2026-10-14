import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/camera.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function element() {
  const classes = new Set();
  return {
    attributes: {}, listeners: {}, options: [], value: '', disabled: false,
    classList: {
      add: value => classes.add(value), remove: value => classes.delete(value),
      contains: value => classes.has(value),
      toggle: (value, active) => active ? classes.add(value) : classes.delete(value)
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; if (name === 'src') this.src = ''; },
    addEventListener(name, handler) { this.listeners[name] = handler; },
    removeEventListener(name, handler) { if (this.listeners[name] === handler) delete this.listeners[name]; },
    replaceChildren() { this.options = []; this.value = ''; },
    append(option) { this.options.push(option); if (this.options.length === 1) this.value = option.value; },
    focus() { this.focused = true; }
  };
}

function mediaStream(deviceId = 'laptop') {
  const track = { stopCount: 0, stop() { this.stopCount += 1; }, getSettings: () => ({ deviceId }) };
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}

function harness(getUserMedia, { secure = true } = {}) {
  const selectors = new Map();
  const get = selector => {
    if (!selectors.has(selector)) selectors.set(selector, element());
    return selectors.get(selector);
  };
  const dialog = element();
  dialog.open = false;
  dialog.querySelector = get;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  const video = get('video');
  Object.assign(video, { srcObject: null, readyState: 2, videoWidth: 1920, videoHeight: 1080, play: async () => {} });
  const requests = [], revoked = [], callbacks = {};
  const timers = new Map();
  let timerId = 0;
  const context = {
    window: { isSecureContext: secure, addEventListener: (name, callback) => { callbacks[name] = callback; } },
    navigator: { mediaDevices: {
      getUserMedia: options => { requests.push(options); return getUserMedia(options); },
      enumerateDevices: async () => [
        { kind: 'videoinput', deviceId: 'laptop', label: 'Kamera Laptop' },
        { kind: 'videoinput', deviceId: 'usb', label: 'Kamera USB' }
      ]
    } },
    document: { hidden: false, activeElement: null, body: { append() {} }, addEventListener: (name, callback) => { callbacks[`document:${name}`] = callback; }, createElement: tag => {
      if (tag === 'dialog') return dialog;
      if (tag === 'canvas') return {
        width: 0, height: 0, getContext: () => ({ drawImage() {} }),
        toBlob(callback, mime) { queueMicrotask(() => callback(new Blob(['photo-content'], { type: mime }))); }
      };
      return element();
    } },
    URL: { createObjectURL: () => 'blob:captured-photo', revokeObjectURL: value => revoked.push(value) },
    File: class extends Blob { constructor(parts, name, options) { super(parts, options); this.name = name; this.lastModified = options.lastModified; } },
    Date, Object, Promise,
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id)
  };
  vm.runInNewContext(source, context);
  const click = selector => dialog.listeners.click({ target: { closest: match => match === selector ? get(selector) : null } });
  const expireTimers = () => { for (const [id, callback] of timers) { timers.delete(id); callback(); } };
  return { api: context.window.InspectionCamera, dialog, get, video, requests, revoked, callbacks, click, timers, expireTimers, document: context.document };
}

test('closing a pending camera permission request stops the stream that resolves later', async () => {
  let resolve;
  const stream = mediaStream();
  const h = harness(() => new Promise(value => { resolve = value; }));
  h.api.open();
  assert.equal(h.requests[0].audio, false);
  h.api.close();
  resolve(stream);
  await tick();
  assert.equal(stream.track.stopCount, 1);
  assert.equal(h.video.srcObject, null);
  assert.equal(h.dialog.open, false);
});

test('capturing stops camera, requires photo confirmation, and returns a JPEG without starting analysis', async () => {
  const stream = mediaStream();
  const h = harness(async () => stream);
  let selected;
  h.api.open({ onPhoto: photo => { selected = photo; } });
  await tick();
  assert.equal(h.get('[data-camera-capture]').disabled, false);
  h.click('[data-camera-capture]');
  await tick();
  assert.equal(stream.track.stopCount, 1);
  assert.equal(selected, undefined);
  assert.equal(h.get('[data-camera-review]').classList.contains('is-hidden'), false);
  h.click('[data-camera-use]');
  assert.equal(selected.type, 'image/jpeg');
  assert.ok(selected.name.startsWith('kamera-') && selected.name.endsWith('.jpg'));
  assert.ok(selected.size > 0 && selected.size <= 8 * 1024 * 1024);
  assert.equal(h.dialog.open, false);
  assert.deepEqual(h.revoked, ['blob:captured-photo']);
});

test('selecting USB camera stops the previous device and pagehide stops the new device', async () => {
  const laptop = mediaStream('laptop'), usb = mediaStream('usb');
  const h = harness(async options => options.video.deviceId?.exact === 'usb' ? usb : laptop);
  h.api.open();
  await tick();
  const select = h.get('[data-camera-device]');
  assert.equal(select.disabled, false);
  select.listeners.change({ target: { value: 'usb' } });
  await tick();
  assert.equal(laptop.track.stopCount, 1);
  assert.equal(h.requests[1].video.deviceId.exact, 'usb');
  assert.ok(h.requests.every(request => request.audio === false));
  assert.ok(h.requests.every(request => request.video.frameRate.max === 15));
  h.callbacks.pagehide();
  assert.equal(usb.track.stopCount, 1);
});

test('hiding a camera preview releases its device and requires an explicit resume', async () => {
  const first = mediaStream(), resumed = mediaStream(); let opened = 0;
  const h = harness(async () => opened++ ? resumed : first);
  h.api.open(); await tick();
  h.document.hidden = true; h.callbacks['document:visibilitychange']();
  assert.equal(first.track.stopCount, 1);
  assert.equal(h.video.srcObject, null);
  assert.equal(h.get('[data-camera-capture]').disabled, true);
  assert.equal(h.get('[data-camera-retry]').textContent, 'Lanjutkan kamera');
  h.document.hidden = false; h.callbacks['document:visibilitychange'](); await tick();
  assert.equal(h.requests.length, 1);
  h.click('[data-camera-retry]'); await tick();
  assert.equal(h.requests.length, 2);
  assert.equal(h.get('[data-camera-capture]').disabled, false);
  h.api.close();
});

test('hiding the tab retains an already captured photo for review', async () => {
  const h = harness(async () => mediaStream()); let chosen;
  h.api.open({ onPhoto: file => { chosen = file; } }); await tick();
  h.click('[data-camera-capture]'); await tick();
  h.document.hidden = true; h.callbacks['document:visibilitychange']();
  assert.equal(h.revoked.length, 0);
  assert.equal(h.get('[data-camera-review]').classList.contains('is-hidden'), false);
  h.document.hidden = false; h.click('[data-camera-use]');
  assert.equal(chosen.type, 'image/jpeg');
  assert.deepEqual(h.revoked, ['blob:captured-photo']);
});

test('hiding a pending camera permission request stops the stream that resolves later', async () => {
  let resolve; const stream = mediaStream();
  const h = harness(() => new Promise(value => { resolve = value; }));
  h.api.open();
  h.document.hidden = true; h.callbacks['document:visibilitychange']();
  resolve(stream); await tick();
  assert.equal(stream.track.stopCount, 1);
  assert.equal(h.video.srcObject, null);
  assert.equal(h.get('[data-camera-capture]').disabled, true);
  h.api.close();
});

test('denied access leaves a persistent localized error and retry action', async () => {
  const h = harness(async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); });
  h.api.open();
  await tick();
  const status = h.get('[data-camera-status]');
  assert.equal(status.attributes.role, 'alert');
  assert.match(status.textContent, /Akses kamera belum diizinkan/);
  assert.equal(h.get('[data-camera-retry]').classList.contains('is-hidden'), false);
  assert.equal(h.get('[data-camera-capture]').disabled, true);
  h.api.close();
});

test('insecure context never requests a camera and explains the local URL requirement', async () => {
  const h = harness(async () => mediaStream(), { secure: false });
  h.api.open();
  await tick();
  assert.equal(h.requests.length, 0);
  assert.match(h.get('[data-camera-status]').textContent, /localhost atau HTTPS/);
  h.api.close();
});

test('a camera without video frames times out, stops its tracks, and offers retry', async () => {
  const stream = mediaStream();
  const h = harness(async () => stream);
  Object.assign(h.video, { readyState: 0, videoWidth: 0, videoHeight: 0 });
  h.api.open();
  await tick();
  assert.equal(h.get('[data-camera-capture]').disabled, true);
  assert.equal(h.timers.size, 1);
  h.expireTimers();
  await tick();
  assert.equal(stream.track.stopCount, 1);
  assert.equal(h.video.srcObject, null);
  assert.match(h.get('[data-camera-status]').textContent, /10 detik/);
  assert.equal(h.get('[data-camera-retry]').classList.contains('is-hidden'), false);
  assert.equal(h.timers.size, 0);
  h.api.close();
});

test('a hanging video play request still times out and can be retried', async () => {
  const first = mediaStream(), retry = mediaStream();
  let calls = 0;
  const h = harness(async () => calls++ ? retry : first);
  Object.assign(h.video, { readyState: 0, videoWidth: 0, videoHeight: 0, play: () => new Promise(() => {}) });
  h.api.open();
  await tick();
  h.expireTimers();
  await tick();
  assert.equal(first.track.stopCount, 1);
  Object.assign(h.video, { readyState: 2, videoWidth: 1920, videoHeight: 1080, play: async () => {} });
  h.click('[data-camera-retry]');
  await tick();
  assert.equal(h.get('[data-camera-capture]').disabled, false);
  assert.equal(h.video.srcObject, retry);
  h.api.close();
});

test('closing while video frames are pending cancels readiness listeners and timer', async () => {
  const stream = mediaStream();
  const h = harness(async () => stream);
  Object.assign(h.video, { readyState: 0, videoWidth: 0, videoHeight: 0 });
  h.api.open();
  await tick();
  assert.equal(h.timers.size, 1);
  h.api.close();
  await tick();
  assert.equal(stream.track.stopCount, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.video.listeners.loadeddata, undefined);
  assert.equal(h.video.listeners.canplay, undefined);
});

test('late video frames enable capture and cancel the readiness timeout', async () => {
  const stream = mediaStream();
  const h = harness(async () => stream);
  Object.assign(h.video, { readyState: 0, videoWidth: 0, videoHeight: 0 });
  h.api.open();
  await tick();
  Object.assign(h.video, { readyState: 2, videoWidth: 1920, videoHeight: 1080 });
  h.video.listeners.loadeddata();
  await tick();
  assert.equal(h.get('[data-camera-capture]').disabled, false);
  assert.equal(h.timers.size, 0);
  h.api.close();
});

test('a playback failure stops the stream even if video dimensions already exist', async () => {
  const stream = mediaStream();
  const h = harness(async () => stream);
  h.video.play = async () => { throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' }); };
  h.api.open();
  await tick();
  assert.equal(stream.track.stopCount, 1);
  assert.equal(h.video.srcObject, null);
  assert.equal(h.get('[data-camera-capture]').disabled, true);
  assert.equal(h.get('[data-camera-retry]').classList.contains('is-hidden'), false);
  assert.equal(h.timers.size, 0);
  h.api.close();
});
