const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { loadSettings, saveSettings, validateSettings } = require('../lib/settings');
const { renderDisplay, rotationIntervalMs } = require('../lib/rotation');

const defaults = {
  mode: 'text', text: 'Message',
  github: { username: '', showRepositories: true },
  weather: { city: '', units: 'metric' }
};
const rotating = validateSettings({
  ...defaults,
  github: { username: 'example' }, weather: { city: 'Madrid', units: 'metric' },
  rotation: { enabled: true, sources: ['weather', 'text', 'commits'] }
});

test('rotation normalizes legacy settings, canonical order and required source data', () => {
  assert.deepEqual(validateSettings(defaults).rotation, { enabled: false, sources: ['text'] });
  assert.deepEqual(rotating.rotation.sources, ['text', 'commits', 'weather']);
  assert.equal(validateSettings({ ...rotating, mode: 'weather', weather: defaults.weather,
    rotation: { enabled: true, sources: ['commits', 'text'] } }).mode, 'weather');
  for (const sources of [['text', 'commits'], ['text', 'weather']]) {
    assert.throws(() => validateSettings({ ...defaults, rotation: { enabled: true, sources } }), /required/);
  }
  const disabled = validateSettings({ ...defaults, rotation: { enabled: false, sources: ['commits', 'weather'] } });
  assert.equal(disabled.mode, 'text');
  assert.throws(() => validateSettings({ ...disabled, mode: 'commits' }), /username is required/);
  assert.throws(() => validateSettings({ ...disabled, mode: 'weather' }), /city is required/);
});

test('invalid rotation shapes, duplicates and insufficient selections are rejected', () => {
  for (const rotation of [null, [], {}, { enabled: 'true', sources: ['text', 'commits'] },
    { enabled: true, sources: [] }, { enabled: false, sources: [] },
    { enabled: true, sources: ['text'] }, { enabled: true, sources: ['text', 'text'] },
    { enabled: false, sources: ['text', 'text'] }, { enabled: false, sources: ['github'] },
    { enabled: true, sources: ['text', null] }, { enabled: true, sources: 'text,commits' }]) {
    assert.throws(() => validateSettings({ ...rotating, rotation }), /Rotation requires/);
  }
});

test('preview validates rotation shape but requires only the selected source data', () => {
  const draft = { ...defaults, rotation: rotating.rotation };
  assert.deepEqual(validateSettings(draft, { preview: true }).rotation, rotating.rotation);
  assert.throws(() => validateSettings({ ...draft, mode: 'commits' }, { preview: true }), /username is required/);
  assert.throws(() => validateSettings({ ...draft, rotation: { enabled: true, sources: ['text'] } },
    { preview: true }), /Rotation requires/);
});

test('migration preserves source fields and loading never rewrites old storage', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deskhub-rotation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'data.json');
  for (const stored of [{ text: 'Legacy' }, { ...rotating, rotation: undefined }]) {
    const original = JSON.stringify(stored);
    await fs.writeFile(file, original);
    const loaded = loadSettings(file, rotating);
    assert.equal(loaded.text, stored.text);
    assert.deepEqual(loaded.rotation, { enabled: false, sources: ['text'] });
    assert.deepEqual(loaded.github, rotating.github);
    assert.deepEqual(loaded.weather, rotating.weather);
    assert.equal(await fs.readFile(file, 'utf8'), original);
  }
  saveSettings(file, rotating);
  assert.deepEqual(loadSettings(file, defaults), rotating);
});

test('wall-clock slots are exact and independent of reads, previews and service lifetime', async () => {
  let timestamp = 0;
  const clock = () => timestamp;
  const content = { render: async selection => selection.mode };
  for (const [time, mode] of [[0, 'text'], [59999, 'text'], [60000, 'commits'], [119999, 'commits'],
    [120000, 'weather'], [179999, 'weather'], [180000, 'text']]) {
    timestamp = time;
    for (let read = 0; read < 3; read++) {
      assert.deepEqual(await renderDisplay(rotating, content, { now: clock }), { content: mode, mode, skippedSources: [] });
      await content.render({ ...rotating, mode: 'weather' });
    }
    // A fresh renderer and clock retain the same phase, without persisted counters.
    assert.equal((await renderDisplay(rotating, { ...content }, { now: () => time })).mode, mode);
  }
  assert.equal((await renderDisplay(rotating, content, { intervalMs: 120000, now: () => 60000 })).mode, 'text');
});

test('interval uses only acknowledged device configuration', () => {
  assert.equal(rotationIntervalMs({ lastSentAt: null, configuration: { fetchRate: 1000 } }), 60000);
  assert.equal(rotationIntervalMs({ lastSentAt: '2026-01-01T00:00:00.000Z', configuration: { fetchRate: 15000 } }), 15000);
});

test('fallback follows the included cycle, reports only safe source names and accepts empty content', async () => {
  const snapshot = structuredClone(rotating);
  const calls = [];
  const content = { render: async ({ mode }) => {
    calls.push(mode);
    if (mode !== 'text') throw Object.assign(new Error('Synthetic private provider details'), { status: mode === 'commits' ? 502 : 504 });
    return '';
  } };
  assert.deepEqual(await renderDisplay(rotating, content, { now: () => 60000 }), {
    content: '', mode: 'text', skippedSources: ['commits', 'weather']
  });
  assert.deepEqual(calls, ['commits', 'weather', 'text']);
  assert.deepEqual(rotating, snapshot);
  const unavailable = { render: async () => { throw Object.assign(new Error('Synthetic missing credential'), { status: 503 }); } };
  await assert.rejects(renderDisplay({ ...rotating, rotation: { enabled: true, sources: ['commits', 'weather'] } },
    unavailable, { now: () => 0 }), { status: 503, message: 'No display source is currently available.' });
});

test('single-source errors and unexpected errors propagate instead of triggering fallback', async () => {
  for (const error of [new TypeError('Programming error'), Object.assign(new Error('Unexpected status'), { status: 400 })]) {
    await assert.rejects(renderDisplay(rotating, { render: async () => { throw error; } }, { now: () => 60000 }),
      received => received === error);
  }
  const failure = Object.assign(new Error('Provider failed'), { status: 502 });
  await assert.rejects(renderDisplay({ ...rotating, rotation: { enabled: false, sources: ['text'] } },
    { render: async () => { throw failure; } }), received => received === failure);
  await assert.rejects(renderDisplay(rotating, { render: async () => { throw failure; } }, { now: () => 0 }),
    received => received === failure);
  assert.deepEqual(await renderDisplay(validateSettings(defaults), { render: async () => 'Message' }, {
    now: () => { throw new Error('Disabled rotation should not consult the clock'); }
  }), { content: 'Message', mode: 'text', skippedSources: [] });
});
