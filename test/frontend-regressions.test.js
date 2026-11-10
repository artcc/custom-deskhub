const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { DEFAULT_CONFIGURATION } = require('../lib/device');
const { validateSettings } = require('../lib/settings');

const root = path.resolve(__dirname, '..');
const firefox = [process.env.FIREFOX_BIN, '/Applications/Firefox.app/Contents/MacOS/firefox', '/usr/bin/firefox']
  .find(file => file && fs.existsSync(file));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// A real browser checks native validation, disabled fieldsets and focus. Every API is local and synthetic.
test('frontend persistence and validation regressions in Firefox', {
  skip: firefox ? false : 'Set FIREFOX_BIN to an installed Firefox executable to run browser regressions.',
  timeout: 120000
}, async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'deskhub-frontend-'));
  const state = {
    settings: validateSettings({ mode: 'text', text: 'Original', github: { username: '' }, weather: { city: '', units: 'metric' } }),
    device: { address: '192.168.1.50', configuration: { ...DEFAULT_CONFIGURATION, mode: 'timer' }, lastSentAt: null },
    failSettingsRead: false, failSettingsWrite: false, failDeviceRead: false, failAddressWrite: false, applyError: null,
    calls: []
  };
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const json = (data, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(data));
    };
    try {
      if (pathname.startsWith('/api/')) {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
        state.calls.push({ pathname, method: request.method, body, address: state.device.address });
        if (pathname === '/api/settings') {
          if (request.method === 'PUT') {
            if (state.failSettingsWrite) return json({}, 500);
            state.settings = validateSettings(body);
          }
          else if (state.failSettingsRead) return json({}, 503);
          return json({ settings: state.settings, capabilities: { github: false, weather: false }, csrfToken: 'synthetic-csrf' });
        }
        if (pathname === '/api/display') return json({ content: state.settings.text, mode: 'text', skippedSources: [] });
        if (pathname === '/api/preview') {
          const settings = validateSettings(body, { preview: true });
          return json({ content: settings.text });
        }
        if (pathname === '/api/device') {
          if (request.method === 'PUT') {
            if (state.failAddressWrite) return json({ code: 'device_storage' }, 500);
            if (body.address !== state.device.address) {
              state.device.configuration = { ...DEFAULT_CONFIGURATION };
              state.device.lastSentAt = null;
            }
            state.device.address = body.address;
          } else if (state.failDeviceRead) return json({}, 503);
          return json({ device: state.device });
        }
        if (pathname === '/api/device/check') return json({ compatible: true });
        if (pathname === '/api/device/apply') {
          if (state.applyError) return json({ code: state.applyError }, 502);
          state.device.configuration = body.configuration;
          state.device.lastSentAt = new Date().toISOString();
          return json({ device: state.device });
        }
        return json({}, 404);
      }
      const file = pathname.startsWith('/locale/') ? path.join(root, pathname)
        : path.join(root, 'public', pathname === '/' ? 'index.html' : pathname.replace(/^\/assets\//, ''));
      if (!file.startsWith(`${root}${path.sep}`)) return json({}, 404);
      const content = await fsp.readFile(file);
      response.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream' });
      response.end(content);
    } catch {
      json({}, 400);
    }
  });
  let browser;
  let browserExit;
  let socket;
  t.after(async () => {
    socket?.close();
    if (browser && browser.exitCode === null) browser.kill();
    if (browserExit) await browserExit;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fsp.rm(directory, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  await fsp.writeFile(path.join(directory, 'user.js'), 'user_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("intl.accept_languages", "en-US,en");\n');
  browser = spawn(firefox, ['--headless', '--no-remote', '--profile', directory, '--remote-debugging-port', String(port), 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  browserExit = once(browser, 'exit');
  let output = '';
  browser.stdout.on('data', chunk => { output += chunk; });
  browser.stderr.on('data', chunk => { output += chunk; });
  for (let attempt = 0; attempt < 100 && !output.includes('WebDriver BiDi listening'); attempt++) {
    assert.equal(browser.exitCode, null, 'Firefox exited during startup');
    await delay(100);
  }
  assert.ok(output.includes('WebDriver BiDi listening'), 'Firefox BiDi did not start');
  socket = new WebSocket(`ws://127.0.0.1:${port}/session`);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  const browserErrors = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'log.entryAdded' && message.params.level === 'error') browserErrors.push(message.params.text);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.type === 'error') entry.reject(new Error(message.message));
    else entry.resolve(message.result);
  };
  function command(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`BiDi timeout: ${method}`)); }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  await command('session.new', { capabilities: {} });
  await command('session.subscribe', { events: ['log.entryAdded'] });
  const { context } = await command('browsingContext.create', { type: 'tab' });
  async function evaluate(expression) {
    const result = await command('script.evaluate', { expression, target: { context }, awaitPromise: true });
    assert.equal(result.type, 'success', JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function waitFor(expression) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return;
      await delay(50);
    }
    const status = await evaluate('Array.from(document.querySelectorAll(".message"), element => element.textContent).join(" | ")');
    assert.fail(`UI condition timed out: ${expression}; ${status}; ${browserErrors.join(' | ')}`);
  }
  const element = id => `document.getElementById(${JSON.stringify(id)})`;
  const value = (id, property = 'value') => evaluate(`${element(id)}.${property}`);
  const click = id => evaluate(`${element(id)}.click()`);
  const edit = (id, text) => evaluate(`${element(id)}.value = ${JSON.stringify(text)}; ${element(id)}.dispatchEvent(new Event('input', { bubbles: true }))`);
  const textSource = () => evaluate('document.querySelector("input[name=mode][value=text]").click()');
  const writes = pathname => state.calls.filter(call => call.pathname === pathname && call.method === 'PUT').length;
  const idle = () => waitFor(`${element('settings-form')}.getAttribute('aria-busy') === 'false'`);
  const deviceIdle = () => waitFor(`${element('device-settings-form')}.getAttribute('aria-busy') === 'false'`);
  async function open(tab = 'display') {
    await command('browsingContext.navigate', { context, url: `${url}/?case=${sequence}#${tab}`, wait: 'complete' });
    await waitFor(`!${element('editor-fields')}.disabled && !${element('device-address-fields')}.disabled`);
    state.calls.length = 0;
  }
  async function loseNextWrite(pathname) {
    // The server completes the write, but the UI receives a transport failure instead of its acknowledgement.
    await evaluate(`{
      const original = window.fetch;
      window.fetch = async (url, options) => {
        const response = await original(url, options);
        if (url === ${JSON.stringify(pathname)} && options?.method === 'PUT') {
          window.fetch = original;
          await response.text();
          throw new TypeError('Synthetic lost acknowledgement');
        }
        return response;
      };
    }`);
  }

  await t.test('hidden invalid fields are selected and focused without credentials; inactive required fields stay optional', async () => {
    await open();
    assert.equal(await value('mode-commits', 'disabled'), false);
    assert.equal(await value('mode-weather', 'disabled'), false);
    for (const [id, mode, invalid, valid, action] of [
      ['github-template', 'commits', '{{unknown}}', '{{commits}}', 'save-button'],
      ['weather-template', 'weather', '{{unknown}}', '{{temperature}} {{unit}}', 'preview-button'],
      ['github-username', 'commits', 'bad--name', '', 'save-button'],
      ['weather-city', 'weather', 'Bad\u007fCity', '', 'preview-button']
    ]) {
      await click(`mode-${mode}`);
      assert.equal(await value('save-button', 'disabled'), true);
      assert.equal(await value('preview-button', 'disabled'), true);
      await edit(id, invalid);
      await textSource();
      await edit('display-text', 'Valid text draft');
      await click(action);
      assert.equal(await evaluate('document.activeElement.id'), id);
      assert.equal(await value(`fields-${mode}`, 'hidden'), false);
      assert.equal(writes('/api/settings'), 0);
      assert.equal(state.calls.filter(call => call.pathname === '/api/preview').length, 0);
      assert.equal(await value('display-text'), 'Valid text draft');
      await edit(id, valid);
      await textSource();
    }
    await click('preview-button');
    await waitFor(`${element('preview-content')}.textContent === 'Valid text draft'`);
    await click('save-button');
    await idle();
    assert.equal(state.settings.github.username, '');
    assert.equal(state.settings.weather.city, '');
    assert.equal(state.settings.text, 'Valid text draft');
  });

  await t.test('lost settings acknowledgement reconciles storage, preserves drafts and allows restoring old values', async () => {
    await open();
    const oldText = state.settings.text;
    await edit('display-text', 'Persisted without acknowledgement');
    await edit('github-template', '{{content}}');
    await loseNextWrite('/api/settings');
    await click('save-button');
    await idle();
    assert.equal(state.settings.text, 'Persisted without acknowledgement');
    assert.equal(state.settings.github.template, '{{commits}}');
    assert.equal(await value('github-template'), '{{content}}');
    assert.equal(await value('display-text'), 'Persisted without acknowledgement');
    assert.equal(await value('save-state', 'textContent'), 'Unsaved changes');
    await edit('github-template', '{{commits}}');
    assert.equal(await value('save-state', 'textContent'), 'All changes saved');
    await edit('display-text', oldText);
    assert.equal(await value('save-button', 'disabled'), false);
    await click('save-button');
    await idle();
    assert.equal(state.settings.text, oldText);
  });

  await t.test('failed settings reconciliation stays unknown and retry never replaces the edited draft', async () => {
    await open();
    const oldText = state.settings.text;
    state.failSettingsRead = true;
    await edit('display-text', 'Another persisted value');
    await loseNextWrite('/api/settings');
    await click('save-button');
    await idle();
    await edit('display-text', oldText);
    assert.equal(await value('save-state', 'textContent'), 'Unconfirmed');
    assert.equal(await value('save-button', 'disabled'), false);
    assert.equal(await value('retry-load', 'hidden'), false);
    state.failSettingsRead = false;
    await click('retry-load');
    await idle();
    assert.equal(await value('display-text'), oldText);
    assert.equal(await value('save-state', 'textContent'), 'Unsaved changes');
    await click('save-button');
    await idle();
    assert.equal(state.settings.text, oldText);
  });

  await t.test('confirmed write failures remain visible after successful reconciliation', async () => {
    await open();
    const oldText = state.settings.text;
    state.failSettingsWrite = true;
    await edit('display-text', 'Rejected settings draft');
    await click('save-button');
    await idle();
    assert.equal(state.settings.text, oldText);
    assert.equal(await value('display-text'), 'Rejected settings draft');
    assert.match(await value('editor-status', 'textContent'), /500/);
    assert.equal(await evaluate(`${element('editor-status')}.classList.contains('error')`), true);
    assert.equal(await value('save-button', 'disabled'), false);
    state.failSettingsWrite = false;

    await open('device');
    const oldAddress = state.device.address;
    state.failAddressWrite = true;
    await edit('device-address', '192.168.1.99');
    await click('device-save-address');
    await deviceIdle();
    assert.equal(state.device.address, oldAddress);
    assert.equal(await value('device-address'), '192.168.1.99');
    assert.match(await value('device-connection-status', 'textContent'), /IP could not be saved/);
    assert.equal(await evaluate(`${element('device-connection-status')}.classList.contains('error')`), true);
    assert.equal(await value('device-apply', 'disabled'), true);
    state.failAddressWrite = false;
  });

  await t.test('lost address writes reconcile the actual target and block stale or unconfirmed addresses without losing drafts', async () => {
    await open('device');
    await edit('device-work-duration', '42');
    await edit('device-address', '192.168.1.51');
    await loseNextWrite('/api/device');
    await click('device-save-address');
    await deviceIdle();
    assert.equal(state.device.address, '192.168.1.51');
    assert.equal(await value('device-address'), '192.168.1.51');
    assert.equal(await value('device-work-duration'), '42');
    await edit('device-address', '192.168.1.50');
    assert.equal(await value('device-check', 'disabled'), true);
    assert.equal(await value('device-apply', 'disabled'), true);
    assert.equal(await value('device-save-address', 'disabled'), false);
    state.failDeviceRead = true;
    await edit('device-address', '192.168.1.52');
    await loseNextWrite('/api/device');
    await click('device-save-address');
    await deviceIdle();
    await edit('device-address', '192.168.1.51');
    assert.equal(await value('save-state', 'textContent'), 'Unconfirmed');
    assert.equal(await value('device-check', 'disabled'), true);
    assert.equal(await value('device-apply', 'disabled'), true);
    await evaluate(`${element('device-settings-form')}.dispatchEvent(new Event('submit', { cancelable: true }))`);
    assert.equal(state.calls.filter(call => call.pathname === '/api/device/apply').length, 0);
    state.failDeviceRead = false;
    await click('device-retry');
    await deviceIdle();
    assert.equal(await value('device-address'), '192.168.1.51');
    assert.equal(await value('device-work-duration'), '42');
    assert.equal(await value('device-apply', 'disabled'), true);
    await edit('device-address', '192.168.1.52');
    await click('device-apply');
    await deviceIdle();
    assert.equal(state.calls.find(call => call.pathname === '/api/device/apply').address, '192.168.1.52');
    assert.equal(state.device.configuration.timerDuration, 42);
  });

  await t.test('hardware uncertainty survives unreachable checks, metadata reads and same-IP retries', async () => {
    await open('device');
    state.applyError = 'device_unconfirmed';
    await click('device-apply');
    await deviceIdle();
    assert.equal(await value('save-state', 'textContent'), 'Unconfirmed');
    state.applyError = 'device_unreachable';
    await click('device-apply');
    await deviceIdle();
    assert.equal(await value('save-state', 'textContent'), 'Unconfirmed');
    assert.match(await value('device-apply-status', 'textContent'), /may have applied/);
    await click('device-check');
    await deviceIdle();
    assert.equal(await value('save-state', 'textContent'), 'Unconfirmed');
    const sameAddress = state.device.address;
    state.failAddressWrite = state.failDeviceRead = true;
    await edit('device-address', '192.168.1.53');
    await click('device-save-address');
    await deviceIdle();
    await edit('device-address', sameAddress);
    state.failAddressWrite = state.failDeviceRead = false;
    await click('device-save-address');
    await deviceIdle();
    assert.equal(await value('save-state', 'textContent'), 'Unconfirmed');
    assert.equal(state.device.address, sameAddress);
    state.applyError = null;
    await click('device-apply');
    await deviceIdle();
    assert.equal(await value('save-state', 'textContent'), 'Configuration sent');
    state.applyError = 'device_unconfirmed';
    await click('device-apply');
    await deviceIdle();
    await edit('device-address', '192.168.1.53');
    await loseNextWrite('/api/device');
    await click('device-save-address');
    await deviceIdle();
    assert.equal(await value('save-state', 'textContent'), 'Unsaved changes');
    assert.equal(await value('device-apply-status', 'textContent'), '');
  });
});
