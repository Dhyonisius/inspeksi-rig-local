import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
// Some repository versions do not ship the optional performance page. Keep the
// inspection/UI regression tests runnable, and report those optional tests as
// skipped rather than failing every test while importing a nonexistent asset.
const performanceSource = await fs.readFile(new URL('../public/performance-ui.js', import.meta.url), 'utf8')
  .catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
const instrumented = source.replace(/\s+start\(\);\s*\}\)\(\);\s*$/, '\nwindow.__appTest = { state, render, selectInspectionFile, runInspection, renderAnalysisRows }; window.__appStart = start();\n})();');
assert.notEqual(instrumented, source, 'Test hooks must attach at the app bootstrap, without modifying the production file.');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

// A small DOM and clock mock exercises app events and asynchronous rendering.
// Native browser keyboard behavior and visual layout remain browser QA checks.
function harness(overrides = {}) {
  const ids = new Map(), all = [], images = [], listeners = new Map(), timers = new Map(), calls = [], revoked = [];
  let nextTimer = 0, nextUrl = 0;
  const document = { activeElement: null };
  class Element {
    constructor(tag = 'div', id = '') {
      this.tagName = tag.toUpperCase(); this.id = id; this.dataset = {}; this.attributes = {};
      this.isConnected = true; this.disabled = false; this.value = ''; this.files = [];
      this.listeners = new Map(); this.classes = new Set(); this.nodes = []; this._html = '';
      this.classList = {
        add: (...values) => values.forEach(value => this.classes.add(value)),
        remove: (...values) => values.forEach(value => this.classes.delete(value)),
        contains: value => this.classes.has(value),
        toggle: (value, force) => { const present = force ?? !this.classes.has(value); present ? this.classes.add(value) : this.classes.delete(value); return present; },
      };
      if (id) ids.set(id, this);
      all.push(this);
    }
    set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
    get className() { return [...this.classes].join(' '); }
    set value(value) { this._value = value; if (value === '' && this.tagName === 'INPUT' && this.attributes.type === 'file') this.files = []; }
    get value() { return this._value; }
    setConnected(connected) { this.isConnected = connected; this.nodes.forEach(node => node.setConnected(connected)); }
    set innerHTML(value) {
      for (const node of this.nodes) { node.setConnected(false); if (node.id && ids.get(node.id) === node) ids.delete(node.id); }
      this.nodes = []; this._html = value;
      for (const match of value.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
        const attrs = Object.fromEntries([...match[2].matchAll(/([a-z][a-z0-9-]*)="([^"]*)"/gi)].map(attr => [attr[1], attr[2]]));
        for (const attr of match[2].matchAll(/(?:^|\s)(data-[a-z-]+)(?=\s|$)/gi)) attrs[attr[1]] = '';
        const node = new Element(match[1], attrs.id || ''); node.parent = this;
        for (const [name, content] of Object.entries(attrs)) node.setAttribute(name, content);
        node.disabled = /(?:^|\s)disabled(?:\s|$)/.test(match[2]);
        node.value = attrs.value || ''; this.nodes.push(node);
      }
      for (const form of this.nodes.filter(node => node.tagName === 'FORM')) {
        const fragment = value.match(new RegExp(`<form\\b[^>]*id="${form.id}"[^>]*>([\\s\\S]*?)<\\/form>`))?.[1] || '';
        if (/<button\b[^>]*type="submit"/.test(fragment)) {
          form.submitButton = new Element('button'); form.submitButton.attributes.type = 'submit';
          form.submitButton.disabled = /<button\b[^>]*type="submit"[^>]*\bdisabled/.test(fragment);
          form.submitButton.parent = form; this.nodes.push(form.submitButton);
        }
      }
    }
    get innerHTML() { return this._html; }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === 'class') this.className = value;
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
    }
    removeAttribute(name) { delete this.attributes[name]; if (name === 'src') this.src = ''; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    matches(selector) {
      return selector.split(',').some(part => {
        part = part.trim();
        if (part.endsWith(':checked')) return Boolean(this.checked) && this.matches(part.slice(0, -8));
        if (part.startsWith('#')) return this.id === part.slice(1);
        if (part.startsWith('.')) return this.classes.has(part.slice(1));
        const attr = part.match(/^\[([^\]=]+)(?:="([^"]*)")?\]$/);
        if (attr) return attr[2] === undefined ? Object.hasOwn(this.attributes, attr[1]) || attr[1].startsWith('data-') && this.dataset[attr[1].slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] !== undefined : this.attributes[attr[1]] === attr[2];
        return part.toUpperCase() === this.tagName;
      });
    }
    closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
    querySelector(selector) {
      if (selector === 'button[type="submit"]') return this.submitButton || null;
      const direct = this.nodes.find(node => node.isConnected && node.matches(selector));
      if (direct) return direct;
      for (const node of this.nodes) { if (node.isConnected) { const nested = node.querySelector(selector); if (nested) return nested; } }
      return null;
    }
    querySelectorAll(selector) { return this.nodes.filter(node => node.isConnected && node.matches(selector)).concat(this.nodes.filter(node => node.isConnected).flatMap(node => node.querySelectorAll(selector))); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
    dispatchEvent(event) { return this.listeners.get(event.type)?.({ ...event, target: this, currentTarget: this }); }
    append(...nodes) { for (const node of nodes) { node.parent = this; node.setConnected(this.isConnected); this.nodes.push(node); } }
    prepend(node) { node.parent = this; node.setConnected(this.isConnected); this.nodes.unshift(node); }
    replaceChildren(...nodes) { this.innerHTML = ''; this.append(...nodes); }
    getContext() { return { clearRect() {}, strokeRect() {}, fillRect() {} }; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
    setPointerCapture() {}
    focus() { document.activeElement = this; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    remove() { this.isConnected = false; }
  }
  for (const id of ['page-root', 'login-screen', 'app-shell', 'toast', 'sidebar', 'mobile-menu', 'user-name', 'user-role', 'avatar-initials', 'today-label', 'breadcrumb-current', 'logout-button']) new Element('div', id);
  const brand = new Element('a'); brand.className = 'brand'; brand.setAttribute('href', '#dashboard');
  const main = new Element('main'); main.className = 'main-area';
  const nav = ['dashboard', 'inspection', 'history', 'datasets'].map(view => { const node = new Element('button'); node.className = 'nav-link'; node.setAttribute('data-view', view); return node; });
  Object.assign(document, {
    getElementById: id => ids.get(id)?.isConnected ? ids.get(id) : null,
    createElement: tag => { const node = new Element(tag); node.isConnected = false; return node; },
    querySelector: selector => selector.includes(' button[type="submit"]') ? ids.get(selector.split(' ')[0].slice(1))?.submitButton || null : all.find(node => node.isConnected && node.matches(selector)) || null,
    querySelectorAll: selector => all.filter(node => node.isConnected && node.matches(selector)),
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); },
  });
  const windowListeners = new Map();
  const user = { user_id: 1, full_name: 'Fixture User', role: 'operator' };
  const fixtures = url => {
    if (url === '/api/auth/me') return { user };
    if (url === '/api/health') return { database: 'ready', api_version: 6 };
    if (url === '/api/areas') return { areas: [{ work_area_id: 7, name: 'Fixture area', area_type: 'GUDANG' }] };
    if (url === '/api/ai/status') return { available: true, vision_models: [{ name: 'original-model' }] };
    if (url === '/api/dashboard') return { stats: { total: 1, found: 0, feedback_count: 0, dataset_items: 0 }, recent: [] };
    if (url.startsWith('/api/analyses?')) return { total: 0, analyses: [] };
    if (/^\/api\/analyses\/\d+$/.test(url)) return { analysis: { analysis_id: Number(url.split('/').at(-1)), image_id: 9, original_name: 'fixture.png', area_name: 'Fixture area', analyzed_at: '2026-10-05T01:00:00Z', result_status: 'NO_VISIBLE_HAZARD' }, findings: [], prediction: null, feedback: null };
    if (url === '/api/datasets') return { datasets: [] };
    if (url === '/api/hazard-types') return { hazards: [] };
    if (url === '/api/auth/logout') return null;
    throw new Error(`Unexpected mocked app request: ${url}`);
  };
  class FormDataMock {
    constructor(form) { this.values = new Map(Object.entries(form?.fields || {})); }
    append(name, value) { this.values.set(name, value); }
    set(name, value) { this.values.set(name, value); }
    get(name) { return this.values.get(name) ?? null; }
    has(name) { return this.values.has(name); }
    entries() { return this.values.entries(); }
  }
  class ImageMock extends Element {
    constructor() { super('img'); this.isConnected = false; images.push(this); }
    load(width = 100, height = 80) { this.naturalWidth = width; this.naturalHeight = height; this.onload?.(); }
    fail() { this.onerror?.(); }
  }
  const window = {
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener: (name, callback) => windowListeners.set(name, callback),
    removeEventListener: (name, callback) => { if (windowListeners.get(name) === callback) windowListeners.delete(name); },
    InspectionCamera: { close() {} }, DatasetToolsUI: { close() {} },
  };
  const context = vm.createContext({
    window, document, console, Intl, Date, URLSearchParams, AbortController, FormData: FormDataMock, Image: ImageMock,
    location: { hostname: '127.0.0.1', protocol: 'http:' },
    Event: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    URL: { createObjectURL: () => `blob:fixture-${++nextUrl}`, revokeObjectURL: value => revoked.push(value) },
    setTimeout: (callback, ms) => { const id = ++nextTimer; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options = {}) => { calls.push({ url, options }); return overrides[url] ? await overrides[url](options) : response(fixtures(url), url === '/api/auth/logout' ? 204 : 200); },
  });
  vm.runInContext(performanceSource, context);
  vm.runInContext(instrumented, context);
  const emit = (name, target, extras = {}) => listeners.get(name)?.({ target, preventDefault() { this.defaultPrevented = true; }, ...extras });
  const target = (dataset = {}, id = '') => { const node = new Element('button', id); for (const [key, value] of Object.entries(dataset)) node.setAttribute(`data-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, value); return node; };
  const navigate = view => emit('click', target({ view }));
  return { ...window.__appTest, boot: window.__appStart, document, window, root: ids.get('page-root'), toast: ids.get('toast'), brand, nav, calls, timers, revoked, images, overrides, emit, target, navigate };
}

async function readyInspection(h) {
  await h.boot;
  const form = h.document.getElementById('inspection-form');
  h.document.getElementById('inspection-area').value = '7';
  h.document.getElementById('vision-model').value = 'original-model';
  h.selectInspectionFile({ name: 'fixture.png', type: 'image/png', size: 123 });
  return form;
}

async function readyDataset(h) {
  await h.boot;
  h.overrides['/api/datasets'] = () => response({ datasets: [{ dataset_id: 4, name: 'Fixture dataset', version: '1', status: 'DRAFT', dataset_kind: 'HAZARD', item_count: 0, verified_count: 0 }] });
  h.overrides['/api/hazard-types'] = () => response({ hazards: [{ hazard_type_id: 7, name: 'Fixture hazard', is_active: true }] });
  await h.navigate('datasets');
  const form = h.document.getElementById('dataset-item-form');
  form.fields = { dataset_id: '4', split: 'TRAIN', overall_label: 'RISK', license_name: 'Internal' };
  h.document.getElementById('license-verified').checked = true;
  const input = h.document.getElementById('dataset-photo');
  const select = file => { input.files = file ? [file] : []; input.value = file?.name || ''; return input.dispatchEvent({ type: 'change' }); };
  return { form, input, select, wrap: h.document.getElementById('dataset-preview-wrap'), submit: form.submitButton };
}

test('a delayed old page response or 401 cannot overwrite a newer page or log out its user', async () => {
  for (const status of [200, 401]) {
    const old = deferred();
    const h = harness({ '/api/dashboard': () => old.promise });
    await tick();
    await h.navigate('history');
    const html = h.root.innerHTML;
    old.resolve(response(status === 200 ? { stats: {}, recent: [] } : { error: 'Expired old request' }, status));
    await h.boot;
    assert.equal(h.state.view, 'history');
    assert.equal(h.root.innerHTML, html);
    assert.equal(h.state.user.full_name, 'Fixture User');
    assert.equal(h.root.getAttribute('aria-busy'), null);
  }
});

test('invalid file selection clears the previous photo, filename, preview, and object URL', async () => {
  const h = harness(); await readyInspection(h);
  const input = h.document.getElementById('inspection-file');
  for (const file of [
    { name: 'invalid.pdf', type: 'application/pdf', size: 42 },
    { name: 'empty.png', type: 'image/png', size: 0 },
    { name: 'oversized.png', type: 'image/png', size: 8 * 1024 * 1024 + 1 },
  ]) {
    h.selectInspectionFile({ name: 'prior.png', type: 'image/png', size: 123 });
    const oldUrl = h.state.objectUrl;
    input.files = [file]; input.value = file.name; await input.dispatchEvent({ type: 'change' });
    assert.equal(h.state.selectedFile, null);
    assert.equal(h.state.objectUrl, null);
    assert.ok(h.revoked.includes(oldUrl));
    assert.equal(input.value, '');
    assert.equal(h.document.getElementById('inspection-preview').src, '');
    assert.equal(h.document.getElementById('inspection-file-name').textContent, '');
    assert.equal(h.document.getElementById('inspection-preview-wrap').classList.contains('is-hidden'), true);
    assert.match(h.document.getElementById('inspection-error').textContent, /JPG, PNG, atau WebP/);
  }
});

test('duplicate inspection submissions are suppressed and the chosen model and file are snapshotted', async () => {
  const h = harness(); const form = await readyInspection(h);
  h.document.getElementById('inspection-profile').value = 'detail';
  const health = deferred(), result = deferred();
  h.overrides['/api/health'] = () => health.promise;
  h.overrides['/api/analyses'] = () => result.promise;
  const chosenFile = h.state.selectedFile;
  const first = h.runInspection(form);
  await h.runInspection(form);
  assert.equal(h.document.getElementById('dashboard-inspect').disabled, true);
  assert.equal(h.document.getElementById('vision-model').disabled, true);
  assert.equal(h.document.getElementById('inspection-profile').disabled, true);
  h.document.getElementById('vision-model').value = 'changed-model';
  h.document.getElementById('inspection-profile').value = 'hemat';
  h.document.getElementById('inspection-area').value = '99';
  health.resolve(response({ database: 'ready' })); await tick();
  await h.runInspection(form);
  const posts = h.calls.filter(call => call.url === '/api/analyses');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].options.body.get('vision_model'), 'original-model');
  assert.equal(posts[0].options.body.get('performance_profile'), 'detail');
  assert.equal(posts[0].options.body.get('work_area_id'), '7');
  assert.equal(posts[0].options.body.get('image'), chosenFile);
  result.resolve(response({ analysis_id: 42, result_status: 'NO_VISIBLE_HAZARD' })); await first;
  assert.equal(h.state.view, 'analysis-detail');
  assert.equal(h.state.analysisId, 42);
});

test('navigation during the health preflight cancels submission and a detached form cannot start one', async () => {
  const h = harness(); const form = await readyInspection(h);
  const health = deferred(); h.overrides['/api/health'] = () => health.promise;
  const pending = h.runInspection(form);
  await h.navigate('history');
  health.resolve(response({ database: 'ready' })); await pending;
  await h.runInspection(form);
  assert.equal(form.isConnected, false);
  assert.equal(h.calls.filter(call => call.url === '/api/analyses').length, 0);
  assert.equal(h.state.view, 'history');
});

test('late completed inference leaves the page the user opened and does not display a stale toast', async () => {
  const h = harness(); const form = await readyInspection(h);
  const result = deferred(); h.overrides['/api/analyses'] = () => result.promise;
  const pending = h.runInspection(form); await tick();
  await h.navigate('history'); const html = h.root.innerHTML;
  result.resolve(response({ analysis_id: 42, result_status: 'NO_VISIBLE_HAZARD' })); await pending;
  assert.equal(h.state.view, 'history');
  assert.equal(h.state.analysisId, null);
  assert.equal(h.root.innerHTML, html);
  assert.equal(h.toast.classList.contains('is-visible'), false);
});

test('logout blocks login until acknowledged and late inference cannot restore the previous session', async () => {
  const h = harness(); const form = await readyInspection(h);
  const result = deferred(), logout = deferred();
  h.overrides['/api/analyses'] = () => result.promise;
  h.overrides['/api/auth/logout'] = () => logout.promise;
  const pending = h.runInspection(form); await tick();
  const leaving = h.emit('click', h.document.getElementById('logout-button'));
  assert.equal(h.state.user, null);
  const loginForm = h.document.getElementById('login-form');
  assert.equal(loginForm.submitButton.disabled, true);
  await h.emit('submit', loginForm);
  assert.equal(h.calls.filter(call => call.url === '/api/auth/login').length, 0);
  result.resolve(response({ analysis_id: 42, result_status: 'NO_VISIBLE_HAZARD' })); await pending;
  assert.equal(h.root.innerHTML, '');
  assert.equal(h.state.user, null);
  assert.equal(h.toast.classList.contains('is-visible'), false);
  logout.resolve(response(null, 204)); await leaving;
  assert.equal(h.document.getElementById('login-form').submitButton.disabled, false);
});

test('a pending initial auth response cannot restore a session after logout', async () => {
  const me = deferred(); const h = harness({ '/api/auth/me': () => me.promise });
  await tick();
  await h.emit('click', h.document.getElementById('logout-button'));
  me.resolve(response({ user: { user_id: 1, full_name: 'Old session', role: 'operator' } })); await h.boot;
  assert.equal(h.state.user, null);
  assert.equal(h.root.innerHTML, '');
  assert.ok(h.document.getElementById('login-form'));
});

test('history debounce is canceled on navigation and an already queued callback remains harmless', async () => {
  const h = harness(); await h.boot; await h.navigate('history');
  const input = h.document.getElementById('history-search'); input.value = 'delayed query';
  await h.emit('input', input);
  const debounce = [...h.timers.values()].find(timer => timer.ms === 300);
  assert.ok(debounce);
  await h.navigate('inspection');
  const html = h.root.innerHTML, count = h.calls.length;
  assert.equal([...h.timers.values()].filter(timer => timer.ms === 300).length, 0);
  await debounce.callback();
  assert.equal(h.calls.length, count);
  assert.equal(h.state.filter.q, '');
  assert.equal(h.root.innerHTML, html);
});

test('analysis titles use native buttons and keyboard-origin clicks open details; the brand opens dashboard', async () => {
  const h = harness(); await h.boot;
  const rows = h.renderAnalysisRows([{ analysis_id: 42, original_name: 'fixture.png' }]);
  assert.match(rows, /<button type="button" class="[^"]*analysis-open[^"]*" data-open-analysis="42"/);
  await h.emit('click', h.target({ openAnalysis: '42' }), { detail: 0 });
  assert.equal(h.state.view, 'analysis-detail');
  assert.ok(h.calls.some(call => call.url === '/api/analyses/42'));
  assert.equal(h.brand.dataset.view, 'dashboard');
  assert.equal(h.brand.getAttribute('aria-label'), 'Buka Ringkasan');
  await h.emit('click', h.brand);
  assert.equal(h.state.view, 'dashboard');
  assert.equal(h.document.activeElement.tagName, 'H1');
  assert.equal(h.nav[0].getAttribute('aria-current'), 'page');
});

test('an inspection 401 clears its photo and returns to login with a session message', async () => {
  const h = harness(); const form = await readyInspection(h);
  const oldUrl = h.state.objectUrl;
  h.overrides['/api/analyses'] = () => response({ error: 'Session expired' }, 401);
  await h.runInspection(form);
  assert.equal(h.state.user, null);
  assert.equal(h.state.selectedFile, null);
  assert.equal(h.state.objectUrl, null);
  assert.ok(h.revoked.includes(oldUrl));
  assert.equal(h.root.innerHTML, '');
  assert.match(h.document.getElementById('login-screen').innerHTML, /Sesi berakhir/);
  assert.equal(h.document.getElementById('login-form').submitButton.disabled, false);
  assert.equal(h.toast.classList.contains('is-visible'), false);
});

test('late click mutations cannot redraw a new page, erase its selected photo, show a toast, or restore logout', async () => {
  const actions = [
    { dataset: { verifyItem: '12' }, url: '/api/dataset-items/12/verify', result: { ok: true } },
    { dataset: { toggleUser: '2', active: '1' }, url: '/api/users/2', result: { ok: true } },
    { dataset: { datasetStatus: 'APPROVED' }, url: '/api/datasets/4/status', result: { status: 'APPROVED' } },
  ];
  for (const action of actions) for (const status of [200, 500, 401]) for (const destination of ['inspection', 'logout']) {
    const h = harness(); await h.boot; h.state.datasetId = '4';
    const result = deferred(); h.overrides[action.url] = () => result.promise;
    const pending = h.emit('click', h.target(action.dataset));
    if (destination === 'logout') await h.emit('click', h.document.getElementById('logout-button'));
    else {
      await h.navigate('inspection');
      h.selectInspectionFile({ name: 'new-page.png', type: 'image/png', size: 123 });
    }
    const html = h.root.innerHTML, file = h.state.selectedFile, calls = h.calls.length;
    result.resolve(response(status === 200 ? action.result : { error: 'Old mutation response' }, status));
    await pending;
    assert.equal(h.root.innerHTML, html, `${action.url}, status ${status}, ${destination}`);
    assert.equal(h.state.selectedFile, file);
    assert.equal(h.calls.length, calls);
    assert.equal(h.toast.classList.contains('is-visible'), false);
    if (destination === 'logout') {
      assert.equal(h.state.user, null);
      assert.ok(h.document.getElementById('login-form'));
    } else {
      assert.equal(h.state.view, 'inspection');
      assert.equal(h.state.user.full_name, 'Fixture User');
      assert.equal(h.state.selectedFile.name, 'new-page.png');
    }
  }
});

test('a current click mutation 401 returns to login instead of showing a stale action error', async () => {
  const h = harness(); await h.boot;
  h.overrides['/api/dataset-items/12/verify'] = () => response({ error: 'Session expired' }, 401);
  await h.emit('click', h.target({ verifyItem: '12' }));
  assert.equal(h.state.user, null);
  assert.equal(h.root.innerHTML, '');
  assert.match(h.document.getElementById('login-screen').innerHTML, /Sesi berakhir/);
  assert.equal(h.toast.classList.contains('is-visible'), false);
});

test('late export and curation callbacks remain quiet after navigation or logout', async () => {
  for (const action of ['export', 'curate']) for (const destination of ['inspection', 'logout']) {
    const h = harness(); await h.boot;
    let saved;
    const result = deferred();
    h.window.DatasetToolsUI.exportDataset = () => result.promise;
    h.window.DatasetToolsUI.openImport = options => { saved = options.onSaved; return result.promise; };
    const pending = h.emit('click', h.target(action === 'export' ? { exportDataset: '4', format: 'yolo' } : { curateAnalysis: '42' }));
    if (destination === 'logout') await h.emit('click', h.document.getElementById('logout-button'));
    else await h.navigate('inspection');
    const html = h.root.innerHTML, calls = h.calls.length;
    result.resolve(); await pending; saved?.();
    assert.equal(h.root.innerHTML, html);
    assert.equal(h.calls.length, calls);
    assert.equal(h.toast.classList.contains('is-visible'), false);
    assert.equal(Boolean(h.state.user), destination !== 'logout');
  }
});

test('dataset previews ignore out-of-order image loads and upload boxes for the displayed file', async () => {
  const h = harness(); const { form, select, wrap, submit } = await readyDataset(h);
  const fileA = { name: 'slow-A.png', type: 'image/png', size: 123 };
  const fileB = { name: 'fast-B.png', type: 'image/png', size: 124 };
  await select(fileA); const imageA = h.images.at(-1), urlA = h.state.datasetUrl;
  await select(fileB); const imageB = h.images.at(-1);
  assert.ok(h.revoked.includes(urlA));
  assert.equal(submit.disabled, true);
  imageB.load(120, 90);
  const holder = wrap.nodes[0], canvas = holder.nodes[1];
  assert.equal(holder.nodes[0], imageB);
  assert.equal(h.state.datasetReadyFile, fileB);
  assert.equal(submit.disabled, false);
  imageA.load(640, 480);
  assert.equal(wrap.nodes[0], holder);
  assert.equal(canvas.width, 120);
  assert.equal(canvas.height, 90);
  assert.equal(h.state.datasetFile, fileB);
  assert.equal(h.state.datasetReadyFile, fileB);
  h.document.getElementById('annotation-hazard').value = '7';
  canvas.dispatchEvent({ type: 'pointerdown', clientX: 10, clientY: 20, pointerId: 1 });
  canvas.dispatchEvent({ type: 'pointerup', clientX: 70, clientY: 80, pointerId: 1 });
  assert.equal(h.state.boxes.length, 1);
  const result = deferred(); h.overrides['/api/datasets/4/items'] = () => result.promise;
  const pending = h.emit('submit', form);
  const post = h.calls.find(call => call.url === '/api/datasets/4/items');
  assert.ok(post);
  assert.equal(post.options.body.get('image'), fileB);
  const boxes = JSON.parse(post.options.body.get('annotations'));
  assert.equal(boxes[0].hazard_type_id, 7);
  assert.equal(boxes[0].x, .1);
  assert.equal(boxes[0].y, .2);
  result.resolve(response({ annotation_count: 1 }, 201)); await pending;
});

test('late dataset image callbacks after navigation or logout cannot restore a preview or annotation state', async () => {
  for (const destination of ['inspection', 'logout']) {
    const h = harness(); const { input, select, wrap } = await readyDataset(h);
    await select({ name: 'late.png', type: 'image/png', size: 123 });
    const image = h.images.at(-1), url = h.state.datasetUrl;
    if (destination === 'logout') await h.emit('click', h.document.getElementById('logout-button'));
    else await h.navigate('inspection');
    const html = h.root.innerHTML;
    image.load(); image.fail();
    assert.equal(input.isConnected, false);
    assert.equal(wrap.isConnected, false);
    assert.ok(h.revoked.includes(url));
    assert.equal(h.state.datasetFile, null);
    assert.equal(h.state.datasetReadyFile, null);
    assert.equal(h.state.datasetUrl, null);
    assert.equal(h.state.boxes.length, 0);
    assert.equal(h.state.drawBoxes, null);
    assert.equal(h.root.innerHTML, html);
    assert.equal(h.toast.classList.contains('is-visible'), false);
  }
});

test('empty or invalid dataset selections discard prior boxes and disable saving', async () => {
  const h = harness(); const { input, select, wrap, submit } = await readyDataset(h);
  for (const replacement of [null, { name: 'bad.pdf', type: 'application/pdf', size: 123 }, { name: 'empty.png', type: 'image/png', size: 0 }, { name: 'large.png', type: 'image/png', size: 8 * 1024 * 1024 + 1 }]) {
    await select({ name: 'prior.png', type: 'image/png', size: 123 }); h.images.at(-1).load();
    const url = h.state.datasetUrl;
    h.state.boxes.push({ hazard_type_id: 7, x: .1, y: .1, width: .2, height: .2 });
    h.state.dragStart = { x: .1, y: .1 };
    await select(replacement);
    assert.ok(h.revoked.includes(url));
    assert.equal(h.state.datasetFile, null);
    assert.equal(h.state.datasetReadyFile, null);
    assert.equal(h.state.datasetUrl, null);
    assert.equal(h.state.drawBoxes, null);
    assert.equal(h.state.dragStart, null);
    assert.equal(h.state.boxes.length, 0);
    assert.equal(input.files.length, 0);
    assert.equal(submit.disabled, true);
    assert.match(wrap.innerHTML, /Pratinjau foto/);
    assert.match(h.document.getElementById('box-list').innerHTML, /Belum ada kotak/);
    assert.equal(h.document.getElementById('dataset-file-name').textContent, 'Pilih foto sumber');
  }
});

test('a dataset image decoding error clears the file and URL and leaves saving disabled', async () => {
  const h = harness(); const { input, select, wrap, submit } = await readyDataset(h);
  await select({ name: 'corrupt.png', type: 'image/png', size: 123 });
  const image = h.images.at(-1), url = h.state.datasetUrl;
  image.fail();
  assert.equal(h.state.datasetFile, null);
  assert.equal(h.state.datasetReadyFile, null);
  assert.equal(h.state.datasetUrl, null);
  assert.ok(h.revoked.includes(url));
  assert.equal(input.files.length, 0);
  assert.equal(submit.disabled, true);
  assert.match(wrap.innerHTML, /role="alert"/);
  assert.match(wrap.innerHTML, /Foto tidak dapat dibaca/);
  image.load();
  assert.equal(h.state.datasetReadyFile, null);
  assert.equal(submit.disabled, true);
});

test('dataset saving is blocked until the currently selected file has a loaded preview', async () => {
  const h = harness(); const { form, input, select, submit } = await readyDataset(h);
  const fileA = { name: 'ready-A.png', type: 'image/png', size: 123 };
  await select(fileA);
  await h.emit('submit', form);
  assert.equal(submit.disabled, true);
  assert.equal(h.calls.filter(call => call.url === '/api/datasets/4/items').length, 0);
  h.images.at(-1).load(); assert.equal(submit.disabled, false);
  input.files = [{ name: 'mismatched.png', type: 'image/png', size: 123 }];
  await h.emit('submit', form);
  assert.equal(h.calls.filter(call => call.url === '/api/datasets/4/items').length, 0);
  await select({ name: 'loading-B.png', type: 'image/png', size: 123 });
  await h.emit('submit', form);
  assert.equal(submit.disabled, true);
  assert.equal(h.calls.filter(call => call.url === '/api/datasets/4/items').length, 0);
  assert.match(h.toast.textContent, /Tunggu pratinjau/);
});

test('current feedback, dataset, dataset item, and configuration submission 401s return to login', async () => {
  const cases = [
    { id: 'feedback-form', url: '/api/analyses/42/feedback', fields: { corrected_label: 'RAGU', notes: '' } },
    { id: 'dataset-form', url: '/api/datasets', fields: { name: 'Fixture', version: '1' } },
    { id: 'config-form', url: '/api/areas', fields: { name: 'Fixture', area_type: 'GUDANG' }, dataset: { kind: 'area' } },
    { id: 'dataset-item-form', url: '/api/datasets/4/items' },
  ];
  for (const entry of cases) {
    const h = harness(); await h.boot; h.state.analysisId = 42;
    let form;
    if (entry.id === 'dataset-item-form') {
      const ready = await readyDataset(h); form = ready.form;
      await ready.select({ name: 'fixture.png', type: 'image/png', size: 123 }); h.images.at(-1).load();
    } else { form = h.target(entry.dataset, entry.id); form.fields = entry.fields; }
    h.overrides[entry.url] = () => response({ error: 'Session expired' }, 401);
    await h.emit('submit', form);
    assert.equal(h.state.user, null, entry.id);
    assert.equal(h.root.innerHTML, '');
    assert.match(h.document.getElementById('login-screen').innerHTML, /Sesi berakhir/);
    assert.equal(h.toast.classList.contains('is-visible'), false);
  }
});

test('saving file A preserves a newer file B and enables save only when B is ready', async () => {
  for (const readyBeforeResponse of [true, false]) {
    const h = harness(); const { form, select, wrap, submit } = await readyDataset(h);
    const fileA = { name: 'saving-A.png', type: 'image/png', size: 123 };
    const fileB = { name: 'draft-B.png', type: 'image/png', size: 124 };
    await select(fileA); h.images.at(-1).load();
    h.state.boxes.push({ hazard_type_id: 7, x: .1, y: .2, width: .3, height: .4 });
    const result = deferred(); h.overrides['/api/datasets/4/items'] = () => result.promise;
    const pending = h.emit('submit', form);
    const post = h.calls.find(call => call.url === '/api/datasets/4/items');
    assert.equal(post.options.body.get('image'), fileA);
    const savedBoxes = JSON.parse(post.options.body.get('annotations'));
    await select(fileB); const imageB = h.images.at(-1), urlB = h.state.datasetUrl;
    if (readyBeforeResponse) imageB.load(120, 90);
    assert.equal(submit.disabled, true, 'A pending save must keep B loading from enabling another submission');
    h.state.boxes.push({ hazard_type_id: 7, x: .5, y: .4, width: .2, height: .3 });
    const draft = h.state.boxes, preview = wrap.nodes[0], calls = h.calls.length;
    result.resolve(response({ annotation_count: 1 }, 201)); await pending;
    assert.equal(h.state.datasetFile, fileB);
    assert.equal(h.state.datasetUrl, urlB);
    assert.equal(h.state.boxes, draft);
    assert.equal(h.state.boxes[0].x, .5);
    assert.equal(savedBoxes[0].x, .1);
    assert.equal(wrap.nodes[0], preview);
    assert.equal(h.revoked.includes(urlB), false);
    assert.equal(h.calls.length, calls, 'Completing A must not reload the dataset page and erase B');
    assert.equal(submit.disabled, !readyBeforeResponse);
    assert.match(h.toast.textContent, /saving-A\.png tersimpan/);
    if (!readyBeforeResponse) imageB.load();
    assert.equal(h.state.datasetReadyFile, fileB);
    assert.equal(submit.disabled, false);
  }
});

async function mutationForm(h, kind) {
  await h.boot;
  h.state.analysisId = 42;
  if (kind === 'dataset-item-form') {
    const ready = await readyDataset(h);
    await ready.select({ name: 'fixture.png', type: 'image/png', size: 123 }); h.images.at(-1).load();
    return { form: ready.form, url: '/api/datasets/4/items' };
  }
  const data = {
    'feedback-form': { url: '/api/analyses/42/feedback', fields: { corrected_label: 'RAGU', notes: '' } },
    'dataset-form': { url: '/api/datasets', fields: { name: 'Fixture', version: '1' } },
    'config-form': { url: '/api/areas', fields: { name: 'Fixture', area_type: 'GUDANG' } },
  }[kind];
  h.root.innerHTML = `<form id="${kind}" ${kind === 'config-form' ? 'data-kind="area"' : ''}><button type="submit">Save</button></form>`;
  const form = h.document.getElementById(kind); form.fields = data.fields;
  return { form, url: data.url };
}

test('all mutation forms suppress duplicate POSTs and allow retry after a current input or server error', async () => {
  for (const kind of ['feedback-form', 'dataset-form', 'dataset-item-form', 'config-form']) {
    const h = harness(); const { form, url } = await mutationForm(h, kind);
    for (const status of [400, 500]) {
      const result = deferred(); h.overrides[url] = () => result.promise;
      const before = h.calls.filter(call => call.url === url && call.options.method === 'POST').length;
      const pending = h.emit('submit', form);
      await h.emit('submit', form);
      assert.equal(form.submitButton.disabled, true, kind);
      assert.equal(h.calls.filter(call => call.url === url && call.options.method === 'POST').length, before + 1, kind);
      result.resolve(response({ error: 'Fixture request failed' }, status)); await pending;
      assert.equal(form.submitButton.disabled, false, `${kind}, status ${status}`);
      assert.equal(h.state.user.full_name, 'Fixture User');
      assert.equal(form.isConnected, true);
    }
  }
});

test('duplicate-suppressed mutation forms return to an enabled login form when their current request gets 401', async () => {
  for (const kind of ['feedback-form', 'dataset-form', 'dataset-item-form', 'config-form']) {
    const h = harness(); const { form, url } = await mutationForm(h, kind);
    const result = deferred(); h.overrides[url] = () => result.promise;
    const pending = h.emit('submit', form);
    await h.emit('submit', form);
    assert.equal(form.submitButton.disabled, true);
    assert.equal(h.calls.filter(call => call.url === url && call.options.method === 'POST').length, 1);
    result.resolve(response({ error: 'Session expired' }, 401)); await pending;
    assert.equal(h.state.user, null, kind);
    assert.equal(form.isConnected, false);
    assert.equal(h.document.getElementById('login-form').submitButton.disabled, false);
    assert.equal(h.root.innerHTML, '');
    assert.match(h.document.getElementById('login-screen').innerHTML, /Sesi berakhir/);
  }
});

test('internal datasets request 24 photos per page and show readable labels with private thumbnails', async () => {
  const h = harness(); await readyDataset(h);
  const dataset = { dataset_id: 4, name: 'Fixture dataset', version: '1', status: 'DRAFT', dataset_kind: 'HAZARD' };
  const item = index => ({ dataset_item_id: index, image_id: index + 100, original_name: `photo-${index}.jpg`, overall_label: 'RISK', split: 'TRAIN', label_status: 'DRAFT', annotations: [] });
  h.overrides['/api/datasets/4/items?offset=0&limit=24'] = () => response({ dataset, items: Array.from({ length: 24 }, (_, index) => item(index + 1)), total: 25, offset: 0, limit: 24 });
  h.overrides['/api/datasets/4/items?offset=24&limit=24'] = () => response({ dataset, items: [item(25)], total: 25, offset: 24, limit: 24 });
  await h.emit('click', h.target({ datasetItems: '4' }));
  assert.match(h.root.innerHTML, /Menampilkan 1–24 dari 25 foto/);
  assert.match(h.root.innerHTML, /\/api\/media\/101\/thumbnail/);
  assert.match(h.root.innerHTML, /Ada indikasi bahaya · Latih/);
  assert.match(h.root.innerHTML, /Belum ditinjau/);
  assert.equal(h.root.querySelectorAll('[data-dataset-thumbnail]').length, 24);
  const next = h.root.querySelectorAll('[data-dataset-page]').find(button => button.dataset.datasetPage === '24');
  await h.emit('click', next);
  assert.match(h.root.innerHTML, /Menampilkan 25–25 dari 25 foto/);
  assert.equal(h.root.querySelectorAll('[data-dataset-thumbnail]').length, 1);
  assert.equal(h.root.querySelectorAll('[data-dataset-page]').at(-1).disabled, true);
  assert.equal(h.state.datasetOffset, 24);
});

test('the internal dataset thumbnail falls back once for older local servers', async () => {
  const h = harness(); await readyDataset(h);
  h.overrides['/api/datasets/4/items?offset=0&limit=24'] = () => response({ dataset: { dataset_id: 4, name: 'Fixture', version: '1', status: 'DRAFT' }, items: [{ image_id: 9, original_name: 'fixture.png', annotations: [] }], total: 1, offset: 0, limit: 24 });
  await h.emit('click', h.target({ datasetItems: '4' }));
  const image = h.root.querySelector('[data-dataset-thumbnail]');
  image.dispatchEvent({ type: 'error' }); assert.equal(image.src, '/api/media/9');
  image.dispatchEvent({ type: 'error' }); assert.equal(image.alt, 'Foto belum tersedia');
  assert.equal(image.classList.contains('dataset-photo-unavailable'), true);
});

test('the performance page reads metrics without automatically running a benchmark or polling an idle server', { skip: !performanceSource }, async () => {
  const h = harness({ '/api/performance': () => response({ process: { rss_bytes: 128 * 1024 ** 2 }, system: { total_bytes: 8 * 1024 ** 3, available_bytes: 4 * 1024 ** 3 }, gpu: { available: false }, inference: { count: 2, last_ms: 1500, median_ms: 1800, p95_ms: 2400 }, active: { busy: false }, detector: { ready: false, reason: 'Model belum dipasang.' }, benchmark: { active: null, recent: [] } }) });
  await h.boot; await h.navigate('performance'); await tick();
  assert.match(h.root.querySelector('[data-perf-metrics]').innerHTML, /1,5 detik/);
  assert.match(h.root.querySelector('[data-perf-metrics]').innerHTML, /Memori GPU/);
  assert.match(h.root.querySelector('[data-perf-engine]').innerHTML, /Model belum dipasang/);
  assert.equal(h.calls.filter(call => call.options.method === 'POST' && call.url === '/api/performance/benchmark').length, 0);
  assert.equal(h.timers.size, 0);
});

test('late performance metrics cannot render over the page opened after them', { skip: !performanceSource }, async () => {
  const pending = deferred(); const h = harness({ '/api/performance': () => pending.promise });
  await h.boot; await h.navigate('performance'); await h.navigate('history');
  const html = h.root.innerHTML;
  pending.resolve(response({ system: {}, inference: {}, detector: {}, benchmark: {} })); await tick();
  assert.equal(h.root.innerHTML, html);
  assert.equal(h.state.view, 'history');
});

test('admin benchmark cancellation is explicit and duplicate clicks send one stop request', { skip: !performanceSource }, async () => {
  const stop = deferred(), jobId = '00000000-0000-0000-0000-000000000001';
  const job = { id: jobId, status: 'RUNNING', total: 2, completed: 0, results: [] };
  const h = harness({
    '/api/performance': () => response({ system: {}, inference: {}, detector: {}, active: { busy: true }, benchmark: { active: job, recent: [] } }),
    [`/api/performance/benchmark/${jobId}/cancel`]: () => stop.promise,
  });
  await h.boot; h.state.user.role = 'admin'; await h.navigate('performance'); await tick();
  const cancel = h.root.querySelector('[data-perf-cancel]'); assert.ok(cancel);
  h.root.listeners.get('click')({ target: cancel });
  h.root.listeners.get('click')({ target: cancel }); await tick();
  assert.equal(h.calls.filter(call => call.url.endsWith('/cancel')).length, 1);
  assert.equal(h.root.querySelector('[data-perf-cancel]').disabled, true);
  stop.resolve(response({ ...job, cancellation_requested: true })); await tick();
  await h.navigate('history');
  assert.equal(h.timers.size, 0);
});
