const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');

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

  const missing = await fetch(`${url}/setDisplay`);
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: 'Missing required parameter: text' });

  const text = 'DeskHub + 100% & ready?';
  const updated = await fetch(`${url}/setDisplay?${new URLSearchParams({ text })}`);
  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), { content: text });
  assert.deepEqual(await (await fetch(`${url}/display`)).json(), { content: text });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(fixture.directory, 'data.json'), 'utf8')), { text });

  const preflight = await fetch(`${url}/setDisplay`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost', 'Access-Control-Request-Method': 'GET' }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');

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
  const response = await fetch(`${server.url}/setDisplay?${new URLSearchParams({ text })}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { content: text });
  assert.deepEqual(JSON.parse(await fs.readFile(dataFile, 'utf8')), { text });
  await assert.rejects(fs.access(path.join(original.directory, 'data.json')), { code: 'ENOENT' });

  server.child.kill();
  await server.exited;
  const recreated = await startConfigured(replacement, { DATA_FILE: dataFile });
  assert.deepEqual(await (await fetch(`${recreated.url}/display`)).json(), { content: text });

  const cleared = await fetch(`${recreated.url}/setDisplay?text=`);
  assert.equal(cleared.status, 200);
  assert.deepEqual(await cleared.json(), { content: '' });
  assert.deepEqual(JSON.parse(await fs.readFile(dataFile, 'utf8')), { text: '' });
});

test('failed persistence returns an error without updating display text', { timeout: 10000 }, async t => {
  const fixture = await createFixture(t);
  const blocked = path.join(fixture.directory, 'not-a-directory');
  await fs.writeFile(blocked, 'existing file');
  const server = await startConfigured(fixture, { DATA_FILE: path.join(blocked, 'data.json') });
  const response = await fetch(`${server.url}/setDisplay?text=Must-not-be-accepted`);
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
    content: 'Today: 10 commits (alpha: 7, beta: 3)'
  },
  {
    name: 'preserves singular commit output',
    total: 1,
    repositories: [
      { repository: { name: 'alpha' }, contributions: { nodes: [{ commitCount: 1 }] } }
    ],
    content: 'Today: 1 commit (alpha: 1)'
  },
  { name: 'handles days without commits', total: 0, repositories: [], content: 'Today: 0 commits' }
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
          callback(response);
          response.end(${JSON.stringify(JSON.stringify(response))});
        });
        return request;
      };
    `);
    const server = await startConfigured(fixture, {}, ['--require', preload]);
    const result = await fetch(`${server.url}/commits`);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { content: scenario.content });
  });
}
