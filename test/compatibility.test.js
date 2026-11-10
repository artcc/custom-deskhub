const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createCredentialStore } = require('../lib/credentials');
const { loadSettings, saveSettings } = require('../lib/settings');
const { DEFAULT_CONFIGURATION } = require('../lib/device');

const root = path.resolve(__dirname, '..');

async function csrfHeaders(url) {
  const response = await fetch(`${url}/api/settings`);
  assert.equal(response.status, 200);
  const { csrfToken } = await response.json();
  return { 'X-CSRF-Token': csrfToken };
}

async function createFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-deskhub-test-'));
  const processes = [];
  t.after(async () => {
    for (const { child, exited } of processes) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  await fs.copyFile(path.join(root, 'index.js'), path.join(directory, 'index.js'));
  await fs.cp(path.join(root, 'lib'), path.join(directory, 'lib'), { recursive: true });
  await fs.cp(path.join(root, 'public'), path.join(directory, 'public'), { recursive: true });
  await fs.cp(path.join(root, 'locale'), path.join(directory, 'locale'), { recursive: true });
  await fs.symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'junction');

  return {
    directory,
    start(env = {}, nodeArgs = []) {
      const child = spawn(process.execPath, ['--env-file-if-exists=.env', ...nodeArgs, 'index.js'], {
        cwd: directory,
        env: { PATH: process.env.PATH, ...env },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const exited = once(child, 'exit');
      const listening = Promise.withResolvers();
      let output = '';
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('Custom DeskHub Server Started')) listening.resolve();
      });
      child.stderr.on('data', chunk => { output += chunk; });
      processes.push({ child, exited });
      return {
        child,
        exited,
        output: () => output,
        ready: () => Promise.race([
          listening.promise,
          exited.then(([code]) => { throw new Error(`Server exited with ${code}: ${output}`); })
        ])
      };
    }
  };
}

async function reservePort() {
  const server = net.createServer();
  server.listen(0, '0.0.0.0');
  await once(server, 'listening');
  return server;
}

async function startConfigured(fixture, env = {}, nodeArgs = []) {
  const dataFile = env.DATA_FILE || path.join(fixture.directory, 'data.json');
  const store = createCredentialStore(dataFile);
  const existing = store.load();
  if (!existing.githubToken && !existing.weatherKey && (env.GITHUB_TOKEN !== '' || env.OPENWEATHER_API_KEY)) {
    store.save({ githubToken: env.GITHUB_TOKEN ?? 'test-only-not-a-real-token', weatherKey: env.OPENWEATHER_API_KEY || '' });
  }
  try {
    await fs.access(dataFile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    saveSettings(dataFile, {
      mode: 'text', text: '',
      github: { username: env.GITHUB_USERNAME ?? 'example', showRepositories: true },
      weather: { city: env.OPENWEATHER_CITY || '', units: 'metric' }
    });
  }
  const reservation = await reservePort();
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const server = fixture.start({
    GITHUB_TOKEN: 'test-only-not-a-real-token',
    GITHUB_USERNAME: 'example',
    PORT: String(port),
    LOCALHOST: 'http://127.0.0.1',
    ...env
  }, nodeArgs);
  await server.ready();
  return { ...server, url: `http://127.0.0.1:${port}` };
}

test('Express 5 preserves display responses, persistence and CORS', { timeout: 10000 }, async t => {
  const fixture = await createFixture(t);
  const reservation = await reservePort();
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  await fs.writeFile(path.join(fixture.directory, '.env'), [
    'GITHUB_TOKEN=test-only-not-a-real-token',
    'GITHUB_USERNAME=example',
    'PORT=1',
    'LOCALHOST=http://127.0.0.1'
  ].join('\n'));

  // PORT from the process must override the value loaded from .env.
  const server = fixture.start({ PORT: String(port) });
  await server.ready();
  const url = `http://127.0.0.1:${port}`;

  const initial = await fetch(`${url}/display`);
  assert.equal(initial.status, 200);
  assert.match(initial.headers.get('content-type'), /^application\/json/);
  assert.equal(initial.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await initial.json(), { content: '' });

  const missing = await fetch(`${url}/setDisplay`, { headers: await csrfHeaders(url) });
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: 'Missing required parameter: text' });

  const text = 'DeskHub + 100% & ready?';
  const updated = await fetch(`${url}/setDisplay?${new URLSearchParams({ text })}`, { headers: await csrfHeaders(url) });
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), { content: text });
  assert.deepEqual(await (await fetch(`${url}/display`)).json(), { content: text });
  assert.equal(JSON.parse(await fs.readFile(path.join(fixture.directory, 'data.json'), 'utf8')).text, text);

  const preflight = await fetch(`${url}/setDisplay`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost', 'Access-Control-Request-Method': 'GET' }
  });
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);

  const weather = await fetch(`${url}/weather`);
  assert.equal(weather.status, 503);
  assert.equal((await weather.json()).error, 'Weather service not configured');
  assert.equal((await fetch(`${url}/missing`)).status, 404);

  server.child.kill();
  await server.exited;
  const restarted = fixture.start({ PORT: String(port) });
  await restarted.ready();
  assert.deepEqual(await (await fetch(`${url}/display`)).json(), { content: text });
});

test('missing configuration still prevents startup', { timeout: 10000 }, async t => {
  const fixture = await createFixture(t);
  const server = fixture.start();
  const [code] = await server.exited;
  assert.equal(code, 1);
  assert.match(server.output(), /Missing required environment variables/);
  assert.doesNotMatch(server.output(), /Custom DeskHub Server Started/);
});

test('Express 5 reports a busy port as startup failure', { timeout: 10000 }, async t => {
  const fixture = await createFixture(t);
  const occupied = await reservePort();
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const server = fixture.start({
    GITHUB_TOKEN: 'test-only-not-a-real-token',
    GITHUB_USERNAME: 'example',
    PORT: String(occupied.address().port),
    LOCALHOST: 'http://127.0.0.1'
  });
  const [code] = await server.exited;
  assert.equal(code, 1);
  assert.match(server.output(), /EADDRINUSE/);
  assert.doesNotMatch(server.output(), /Custom DeskHub Server Started/);
});

test('custom storage survives starting a fresh application directory', { timeout: 10000 }, async t => {
  const original = await createFixture(t);
  const replacement = await createFixture(t);
  const dataFile = path.join(original.directory, 'persistent-volume', 'data.json');
  const server = await startConfigured(original, { DATA_FILE: dataFile });
  const text = 'Keep this after recreating the container';
  const response = await fetch(`${server.url}/setDisplay?${new URLSearchParams({ text })}`, { headers: await csrfHeaders(server.url) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { content: text });
  assert.equal(JSON.parse(await fs.readFile(dataFile, 'utf8')).text, text);
  await assert.rejects(fs.access(path.join(original.directory, 'data.json')), { code: 'ENOENT' });

  server.child.kill();
  await server.exited;
  const recreated = await startConfigured(replacement, { DATA_FILE: dataFile });
  assert.deepEqual(await (await fetch(`${recreated.url}/display`)).json(), { content: text });

  const cleared = await fetch(`${recreated.url}/setDisplay?text=`, { headers: await csrfHeaders(recreated.url) });
  assert.equal(cleared.status, 200);
  assert.deepEqual(await cleared.json(), { content: '' });
  assert.equal(JSON.parse(await fs.readFile(dataFile, 'utf8')).text, '');
});

test('failed persistence returns an error without updating display text', { timeout: 10000 }, async t => {
  const fixture = await createFixture(t);
  const blocked = path.join(fixture.directory, 'not-a-directory');
  const server = await startConfigured(fixture, { DATA_FILE: path.join(blocked, 'data.json') });
  await fs.rename(blocked, `${blocked}-old`);
  await fs.writeFile(blocked, 'existing file');
  const response = await fetch(`${server.url}/setDisplay?text=Must-not-be-accepted`, { headers: await csrfHeaders(server.url) });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Failed to save display text' });
  assert.deepEqual(await (await fetch(`${server.url}/display`)).json(), { content: '' });
  assert.equal(await fs.readFile(blocked, 'utf8'), 'existing file');
});

const commitScenarios = [
  {
    name: 'sums commitCount across records and repositories',
    total: 10,
    repositories: [
      { repository: { name: 'alpha' }, contributions: { nodes: [{ commitCount: 2 }, { commitCount: 5 }] } },
      { repository: { name: 'beta' }, contributions: { nodes: [{ commitCount: 3 }] } }
    ],
    template: '{{commits}} | {{repositories}}',
    content: '10 | alpha: 7, beta: 3'
  },
  {
    name: 'renders one commit as a bare count',
    total: 1,
    repositories: [
      { repository: { name: 'alpha' }, contributions: { nodes: [{ commitCount: 1 }] } }
    ],
    content: '1'
  },
  { name: 'renders zero commits as a bare count', total: 0, repositories: [], content: '0' }
];

for (const scenario of commitScenarios) {
  test(`/commits ${scenario.name}`, { timeout: 10000 }, async t => {
    const fixture = await createFixture(t);
    const response = {
      data: {
        user: {
          contributionsCollection: {
            totalCommitContributions: scenario.total,
            commitContributionsByRepository: scenario.repositories
          }
        }
      }
    };
    const preload = path.join(fixture.directory, 'mock-github.cjs');
    // Intercept the HTTPS transport in the child; no requests reach GitHub.
    await fs.writeFile(preload, `
      const { Writable, PassThrough } = require('node:stream');
      const https = require('node:https');
      https.request = (options, callback) => {
        if (options.hostname !== 'api.github.com' || options.path !== '/graphql') {
          throw new Error('Unexpected upstream request');
        }
        const request = new Writable({ write(chunk, encoding, done) { done(); } });
        request.on('finish', () => {
          const response = new PassThrough();
          response.statusCode = 200;
          callback(response);
          response.end(${JSON.stringify(JSON.stringify(response))});
        });
        return request;
      };
    `);
    const server = await startConfigured(fixture, {}, ['--require', preload]);
    if (scenario.template) {
      const { settings } = await getSettings(server.url);
      assert.equal((await panelRequest(server.url, '/api/settings', {
        ...settings, github: { ...settings.github, template: scenario.template }
      })).status, 200);
    }
    const result = await fetch(`${server.url}/commits`);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { content: scenario.content });
  });
}

async function getSettings(url) {
  const response = await fetch(`${url}/api/settings`);
  assert.equal(response.status, 200);
  return response.json();
}

async function panelRequest(url, endpoint, settings, method = 'PUT') {
  return fetch(`${url}${endpoint}`, {
    method,
    headers: { ...await csrfHeaders(url), 'Content-Type': 'application/json' },
    body: JSON.stringify(settings)
  });
}

async function mockProviders(fixture) {
  const preload = path.join(fixture.directory, 'providers.cjs');
  const calls = path.join(fixture.directory, 'provider-calls.jsonl');
  await fs.writeFile(preload, `
    const { Writable, PassThrough } = require('node:stream');
    const fs = require('node:fs');
    require('node:https').request = (options, callback) => {
      let body = '';
      const request = new Writable({ write(chunk, encoding, done) { body += chunk; done(); } });
      request.on('finish', () => {
        let data, call;
        let status = 200;
        if (options.hostname === 'api.github.com') {
          const { variables } = JSON.parse(body);
          call = { provider: 'github', username: variables.username, from: variables.from };
          if (variables.username === 'fail-user') status = 401;
          data = { data: { user: { contributionsCollection: {
            totalCommitContributions: 7,
            commitContributionsByRepository: [{ repository: { name: variables.username }, contributions: { nodes: [{ commitCount: 2 }, { commitCount: 5 }] } }]
          } } } };
        } else if (options.hostname === 'api.openweathermap.org') {
          const query = new URL(options.path, 'https://api.openweathermap.org').searchParams;
          call = { provider: 'weather', city: query.get('q'), units: query.get('units') };
          if (call.city === 'Broken') status = 404;
          data = { cod: status, name: call.city, main: { temp: call.units === 'imperial' ? 77 : 25 }, weather: [{ id: 800, description: 'clear sky' }] };
        } else {
          throw new Error('Unexpected provider');
        }
        fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(call) + '\\n');
        const response = new PassThrough();
        response.statusCode = status;
        callback(response);
        response.end(JSON.stringify(data));
      });
      return request;
    };
  `);
  return { args: ['--require', preload], calls };
}

test('panel opens without login and CSRF protects every settings write', { timeout: 10000 }, async t => {
  const fixture = await createFixture(t);
  const server = await startConfigured(fixture);
  for (const endpoint of ['/', '/assets/app.js', '/api/settings']) {
    const response = await fetch(`${server.url}${endpoint}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('www-authenticate'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  const { settings, csrfToken } = await getSettings(server.url);
  assert.ok(csrfToken);
  for (const endpoint of ['/api/settings', '/api/preview', '/api/credentials']) {
    for (const token of ['', 'invalid-token']) {
      const response = await fetch(`${server.url}${endpoint}`, {
        method: endpoint.endsWith('preview') ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example', 'X-CSRF-Token': token },
        body: JSON.stringify({ ...settings, text: 'forged' })
      });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
  }
  assert.equal((await fetch(`${server.url}/setDisplay?text=forged`)).status, 403);
  assert.deepEqual(await (await fetch(`${server.url}/display`)).json(), { content: '' });

  const page = await fetch(server.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /<html/);
  for (const asset of ['app.js', 'i18n.js', 'styles.css']) {
    assert.equal((await fetch(`${server.url}/assets/${asset}`)).status, 200);
  }
  for (const language of ['en', 'es']) {
    const response = await fetch(`${server.url}/locale/${language}.json`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await response.json(), JSON.parse(await fs.readFile(path.join(root, 'locale', `${language}.json`), 'utf8')));
  }
});

test('panel and text mode work without any configured credentials', { timeout: 10000 }, async t => {
  const fixture = await createFixture(t);
  const server = await startConfigured(fixture, { GITHUB_TOKEN: '', GITHUB_USERNAME: '' });
  assert.equal((await fetch(`${server.url}/`)).status, 200);
  const { settings, capabilities } = await getSettings(server.url);
  assert.deepEqual(capabilities, { github: false, weather: false });
  const text = 'Today: {{content}} commits; {{city}}';
  assert.equal((await panelRequest(server.url, '/api/settings', { ...settings, text })).status, 200);
  assert.deepEqual(await (await fetch(`${server.url}/display`)).json(), { content: text });
  assert.equal((await fetch(`${server.url}/display`)).status, 200);
  assert.equal((await fetch(`${server.url}/healthz`)).status, 200);
});

test('legacy text migrates and previews never change persisted or active content', { timeout: 10000 }, async t => {
  const fixture = await createFixture(t);
  const dataFile = path.join(fixture.directory, 'data.json');
  const legacy = JSON.stringify({ text: 'Legacy text' });
  await fs.writeFile(dataFile, legacy);
  const server = await startConfigured(fixture);
  const { settings } = await getSettings(server.url);
  assert.equal(settings.mode, 'text');
  assert.equal(settings.text, 'Legacy text');
  assert.equal(settings.github.template, '{{commits}}');
  assert.equal(settings.weather.template, '{{temperature}} {{unit}}');
  const draft = { ...settings, text: 'Café\n25°C ☀' };
  const preview = await panelRequest(server.url, '/api/preview', draft, 'POST');
  assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), { content: 'Cafe 25C ', mode: 'text' });
  assert.equal(await fs.readFile(dataFile, 'utf8'), legacy);
  assert.deepEqual(await (await fetch(`${server.url}/display`)).json(), { content: 'Legacy text' });
  const saved = await panelRequest(server.url, '/api/settings', draft);
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).settings, draft);
  assert.deepEqual(await (await fetch(`${server.url}/display`)).json(), { content: 'Cafe 25C ' });
  server.child.kill();
  await server.exited;
  const restarted = await startConfigured(fixture);
  assert.deepEqual((await getSettings(restarted.url)).settings, draft);
});

test('invalid configuration and missing providers preserve the active selection', { timeout: 10000 }, async t => {
  const fixture = await createFixture(t);
  const server = await startConfigured(fixture, { GITHUB_TOKEN: '' });
  const { settings, capabilities } = await getSettings(server.url);
  assert.deepEqual(capabilities, { github: false, weather: false });
  const invalid = [
    null,
    { ...settings, mode: 'unknown' },
    { ...settings, text: ['not a string'] },
    { ...settings, text: 'a'.repeat(2049) },
    { ...settings, github: { username: 'bad"query', showRepositories: true } },
    { ...settings, weather: { city: 'Madrid', units: 'kelvin' } },
    { ...settings, mode: 'weather', weather: { city: '', units: 'metric' } }
  ];
  for (const value of invalid) assert.equal((await panelRequest(server.url, '/api/settings', value)).status, 400);
  assert.equal((await panelRequest(server.url, '/api/settings', { ...settings, mode: 'commits' })).status, 503);
  assert.equal((await panelRequest(server.url, '/api/settings', {
    ...settings, mode: 'weather', weather: { city: 'Madrid', units: 'metric' }
  })).status, 503);
  assert.deepEqual((await getSettings(server.url)).settings, settings);
  const malformed = await fetch(`${server.url}/api/settings`, {
    method: 'PUT', headers: { ...await csrfHeaders(server.url), 'Content-Type': 'application/json' }, body: '{'
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'Invalid JSON body.' });
});

test('fixed display URL switches providers and caches by source settings', { timeout: 10000 }, async t => {
  const fixture = await createFixture(t);
  const mocks = await mockProviders(fixture);
  const server = await startConfigured(fixture, { OPENWEATHER_API_KEY: 'test-only-weather-key' }, mocks.args);
  const { settings } = await getSettings(server.url);
  const commits = { ...settings, mode: 'commits', github: { username: 'alpha', showRepositories: true } };
  assert.equal((await panelRequest(server.url, '/api/settings', commits)).status, 200);
  assert.deepEqual(await (await fetch(`${server.url}/display`)).json(), { content: '7' });
  assert.deepEqual(await (await fetch(`${server.url}/commits`)).json(), { content: '7' });
  const compact = { ...commits, github: { username: 'alpha', showRepositories: false } };
  const preview = await panelRequest(server.url, '/api/preview', compact, 'POST');
  assert.deepEqual(await preview.json(), { content: '7', mode: 'commits' });
  const beta = { ...commits, github: { username: 'beta', showRepositories: true } };
  assert.equal((await panelRequest(server.url, '/api/settings', beta)).status, 200);
  assert.deepEqual(await (await fetch(`${server.url}/display`)).json(), { content: '7' });

  const weather = { ...beta, mode: 'weather', weather: { city: 'Madrid', units: 'metric' } };
  assert.equal((await panelRequest(server.url, '/api/settings', weather)).status, 200);
  assert.deepEqual(await (await fetch(`${server.url}/display`)).json(), { content: '25 C' });
  assert.deepEqual(await (await fetch(`${server.url}/weather`)).json(), { content: '25 C' });
  const fahrenheit = { ...weather, weather: { city: 'Paris', units: 'imperial' } };
  assert.equal((await panelRequest(server.url, '/api/settings', fahrenheit)).status, 200);
  assert.deepEqual(await (await fetch(`${server.url}/display`)).json(), { content: '77 F' });

  const calls = (await fs.readFile(mocks.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.filter(call => call.provider === 'github').map(call => call.username), ['alpha', 'beta']);
  assert.ok(calls.filter(call => call.provider === 'github').every(call => call.from.endsWith('T00:00:00.000Z')));
  server.child.kill();
  await server.exited;
  const restarted = await startConfigured(fixture, { OPENWEATHER_API_KEY: 'test-only-weather-key' }, mocks.args);
  assert.deepEqual(await (await fetch(`${restarted.url}/display`)).json(), { content: '77 F' });
});

test('legacy full settings load and PUT without optional templates', { timeout: 10000 }, async t => {
  const fixture = await createFixture(t);
  const dataFile = path.join(fixture.directory, 'data.json');
  const legacy = {
    mode: 'text', text: 'Existing text',
    github: { username: 'example', showRepositories: false },
    weather: { city: 'Madrid', units: 'metric' }
  };
  const stored = JSON.stringify(legacy);
  await fs.writeFile(dataFile, stored);
  const server = await startConfigured(fixture);
  const expected = {
    ...legacy,
    rotation: { enabled: false, sources: ['text'] },
    github: { ...legacy.github, template: '{{commits}}' },
    weather: { ...legacy.weather, template: '{{temperature}} {{unit}}' }
  };
  assert.deepEqual((await getSettings(server.url)).settings, expected);
  assert.equal(await fs.readFile(dataFile, 'utf8'), stored);
  const response = await panelRequest(server.url, '/api/settings', legacy);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).settings, expected);
  assert.deepEqual(JSON.parse(await fs.readFile(dataFile, 'utf8')), expected);
});

test('legacy default templates canonicalize on load and PUT while mixed literals survive', { timeout: 10000 }, async t => {
  for (const exactDefault of [true, false]) {
    const fixture = await createFixture(t);
    const dataFile = path.join(fixture.directory, 'data.json');
    const legacy = {
      mode: 'text', text: 'Existing text',
      github: { username: 'example', showRepositories: false, template: exactDefault ? '{{ content }}' : 'Today: {{content}} commits' },
      weather: { city: 'Madrid', units: 'metric', template: exactDefault ? '{{content}}' : 'Today: {{ content }} {{unit}}' }
    };
    const stored = JSON.stringify(legacy);
    await fs.writeFile(dataFile, stored);
    const server = await startConfigured(fixture);
    const normalized = { ...legacy, rotation: { enabled: false, sources: ['text'] } };
    const expected = exactDefault ? {
      ...normalized,
      github: { ...legacy.github, template: '{{commits}}' },
      weather: { ...legacy.weather, template: '{{temperature}} {{unit}}' }
    } : normalized;
    assert.deepEqual((await getSettings(server.url)).settings, expected);
    assert.equal(await fs.readFile(dataFile, 'utf8'), stored);
    const response = await panelRequest(server.url, '/api/settings', legacy);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).settings, expected);
    assert.deepEqual(JSON.parse(await fs.readFile(dataFile, 'utf8')), expected);
  }
});

test('custom templates use cached data, preview without saving and survive restart', { timeout: 10000 }, async t => {
  const fixture = await createFixture(t);
  const mocks = await mockProviders(fixture);
  const server = await startConfigured(fixture, { OPENWEATHER_API_KEY: 'test-only-weather-key' }, mocks.args);
  const dataFile = path.join(fixture.directory, 'data.json');
  let { settings } = await getSettings(server.url);
  const scenarios = [
    {
      mode: 'commits', source: 'github', route: '/commits',
      config: { username: 'example', showRepositories: false },
      original: '7',
      template: 'Today: ¡Ánimo {{ username }}! {{commits}} commits; {{repositories}} | {{content}}',
      rendered: 'Today: Animo example! 7 commits; example: 7 | 7'
    },
    {
      mode: 'weather', source: 'weather', route: '/weather',
      config: { city: 'Málaga', units: 'metric' },
      original: '25 C',
      template: 'Today: Café en {{city}}: {{ temperature }}°{{unit}}, {{condition}} | {{content}}',
      rendered: 'Today: Cafe en Malaga: 25C, clear sky | 25'
    }
  ];
  for (const scenario of scenarios) {
    settings = {
      ...settings, mode: scenario.mode,
      [scenario.source]: { ...scenario.config, template: '{{content}}' }
    };
    const saved = await panelRequest(server.url, '/api/settings', settings);
    assert.equal(saved.status, 200);
    settings = (await saved.json()).settings;
    assert.deepEqual(await (await fetch(`${server.url}/display`)).json(), { content: scenario.original });
    const stored = await fs.readFile(dataFile, 'utf8');
    const draft = {
      ...settings,
      [scenario.source]: { ...settings[scenario.source], template: scenario.template }
    };
    const preview = await panelRequest(server.url, '/api/preview', draft, 'POST');
    assert.equal(preview.status, 200);
    assert.deepEqual(await preview.json(), { content: scenario.rendered, mode: scenario.mode });
    assert.equal(await fs.readFile(dataFile, 'utf8'), stored);
    assert.deepEqual((await getSettings(server.url)).settings, settings);
    assert.deepEqual(await (await fetch(`${server.url}${scenario.route}`)).json(), { content: scenario.original });
    const empty = { ...draft, [scenario.source]: { ...draft[scenario.source], template: '' } };
    assert.equal((await panelRequest(server.url, '/api/settings', empty)).status, 200);
    assert.deepEqual(await (await fetch(`${server.url}/display`)).json(), { content: '' });
    assert.deepEqual(await (await fetch(`${server.url}${scenario.route}`)).json(), { content: '' });
    assert.equal((await panelRequest(server.url, '/api/settings', draft)).status, 200);
    assert.deepEqual(await (await fetch(`${server.url}/display`)).json(), { content: scenario.rendered });
    assert.deepEqual(await (await fetch(`${server.url}${scenario.route}`)).json(), { content: scenario.rendered });
    settings = draft;
  }
  const calls = (await fs.readFile(mocks.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.map(call => call.provider), ['github', 'weather']);
  server.child.kill();
  await server.exited;
  const restarted = await startConfigured(fixture, {}, mocks.args);
  assert.deepEqual((await getSettings(restarted.url)).settings, settings);
  for (const scenario of scenarios) {
    assert.deepEqual(await (await fetch(`${restarted.url}${scenario.route}`)).json(), { content: scenario.rendered });
  }
  assert.deepEqual(await (await fetch(`${restarted.url}/display`)).json(), { content: scenarios[1].rendered });
});

test('invalid templates are rejected safely by settings and preview', { timeout: 10000 }, async t => {
  const fixture = await createFixture(t);
  const server = await startConfigured(fixture);
  const { settings } = await getSettings(server.url);
  const dataFile = path.join(fixture.directory, 'data.json');
  const stored = await fs.readFile(dataFile, 'utf8');
  for (const source of ['github', 'weather']) {
    for (const template of [null, false, 7, [], {}, 'a'.repeat(2049), `{{${' '.repeat(2038)}content}}`,
      `${'a'.repeat(2038)}{{content}}`, '{{private-user-content}}', '{{constructor}}', '{{ content', '{{}}']) {
      const draft = { ...settings, [source]: { ...settings[source], template } };
      for (const [endpoint, method] of [['/api/settings', 'PUT'], ['/api/preview', 'POST']]) {
        const response = await panelRequest(server.url, endpoint, draft, method);
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), {
          error: typeof template !== 'string' || template.length > 2048
            ? 'Template must be a string of at most 2048 characters.'
            : 'Template contains an unsupported placeholder.'
        });
      }
    }
  }
  assert.deepEqual((await getSettings(server.url)).settings, settings);
  assert.equal(await fs.readFile(dataFile, 'utf8'), stored);
  assert.doesNotMatch(server.output(), /private-user-content/);
});

test('upstream failure does not affect health or leak credentials', { timeout: 10000 }, async t => {
  const fixture = await createFixture(t);
  const mocks = await mockProviders(fixture);
  const server = await startConfigured(fixture, {}, mocks.args);
  const { settings } = await getSettings(server.url);
  const broken = { ...settings, mode: 'commits', github: { ...settings.github, username: 'fail-user', showRepositories: true } };
  assert.equal((await panelRequest(server.url, '/api/settings', broken)).status, 200);
  const response = await fetch(`${server.url}/display`);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'GitHub returned HTTP 401.' });
  assert.deepEqual(await (await fetch(`${server.url}/healthz`)).json(), { status: 'ok' });
  assert.deepEqual((await getSettings(server.url)).settings, broken);
  assert.doesNotMatch(server.output(), /test-only-not-a-real-token/);
});

test('failed atomic save leaves the previous settings file intact', async t => {
  const fixture = await createFixture(t);
  const dataFile = path.join(fixture.directory, 'data.json');
  const original = JSON.stringify({ text: 'Keep me' });
  await fs.writeFile(dataFile, original);
  t.mock.method(require('node:fs'), 'renameSync', () => {
    throw Object.assign(new Error('Simulated write failure'), { code: 'EACCES' });
  });
  assert.throws(() => saveSettings(dataFile, { text: 'Unsaved text' }), /Simulated write failure/);
  assert.equal(await fs.readFile(dataFile, 'utf8'), original);
  assert.equal((await fs.readdir(fixture.directory)).some(file => file.endsWith('.tmp')), false);
});

test('provider keys are managed via the panel and encrypted on disk', { timeout: 10000 }, async t => {
  const fixture = await createFixture(t);
  const server = await startConfigured(fixture, { GITHUB_TOKEN: '' });
  const secret = 'github-test-credential-not-real';
  const weatherKey = 'weather-test-credential-not-real';
  assert.deepEqual((await getSettings(server.url)).capabilities, { github: false, weather: false });
  assert.equal((await fetch(`${server.url}/api/credentials`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ githubToken: secret })
  })).status, 403);
  const saved = await panelRequest(server.url, '/api/credentials', { githubToken: secret, weatherKey });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { capabilities: { github: true, weather: true } });
  const settingsResponse = JSON.stringify(await getSettings(server.url));
  assert.ok(!settingsResponse.includes(secret) && !settingsResponse.includes(weatherKey));
  const stored = await fs.readFile(path.join(fixture.directory, 'credentials.json'), 'utf8');
  assert.ok(!stored.includes(secret) && !stored.includes(weatherKey));
  for (const name of ['credentials.json', 'credentials.key']) {
    assert.equal((await fs.stat(path.join(fixture.directory, name))).mode & 0o777, 0o600);
  }
  const store = createCredentialStore(path.join(fixture.directory, 'data.json'));
  assert.deepEqual(store.load(), { githubToken: secret, weatherKey });

  for (const invalid of [{}, { githubToken: null }, { password: 'unsupported' }, { weatherKey: 'has whitespace' }]) {
    assert.equal((await panelRequest(server.url, '/api/credentials', invalid)).status, 400);
  }
  const removed = await panelRequest(server.url, '/api/credentials', { githubToken: '' });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { capabilities: { github: false, weather: true } });
  assert.deepEqual(store.load(), { githubToken: '', weatherKey });
  server.child.kill();
  await server.exited;
  const restarted = await startConfigured(fixture, { GITHUB_TOKEN: '' });
  assert.deepEqual((await getSettings(restarted.url)).capabilities, { github: false, weather: true });
  assert.ok(!server.output().includes(secret) && !server.output().includes(weatherKey));
});

test('failed credential write retains the previous active credentials', { timeout: 10000 }, async t => {
  const fixture = await createFixture(t);
  const server = await startConfigured(fixture);
  const credentialsFile = path.join(fixture.directory, 'credentials.json');
  await fs.rename(credentialsFile, `${credentialsFile}.backup`);
  await fs.mkdir(credentialsFile);
  const result = await panelRequest(server.url, '/api/credentials', { githubToken: '' });
  assert.equal(result.status, 500);
  assert.deepEqual((await getSettings(server.url)).capabilities, { github: true, weather: false });
});

test('missing encryption key is never regenerated over an existing credential store', async t => {
  const fixture = await createFixture(t);
  const store = createCredentialStore(path.join(fixture.directory, 'data.json'));
  store.save({ githubToken: 'synthetic-key' });
  const file = path.join(fixture.directory, 'credentials.json');
  const original = await fs.readFile(file, 'utf8');
  await fs.unlink(path.join(fixture.directory, 'credentials.key'));
  assert.throws(() => store.save({ githubToken: 'replacement-key' }), { code: 'ENOENT' });
  assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.throws(() => store.load(), /Cannot decrypt credentials/);
});

test('both provider keys can be saved at their documented size limits', { timeout: 10000 }, async t => {
  const fixture = await createFixture(t);
  const server = await startConfigured(fixture);
  const result = await panelRequest(server.url, '/api/credentials', {
    githubToken: '"'.repeat(8192), weatherKey: '\\'.repeat(8192)
  });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { capabilities: { github: true, weather: true } });
});

test('credential changes invalidate cached responses', { timeout: 10000 }, async t => {
  const fixture = await createFixture(t);
  const mocks = await mockProviders(fixture);
  const server = await startConfigured(fixture, {}, mocks.args);
  assert.equal((await fetch(`${server.url}/commits`)).status, 200);
  assert.equal((await fetch(`${server.url}/commits`)).status, 200);
  assert.equal((await panelRequest(server.url, '/api/credentials', { githubToken: 'replacement-test-key' })).status, 200);
  assert.equal((await fetch(`${server.url}/commits`)).status, 200);
  assert.equal((await fs.readFile(mocks.calls, 'utf8')).trim().split('\n').length, 2);
  assert.equal((await panelRequest(server.url, '/api/credentials', { githubToken: '' })).status, 200);
  assert.equal((await fetch(`${server.url}/commits`)).status, 503);
});

test('legacy environment migration preserves text and removes plaintext provider entries', { timeout: 10000 }, async t => {
  const fixture = await createFixture(t);
  const envFile = path.join(fixture.directory, '.env-dev');
  const dataFile = path.join(fixture.directory, 'data.json');
  await fs.writeFile(dataFile, JSON.stringify({ text: 'Existing message' }));
  await fs.writeFile(envFile, [
    'PORT=3005', 'LOCALHOST=http://localhost', 'GITHUB_TOKEN=legacy-test-key',
    'GITHUB_USERNAME=artcc', 'OPENWEATHER_API_KEY=legacy-weather-key',
    'OPENWEATHER_CITY=Madrid', 'OPENWEATHER_UNITS=metric'
  ].join('\n'));
  const child = spawn(process.execPath, [path.join(root, 'scripts/migrate-env.js'), envFile, dataFile], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, output);
  const remaining = await fs.readFile(envFile, 'utf8');
  assert.match(remaining, /LOCALHOST=http:\/\/localhost/);
  assert.doesNotMatch(remaining, /GITHUB_|OPENWEATHER_/);
  assert.doesNotMatch(output, /legacy-test-key|legacy-weather-key/);
  assert.deepEqual(createCredentialStore(dataFile).load(), { githubToken: 'legacy-test-key', weatherKey: 'legacy-weather-key' });
  const migrated = loadSettings(dataFile, {});
  assert.equal(migrated.text, 'Existing message');
  assert.equal(migrated.github.username, 'artcc');
  assert.equal(migrated.github.template, '{{commits}}');
  assert.equal(migrated.weather.city, 'Madrid');
  assert.equal(migrated.weather.template, '{{temperature}} {{unit}}');
});

test('migration failures retain the environment and existing data', { timeout: 10000 }, async t => {
  const fixture = await createFixture(t);
  const envFile = path.join(fixture.directory, '.env-dev');
  const dataFile = path.join(fixture.directory, 'data.json');
  const original = JSON.stringify({ text: 'Keep existing text' });
  await fs.writeFile(dataFile, original);
  const store = createCredentialStore(dataFile);
  store.save({ githubToken: 'existing-key', weatherKey: '' });
  for (const source of [
    'GITHUB_TOKEN=different-key\nPORT=3005',
    'GITHUB_TOKEN="first-line\nsecond-line"\nGITHUB_TOKEN=existing-key',
    'GITHUB_TOKEN=existing-key\nOTHER="first-line\nOPENWEATHER_CITY=Madrid\nlast-line"'
  ]) {
    await fs.writeFile(envFile, source);
    const child = spawn(process.execPath, [path.join(root, 'scripts/migrate-env.js'), envFile, dataFile], {
      stdio: 'ignore'
    });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.equal(await fs.readFile(envFile, 'utf8'), source);
    assert.equal(await fs.readFile(dataFile, 'utf8'), original);
    assert.deepEqual(store.load(), { githubToken: 'existing-key', weatherKey: '' });
  }
});

test('rotation routes share clock phase, provider caches and safe fallback without changing saved settings', { timeout: 10000 }, async t => {
  const fixture = await createFixture(t);
  const mocks = await mockProviders(fixture);
  const clockFile = path.join(fixture.directory, 'clock.txt');
  const clockPreload = path.join(fixture.directory, 'clock.cjs');
  await fs.writeFile(clockFile, '60000');
  await fs.writeFile(clockPreload, `Date.now = () => Number(require('node:fs').readFileSync(${JSON.stringify(clockFile)}, 'utf8'));`);
  const args = [...mocks.args, '--require', clockPreload];
  let server = await startConfigured(fixture, { OPENWEATHER_API_KEY: 'test-only-weather-key' }, args);
  const initial = await getSettings(server.url);
  assert.equal(initial.rotationIntervalMs, 60000);
  assert.deepEqual(await (await fetch(`${server.url}/api/display`)).json(), { content: '', mode: 'text', skippedSources: [] });
  const saved = await panelRequest(server.url, '/api/settings', {
    ...initial.settings, text: 'Saved message', mode: 'weather',
    weather: { ...initial.settings.weather, city: 'Madrid' },
    rotation: { enabled: true, sources: ['weather', 'commits', 'text'] }
  });
  assert.equal(saved.status, 200);
  const { settings } = await saved.json();
  assert.deepEqual(settings.rotation.sources, ['text', 'commits', 'weather']);
  const dataFile = path.join(fixture.directory, 'data.json');
  const stored = await fs.readFile(dataFile, 'utf8');
  for (let i = 0; i < 3; i++) {
    const live = await fetch(`${server.url}/api/display`);
    assert.equal(live.headers.get('cache-control'), 'no-store');
    assert.equal(live.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(await live.json(), { content: '7', mode: 'commits', skippedSources: [] });
    assert.deepEqual(await (await fetch(`${server.url}/display`)).json(), { content: '7' });
  }
  const preview = await panelRequest(server.url, '/api/preview', {
    ...settings, mode: 'text', text: 'Draft', github: { ...settings.github, username: '' },
    weather: { ...settings.weather, city: '' }
  }, 'POST');
  assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), { content: 'Draft', mode: 'text' });
  assert.deepEqual(await (await fetch(`${server.url}/api/display`)).json(), { content: '7', mode: 'commits', skippedSources: [] });
  assert.equal(await fs.readFile(dataFile, 'utf8'), stored);
  for (const [time, mode, content] of [[120000, 'weather', '25 C'], [180000, 'text', 'Saved message'], [240000, 'commits', '7']]) {
    await fs.writeFile(clockFile, String(time));
    assert.deepEqual(await (await fetch(`${server.url}/api/display`)).json(), { content, mode, skippedSources: [] });
  }
  assert.deepEqual(await (await fetch(`${server.url}/weather`)).json(), { content: '25 C' });
  assert.deepEqual(await (await fetch(`${server.url}/commits`)).json(), { content: '7' });
  assert.deepEqual((await fs.readFile(mocks.calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line).provider), ['github', 'weather']);
  server.child.kill();
  await server.exited;
  server = await startConfigured(fixture, {}, args);
  assert.deepEqual((await getSettings(server.url)).settings, settings);
  assert.deepEqual(await (await fetch(`${server.url}/api/display`)).json(), { content: '7', mode: 'commits', skippedSources: [] });

  const brokenGithub = { ...settings, github: { ...settings.github, username: 'fail-user' } };
  assert.equal((await panelRequest(server.url, '/api/settings', brokenGithub)).status, 200);
  assert.deepEqual(await (await fetch(`${server.url}/api/display`)).json(), { content: '25 C', mode: 'weather', skippedSources: ['commits'] });
  assert.deepEqual(await (await fetch(`${server.url}/display`)).json(), { content: '25 C' });
  const failedPreview = await panelRequest(server.url, '/api/preview', { ...brokenGithub, mode: 'commits' }, 'POST');
  assert.equal(failedPreview.status, 502);
  assert.deepEqual((await getSettings(server.url)).settings, brokenGithub);

  assert.equal((await panelRequest(server.url, '/api/credentials', { githubToken: '', weatherKey: '' })).status, 200);
  assert.deepEqual(await (await fetch(`${server.url}/api/display`)).json(), {
    content: 'Saved message', mode: 'text', skippedSources: ['commits', 'weather']
  });
  assert.deepEqual(JSON.parse(await fs.readFile(dataFile, 'utf8')), brokenGithub);
  assert.equal((await panelRequest(server.url, '/api/credentials', {
    githubToken: 'test-only-not-a-real-token', weatherKey: 'test-only-weather-key'
  })).status, 200);
  const allFailed = { ...brokenGithub, weather: { ...settings.weather, city: 'Broken' },
    rotation: { enabled: true, sources: ['commits', 'weather'] } };
  assert.equal((await panelRequest(server.url, '/api/settings', allFailed)).status, 200);
  for (const endpoint of ['/display', '/api/display']) {
    const response = await fetch(`${server.url}${endpoint}`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'No display source is currently available.' });
  }
  assert.deepEqual((await getSettings(server.url)).settings, allFailed);
  const legacy = await fetch(`${server.url}/setDisplay?text=Legacy`, { headers: await csrfHeaders(server.url) });
  assert.equal(legacy.status, 200);
  assert.deepEqual(await legacy.json(), { content: 'Legacy' });
  const legacySettings = (await getSettings(server.url)).settings;
  assert.equal(legacySettings.mode, 'text');
  assert.deepEqual(legacySettings.rotation, { enabled: false, sources: ['text'] });
  assert.deepEqual(await (await fetch(`${server.url}/api/display`)).json(), { content: 'Legacy', mode: 'text', skippedSources: [] });

  assert.equal((await panelRequest(server.url, '/api/settings', settings)).status, 200);
  const oldClient = { ...settings, mode: 'text' };
  delete oldClient.rotation;
  const oldClientSave = await panelRequest(server.url, '/api/settings', oldClient);
  assert.equal(oldClientSave.status, 200);
  assert.deepEqual((await oldClientSave.json()).settings.rotation, { enabled: false, sources: ['text'] });
});

test('rotation checks every included credential while preview checks only its selected source', { timeout: 10000 }, async t => {
  const fixture = await createFixture(t);
  const server = await startConfigured(fixture, { GITHUB_TOKEN: '' });
  const { settings } = await getSettings(server.url);
  const configured = { ...settings, weather: { ...settings.weather, city: 'Madrid' } };
  for (const sources of [['text', 'commits'], ['text', 'weather']]) {
    const draft = { ...configured, rotation: { enabled: true, sources } };
    const response = await panelRequest(server.url, '/api/settings', draft);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /^Configure /);
    assert.equal((await panelRequest(server.url, '/api/preview', draft, 'POST')).status, 200);
  }
  for (const mode of ['commits', 'weather']) {
    assert.equal((await panelRequest(server.url, '/api/preview', { ...configured, mode,
      rotation: { enabled: true, sources: ['text', 'commits', 'weather'] } }, 'POST')).status, 503);
  }
  assert.equal((await panelRequest(server.url, '/api/credentials', { githubToken: 'test-only-not-a-real-token' })).status, 200);
  assert.equal((await panelRequest(server.url, '/api/settings', { ...configured,
    rotation: { enabled: true, sources: ['commits', 'weather'] } })).status, 503);
  const editor = { ...settings, mode: 'weather', rotation: { enabled: true, sources: ['text', 'commits'] } };
  assert.equal((await panelRequest(server.url, '/api/settings', editor)).status, 200);
  assert.equal((await panelRequest(server.url, '/api/preview', editor, 'POST')).status, 400);
  assert.equal((await panelRequest(server.url, '/api/preview', { ...settings,
    rotation: { enabled: true, sources: ['text'] } }, 'POST')).status, 400);
});

test('settings and display derive the interval from acknowledged device metadata only', { timeout: 10000 }, async t => {
  for (const lastSentAt of [null, '2026-01-01T00:00:00.000Z']) {
    const fixture = await createFixture(t);
    const mocks = await mockProviders(fixture);
    const clockPreload = path.join(fixture.directory, 'clock.cjs');
    await fs.writeFile(clockPreload, 'Date.now = () => 60000;');
    await fs.writeFile(path.join(fixture.directory, 'device.json'), JSON.stringify({
      address: '192.168.1.2', lastSentAt,
      configuration: { ...DEFAULT_CONFIGURATION, apiUrl: 'http://localhost/display', fetchRate: 120000 }
    }));
    const server = await startConfigured(fixture, {}, [...mocks.args, '--require', clockPreload]);
    const response = await getSettings(server.url);
    assert.equal(response.rotationIntervalMs, lastSentAt ? 120000 : 60000);
    assert.equal((await panelRequest(server.url, '/api/settings', { ...response.settings, text: 'Text slot',
      rotation: { enabled: true, sources: ['text', 'commits'] } })).status, 200);
    assert.deepEqual(await (await fetch(`${server.url}/api/display`)).json(), lastSentAt
      ? { content: 'Text slot', mode: 'text', skippedSources: [] }
      : { content: '7', mode: 'commits', skippedSources: [] });
  }
});
