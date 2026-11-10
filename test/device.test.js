const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createDeviceService, DEFAULT_CONFIGURATION, validateAddress, validateConfiguration, verifyForm } = require('../lib/device');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(__dirname, 'fixtures/device-form.html'), 'utf8');
const configuration = {
  ...DEFAULT_CONFIGURATION, mode: 'timer', username: 'example-user', xUsername: 'example_user',
  apiUrl: 'http://192.168.20.1:3005/display?one=1&two=2', jsonKey: 'content',
  timerDuration: 12, restDuration: 7, loopCount: 3
};

async function temporaryDirectory(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'deskhub-device-test-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

// Also embedded in isolated server processes; this transport never opens a socket.
function mockTransport(scenario, record) {
  const { Writable, PassThrough } = require('node:stream');
  return (options, callback) => {
    let body = '';
    const request = new Writable({ write(chunk, encoding, done) { body += chunk; done(); } });
    request.on('finish', () => {
      record({ ...options, body });
      const reply = scenario(options.method);
      if (reply.hang) return;
      if (reply.error) return request.destroy(new Error('Sensitive upstream details must never escape'));
      const response = new PassThrough();
      response.statusCode = reply.status ?? 200;
      response.headers = reply.headers || {};
      callback(response);
      if (reply.aborted) return response.emit('aborted');
      response.end(reply.body || '');
    });
    return request;
  };
}

async function serviceFixture(t, replies = {}) {
  const directory = await temporaryDirectory(t);
  const calls = [];
  const request = mockTransport(method => replies[method] || { body: method === 'GET' ? html : 'acknowledged' }, call => calls.push(call));
  const file = path.join(directory, 'display.json');
  const service = createDeviceService(file, { request, timeoutMs: 30 });
  service.saveAddress({ address: '192.168.20.5' });
  return { service, calls, replies, file, directory, request };
}

test('device addresses are strict RFC1918 literals, including unlink', () => {
  for (const address of ['', '10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.20.5']) {
    assert.equal(validateAddress(address), address);
  }
  for (const address of [null, 123, '127.0.0.1', '169.254.1.1', '8.8.8.8', '172.15.0.1', '172.32.0.1',
    '192.169.0.1', '10.0.0.256', '010.0.0.1', '10.1', '0x0a000001', '167772161', '::1',
    '192.168.20.5:80', 'http://192.168.20.5', 'user@192.168.20.5', 'device.local', ' 10.0.0.1', '10.0.0.1\n']) {
    assert.throws(() => validateAddress(address), { code: 'device_address' });
  }
});

test('complete configuration validates types, inactive fields, ranges and mode-specific requirements', () => {
  assert.deepEqual(validateConfiguration(configuration), configuration);
  assert.equal(validateConfiguration({ ...configuration, mode: 'api', jsonKey: '' }).jsonKey, '');
  const bad = [null, {}, { ...configuration, extra: true }, { ...configuration, mode: 'text' },
    { ...configuration, scrollingText: 'on' }, { ...configuration, animationType: 'other' },
    { ...configuration, mode: 'github', username: '' }, { ...configuration, mode: 'xfollowers', xUsername: '' },
    { ...configuration, mode: 'api', apiUrl: '' }];
  for (const key of Object.keys(configuration)) {
    const missing = { ...configuration };
    delete missing[key];
    bad.push(missing);
  }
  for (const [key, values] of Object.entries({
    fetchRate: [999, 86400001, 1000.1, '60000', Infinity], timerDuration: [0, 241, 1.5],
    restDuration: [0, 241], loopCount: [0, 11], username: ['-user', 'a--b', 'a'.repeat(40), 'x\n'],
    xUsername: ['with-dash', 'x'.repeat(16)], jsonKey: ['x\0', 'x'.repeat(129), '{{content}}'],
    apiUrl: ['ftp://example.test', '/display', 'http://user:password@example.test/', 'http://@example.test/', 'http://example.test/#',
      'http://example.test/\n', 'http://example.test/' + 'x'.repeat(2048)]
  })) for (const value of values) bad.push({ ...configuration, [key]: value });
  for (const input of bad) assert.throws(() => validateConfiguration(input), { code: 'device_configuration' });
});

test('recognizer accepts the synthetic contract with quoting and ignores scripts/comments and WiFi form', () => {
  verifyForm(html);
  verifyForm(html.replaceAll('\'', '"'));
  verifyForm(html.replace('</form>', '<input name=\'wifiPassword\' type=\'password\'></form>'));
  verifyForm(html.replace('<section', '<!-- <input name=\'unknown\'> --><section'));
  verifyForm(`<template><template></template></template>${html}`);
});

test('recognizer fails closed on changed controls, options, form targets and disabled/duplicate fields', () => {
  const changes = [
    ['name=\'configForm\'', 'name=\'otherForm\''], ['action=\'/submit\'', 'action=\'/wifi\''],
    ['method=\'POST\' onsubmit', 'method=\'GET\' onsubmit'], ['name=\'username\'', 'name=\'unknown\''],
    ['name=\'username\'', 'name=\'username\' disabled'], ['name=\'username\'', 'name=\'username\' name=\'username\''],
    ['name=\'apiUrl\'', 'name=\'username\''], ['value=\'api\'', 'value=\'unknown\''],
    ['value=\'progress\'', 'value=\'unknown\''], ['type=\'checkbox\'', 'type=\'checkbox\' value=\'yes\''],
    ['name=\'mode\'', 'name=\'mode\' multiple'], ['value=\'timer\'', 'value=\'timer\' disabled'],
    ['<section', '<fieldset disabled><section'], ['</body>', '<input name=\'extra\' form=\'configForm\'></body>'],
    ['<input type=\'submit\' value=\'Send\'>', '<input type=\'hidden\' name=\'wifiPassword\'>'],
    ['name=\'restDuration\'', 'name=\'restDuration\' formaction=\'/wifi\''],
    ['<input name=\'xUsername\' type=\'text\'>', ''], ['</form>\n<script>', '\n<script>']
  ];
  for (const [from, to] of changes) {
    assert.throws(() => verifyForm(html.replace(from, to)), { code: 'device_incompatible' }, from);
  }
  for (const prefix of ['<script>', '<!--', '<fieldset disabled>']) {
    assert.throws(() => verifyForm(prefix + html.replace(/<!--[\s\S]*?-->/g, '')), { code: 'device_incompatible' });
  }
});

test('apply sends exactly the complete form, preserves inactive values and handles checkbox browser semantics', async t => {
  const { service, calls, file } = await serviceFixture(t);
  for (const scrollingText of [true, false]) {
    const input = { ...configuration, scrollingText };
    const saved = await service.apply({ configuration: input });
    assert.deepEqual(saved.configuration, input);
    assert.ok(Number.isFinite(Date.parse(saved.lastSentAt)));
    const [get, post] = calls.slice(-2);
    assert.equal(get.method, 'GET');
    assert.equal(get.path, '/');
    assert.equal(post.method, 'POST');
    assert.equal(post.path, '/submit');
    assert.equal(post.hostname, '192.168.20.5');
    assert.equal(post.port, 80);
    assert.equal(post.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(post.headers['Content-Length'], Buffer.byteLength(post.body));
    const expected = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'scrollingText').map(([key, value]) => [key, String(value)]));
    if (scrollingText) expected.scrollingText = 'on';
    assert.deepEqual(Object.fromEntries(new URLSearchParams(post.body)), expected);
    assert.deepEqual(createDeviceService(file).read(), saved);
  }
  const same = service.read();
  assert.deepEqual(service.saveAddress({ address: same.address }), same);
  assert.deepEqual(service.saveAddress({ address: '10.0.0.1' }), {
    address: '10.0.0.1', configuration: DEFAULT_CONFIGURATION, lastSentAt: null
  });
  assert.equal(service.saveAddress({ address: '' }).address, '');
  await assert.rejects(service.check(), { code: 'device_not_configured' });
});

test('invalid input causes zero traffic, and lock prevents overlapping operations then releases', async t => {
  const { service, calls, replies } = await serviceFixture(t);
  for (const input of [{}, { configuration: { ...configuration, wifiPassword: 'never-send' } }, { configuration: { ...configuration, fetchRate: 1 } }]) {
    await assert.rejects(service.apply(input), { code: 'device_configuration' });
  }
  assert.equal(calls.length, 0);
  replies.GET = { hang: true };
  const applying = service.apply({ configuration });
  await assert.rejects(service.apply({ configuration }), { code: 'device_busy' });
  await assert.rejects(service.check(), { code: 'device_busy' });
  assert.throws(() => service.saveAddress({ address: '10.0.0.1' }), { code: 'device_busy' });
  await assert.rejects(applying, { code: 'device_unreachable', status: 504 });
  delete replies.GET;
  assert.deepEqual(await service.check(), { compatible: true });
});

test('preflight rejects redirects, size overflow, timeout, aborted responses and incompatible forms without POST', async t => {
  const { service, calls, replies } = await serviceFixture(t);
  for (const [reply, code, status] of [
    [{ status: 302, headers: { location: '/submit' } }, 'device_incompatible', 502],
    [{ body: html.replace('name=\'apiUrl\'', 'name=\'password\'') }, 'device_incompatible', 502],
    [{ body: `<template>${html}</template>` }, 'device_incompatible', 502],
    [{ body: `<template><template></template>${html}</template>` }, 'device_incompatible', 502],
    [{ body: `<template><textarea></template></textarea>${html}</template>` }, 'device_incompatible', 502],
    [{ body: 'x'.repeat(256 * 1024 + 1) }, 'device_unreachable', 502],
    [{ headers: { 'content-length': 256 * 1024 + 1 } }, 'device_unreachable', 502],
    [{ hang: true }, 'device_unreachable', 504], [{ error: true }, 'device_unreachable', 502],
    [{ aborted: true }, 'device_unreachable', 502]
  ]) {
    replies.GET = reply;
    await assert.rejects(service.apply({ configuration }), { code, status });
  }
  assert.ok(calls.every(call => call.method === 'GET' && call.path === '/'));
  assert.equal(service.read().lastSentAt, null);
});

test('POST acknowledgements are narrow, failures are uncertain and never retried', async t => {
  const { service, calls, replies } = await serviceFixture(t);
  for (const status of [200, 204, 302, 303]) {
    replies.POST = { status, headers: { location: '/' } };
    await service.apply({ configuration });
  }
  const before = service.read();
  for (const [reply, status] of [
    [{ status: 302, headers: { location: 'http://192.168.20.5/' } }, 502],
    [{ status: 307, headers: { location: '/' } }, 502], [{ status: 500 }, 502],
    [{ error: true }, 502], [{ aborted: true }, 502], [{ hang: true }, 504],
    [{ body: 'x'.repeat(256 * 1024 + 1) }, 502]
  ]) {
    replies.POST = reply;
    const count = calls.length;
    await assert.rejects(service.apply({ configuration: { ...configuration, loopCount: 4 } }), { code: 'device_unconfirmed', status });
    assert.equal(calls.length - count, 2);
    assert.deepEqual(service.read(), before);
  }
});

test('failed local atomic writes preserve metadata and existing display data, including after acknowledgement', async t => {
  const { service, file, directory, calls } = await serviceFixture(t);
  const previous = service.read();
  const metadataFile = path.join(directory, 'device.json');
  const original = await fsp.readFile(metadataFile, 'utf8');
  await fsp.writeFile(file, '{"text":"Keep existing display"}');
  t.mock.method(fs, 'renameSync', () => { throw new Error('Sensitive filesystem details'); });
  assert.throws(() => service.saveAddress({ address: '10.0.0.1' }), { code: 'device_storage' });
  assert.deepEqual(service.read(), previous);
  assert.equal(calls.length, 0);
  await assert.rejects(service.apply({ configuration }), { code: 'device_unconfirmed' });
  assert.equal(calls.length, 2);
  assert.deepEqual(service.read(), previous);
  assert.equal(await fsp.readFile(metadataFile, 'utf8'), original);
  assert.equal(await fsp.readFile(file, 'utf8'), '{"text":"Keep existing display"}');
  assert.equal((await fsp.readdir(directory)).some(name => name.endsWith('.tmp')), false);
  assert.deepEqual(await service.check(), { compatible: true });
});

async function serverFixture(t) {
  const directory = await temporaryDirectory(t);
  const scenarioFile = path.join(directory, 'scenario.json');
  const callsFile = path.join(directory, 'calls.jsonl');
  const preload = path.join(directory, 'transport.cjs');
  const dataFile = path.join(directory, 'display.json');
  await fsp.writeFile(dataFile, '{"text":"Existing display"}');
  await fsp.writeFile(callsFile, '');
  await fsp.writeFile(scenarioFile, JSON.stringify({ GET: { body: html }, POST: { status: 303, headers: { location: '/' } } }));
  await fsp.writeFile(preload, `
    const fs = require('node:fs');
    require('node:http').request = (${mockTransport.toString()})(
      method => JSON.parse(fs.readFileSync(${JSON.stringify(scenarioFile)}, 'utf8'))[method],
      call => fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(call) + '\\n')
    );
    require('node:https').request = () => { throw new Error('Unexpected provider request'); };
  `);
  const children = [];
  t.after(async () => {
    for (const { child, exited } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
  });
  return {
    directory, dataFile,
    calls: async () => (await fsp.readFile(callsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    scenario: input => fsp.writeFile(scenarioFile, JSON.stringify(input)),
    async start() {
      const reservation = net.createServer();
      reservation.listen(0, '127.0.0.1');
      await once(reservation, 'listening');
      const port = reservation.address().port;
      await new Promise(resolve => reservation.close(resolve));
      const child = spawn(process.execPath, ['--require', preload, path.join(root, 'index.js')], {
        cwd: directory, env: { PATH: process.env.PATH, PORT: String(port), LOCALHOST: 'http://127.0.0.1', DATA_FILE: dataFile },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const exited = once(child, 'exit');
      children.push({ child, exited });
      const listening = Promise.withResolvers();
      let output = '';
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('Custom DeskHub Server Started')) listening.resolve();
      });
      child.stderr.on('data', chunk => { output += chunk; });
      await Promise.race([listening.promise, exited.then(() => { throw new Error(output); })]);
      const url = `http://127.0.0.1:${port}`;
      const { csrfToken } = await (await fetch(`${url}/api/settings`)).json();
      return {
        child, exited, output: () => output,
        request(endpoint, method = 'GET', body, token = csrfToken) {
          return fetch(`${url}${endpoint}`, {
            method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
          });
        }
      };
    }
  };
}

test('device routes enforce CSRF, keep health/local metadata offline and persist separately across restart', { timeout: 10000 }, async t => {
  const fixture = await serverFixture(t);
  let server = await fixture.start();
  const initial = await server.request('/api/device');
  assert.equal(initial.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await initial.json(), { device: { address: '', configuration: DEFAULT_CONFIGURATION, lastSentAt: null } });
  assert.equal((await server.request('/healthz')).status, 200);
  for (const [endpoint, method, body] of [
    ['/api/device', 'PUT', { address: '192.168.20.5' }],
    ['/api/device/check', 'POST', {}], ['/api/device/apply', 'POST', { configuration }]
  ]) for (const token of ['', 'invalid']) assert.equal((await server.request(endpoint, method, body, token)).status, 403);
  assert.equal((await server.request('/api/device', 'PUT', { address: '127.0.0.1' })).status, 400);
  const unconfigured = await server.request('/api/device/check', 'POST');
  assert.equal(unconfigured.status, 409);
  assert.equal((await unconfigured.json()).code, 'device_not_configured');
  assert.equal((await server.request('/api/device', 'PUT', { address: '192.168.20.5' })).status, 200);
  const invalid = await server.request('/api/device/apply', 'POST', { configuration: { ...configuration, mode: 'unknown' } });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, 'device_configuration');
  assert.equal((await fixture.calls()).length, 0);
  assert.deepEqual(await (await server.request('/api/device/check', 'POST')).json(), { compatible: true });
  assert.equal((await (await server.request('/api/device')).json()).device.lastSentAt, null);
  const applied = await server.request('/api/device/apply', 'POST', { configuration });
  assert.equal(applied.status, 200);
  const saved = await applied.json();
  assert.deepEqual(saved.device.configuration, configuration);
  assert.equal((await fixture.calls()).length, 3);
  assert.equal(await fsp.readFile(fixture.dataFile, 'utf8'), '{"text":"Existing display"}');
  server.child.kill();
  await server.exited;
  server = await fixture.start();
  assert.deepEqual(await (await server.request('/api/device')).json(), saved);
  assert.equal((await fixture.calls()).length, 3);

  await fixture.scenario({ GET: { error: true } });
  const failed = await server.request('/api/device/check', 'POST');
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).code, 'device_unreachable');
  const count = (await fixture.calls()).length;
  assert.equal((await server.request('/healthz')).status, 200);
  assert.deepEqual(await (await server.request('/api/device')).json(), saved);
  assert.equal((await fixture.calls()).length, count);
  assert.doesNotMatch(server.output(), /192\.168\.20\.5|Sensitive upstream/);
});

test('routes report uncertain POST/local persistence outcomes without replacing metadata', { timeout: 10000 }, async t => {
  const fixture = await serverFixture(t);
  const server = await fixture.start();
  await server.request('/api/device', 'PUT', { address: '192.168.20.5' });
  const before = await (await server.request('/api/device')).json();
  await fixture.scenario({ GET: { body: html }, POST: { error: true } });
  const uncertain = await server.request('/api/device/apply', 'POST', { configuration });
  assert.equal(uncertain.status, 502);
  assert.equal((await uncertain.json()).code, 'device_unconfirmed');
  assert.equal((await fixture.calls()).length, 2);
  await fixture.scenario({ GET: { body: html }, POST: { status: 200 } });
  const file = path.join(fixture.directory, 'device.json');
  await fsp.rename(file, `${file}.backup`);
  await fsp.mkdir(file);
  const address = await server.request('/api/device', 'PUT', { address: '10.0.0.1' });
  assert.equal(address.status, 500);
  assert.equal((await address.json()).code, 'device_storage');
  const persistence = await server.request('/api/device/apply', 'POST', { configuration });
  assert.equal(persistence.status, 502);
  assert.equal((await persistence.json()).code, 'device_unconfirmed');
  assert.deepEqual(await (await server.request('/api/device')).json(), before);
  assert.equal((await fixture.calls()).length, 4);
  assert.doesNotMatch(server.output(), /192\.168\.20\.5|Sensitive upstream|example-user/);
});
