const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const loader = fs.readFile(path.join(root, 'public/i18n.js'), 'utf8')
  .then(source => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));

async function dictionaries() {
  return Object.fromEntries(await Promise.all(['en', 'es'].map(async language => [
    `/locale/${language}.json`, JSON.parse(await fs.readFile(path.join(root, 'locale', `${language}.json`), 'utf8'))
  ])));
}

test('locale files cover UI keys and preserve interpolation variables', async () => {
  const files = await dictionaries();
  const english = files['/locale/en.json'];
  const spanish = files['/locale/es.json'];
  assert.deepEqual(Object.keys(english).sort(), Object.keys(spanish).sort());
  const placeholders = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const key of Object.keys(english)) {
    assert.equal(typeof english[key], 'string');
    assert.equal(typeof spanish[key], 'string');
    assert.ok(english[key].trim() && spanish[key].trim(), key);
    assert.deepEqual(placeholders(english[key]), placeholders(spanish[key]), key);
  }
  const html = await fs.readFile(path.join(root, 'public/index.html'), 'utf8');
  const app = (await Promise.all(['app.js', 'device.js', 'pomodoro.js', 'led-preview.js'].map(file => fs.readFile(path.join(root, 'public', file), 'utf8')))).join('\n');
  const keys = [
    ...[...html.matchAll(/data-i18n(?:-[\w-]+)?="(\w+)"/g)].map(match => match[1]),
    ...[...app.matchAll(/\bt\('([^']+)'/g)].map(match => match[1])
  ];
  for (const key of keys) assert.ok(Object.hasOwn(english, key), `Missing UI translation: ${key}`);
});

test('browser language preference order selects the right JSON dictionary', async t => {
  const files = await dictionaries();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url);
    assert.ok(Object.hasOwn(files, url));
    return Response.json(files[url]);
  });
  const { loadI18n } = await loader;
  for (const [preferences, expected] of [
    [['es-ES'], 'es-ES'], [['es-MX'], 'es-ES'], [['en-GB', 'es'], 'en'],
    [['fr-FR', 'es', 'en'], 'es-ES'], [['fr-FR'], 'en'], [[], 'en'], [[undefined], 'en']
  ]) {
    calls.length = 0;
    const { locale, t: translate } = await loadI18n(preferences);
    assert.equal(locale, expected);
    assert.equal(translate('saveChanges'), expected === 'en' ? 'Save changes' : 'Guardar cambios');
    assert.deepEqual(calls, expected === 'en' ? ['/locale/en.json'] : ['/locale/en.json', '/locale/es.json']);
  }
});

test('missing translated keys fall back to English and values interpolate literally', async t => {
  const files = await dictionaries();
  t.mock.method(globalThis, 'fetch', async url => Response.json(url.endsWith('/es.json')
    ? { saveChanges: 'Guardar cambios' } : files[url]));
  const { loadI18n } = await loader;
  const { locale, t: translate } = await loadI18n(['es']);
  assert.equal(locale, 'es-ES');
  assert.equal(translate('heading'), files['/locale/en.json'].heading);
  assert.equal(translate('characterCount', { count: 12, limit: 2048 }), '12 of 2048 characters');
  assert.equal(translate('lastChecked', { time: '$& <example>' }), 'Last server request: $& <example>.');
  assert.throws(() => translate('nonexistentKey'), /Missing translation/);
});

test('unavailable or malformed Spanish falls back to English', async t => {
  const files = await dictionaries();
  const { loadI18n } = await loader;
  t.mock.method(console, 'warn', () => {});
  for (const response of [new Response('', { status: 404 }), new Response('{'), Response.json([])]) {
    t.mock.method(globalThis, 'fetch', async url => url.endsWith('/es.json') ? response : Response.json(files[url]));
    const { locale, t: translate } = await loadI18n(['es']);
    assert.equal(locale, 'en');
    assert.equal(translate('saveChanges'), 'Save changes');
  }
});

test('a missing base dictionary reports failure instead of initializing a broken panel', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  const { loadI18n } = await loader;
  await assert.rejects(loadI18n(['es']), /Cannot load locale en/);
});
