const assert = require('node:assert/strict');
const https = require('node:https');
const { PassThrough, Writable } = require('node:stream');
const { test } = require('node:test');
const { createContentService } = require('../lib/content');
const { validateSettings } = require('../lib/settings');
const { renderDisplay } = require('../lib/rotation');

function settings() {
  return {
    mode: 'text', text: '',
    github: { username: 'example', showRepositories: true },
    weather: { city: 'Madrid', units: 'metric' }
  };
}

function mockProvider(t, data, chunks = [Buffer.from(JSON.stringify(data))]) {
  const calls = [];
  t.mock.method(https, 'request', (options, callback) => {
    calls.push(options.hostname);
    const request = new Writable({ write(chunk, encoding, done) { done(); } });
    request.on('finish', () => {
      const response = new PassThrough();
      response.statusCode = 200;
      callback(response);
      for (const chunk of chunks) response.write(chunk);
      response.end();
    });
    return request;
  });
  return calls;
}

test('templates default only when omitted and accept the full length limit', () => {
  const input = settings();
  const normalized = validateSettings(input);
  assert.equal(normalized.github.template, '{{commits}}');
  assert.equal(normalized.weather.template, '{{temperature}} {{unit}}');
  assert.equal(Object.hasOwn(input.github, 'template'), false);
  for (const source of ['github', 'weather']) {
    for (const template of ['', 'a'.repeat(2048), 'literal {braces}', '{{ content }} {{content}}',
      'Today: {{content}}', '{{content}}\n', `${'a'.repeat(2037)}{{content}}`]) {
      const draft = { ...input, [source]: { ...input[source], template } };
      assert.equal(validateSettings(draft)[source].template, template);
    }
    const otherSourceToken = source === 'github' ? '{{temperature}}' : '{{commits}}';
    for (const template of [otherSourceToken, '{{CONTENT}}', '{{content.toString()}}', '{{{content}}}', '{{content}}}}']) {
      assert.throws(() => validateSettings({ ...input, [source]: { ...input[source], template } }), {
        message: 'Template contains an unsupported placeholder.'
      });
    }
  }
});

test('only exact legacy default templates are canonicalized, after length validation', () => {
  const input = settings();
  for (const [source, expected] of [['github', '{{commits}}'], ['weather', '{{temperature}} {{unit}}']]) {
    for (const template of ['{{content}}', '{{ content }}', '{{\ncontent\t}}', `{{${' '.repeat(2037)}content}}`]) {
      const draft = { ...input, [source]: { ...input[source], template } };
      assert.equal(validateSettings(draft)[source].template, expected);
    }
    for (const template of [`{{${' '.repeat(2038)}content}}`, `${'a'.repeat(2038)}{{content}}`]) {
      assert.throws(() => validateSettings({ ...input, [source]: { ...input[source], template } }), {
        message: 'Template must be a string of at most 2048 characters.'
      });
    }
  }
});

test('deprecated showRepositories is optional, preserved and type checked', () => {
  const input = settings();
  delete input.github.showRepositories;
  assert.equal(validateSettings(input).github.showRepositories, true);
  for (const showRepositories of [true, false]) {
    assert.equal(validateSettings({ ...input, github: { ...input.github, showRepositories } }).github.showRepositories, showRepositories);
  }
  for (const showRepositories of [null, 0, 'false', [], {}]) {
    assert.throws(() => validateSettings({ ...input, github: { ...input.github, showRepositories } }));
  }
});

test('weather templates use the resolved city, rounded temperature, units and ASCII condition', async t => {
  const calls = mockProvider(t, { cod: 200, name: 'Málaga', main: { temp: 18.6 }, weather: [{ id: 501, description: 'lluvia moderada' }] });
  const service = createContentService({ weatherKey: 'test-only-weather-key' });
  const config = { city: 'Malaga,ES', units: 'metric' };
  assert.equal(await service.weather(config), '19 C');
  assert.equal(await service.weather({ ...config, template: '{{content}}' }), '19');
  assert.equal(await service.weather({ ...config, template: '{{temperature}}' }), '19');
  assert.equal(await service.weather({ ...config, template: 'Today: {{content}}' }), 'Today: 19');
  assert.equal(await service.weather({ ...config, template: '{{unit}} | {{city}} | {{condition}}' }), 'C | Malaga | lluvia moderada');
  assert.equal(await service.weather({ ...config, template: 'Aquí\n{{city}}: {{temperature}}°{{unit}} {{condition}}' }),
    'Aqui Malaga: 19C lluvia moderada');
  assert.equal(await service.weather({ ...config, template: '' }), '');
  assert.equal(calls.length, 1);
  assert.equal(await service.weather({ ...config, units: 'imperial', template: '{{temperature}}{{unit}}' }), '19F');
  assert.equal(calls.length, 2);
});

test('GitHub templates use bare zero totals and empty repository lists without prose', async t => {
  const calls = mockProvider(t, { data: { user: { contributionsCollection: {
    totalCommitContributions: 0, commitContributionsByRepository: []
  } } } });
  const service = createContentService({ githubToken: 'test-only-github-key' });
  const config = { username: 'example', showRepositories: true };
  assert.equal(await service.commits(config), '0');
  assert.equal(await service.commits({ ...config, template: '{{content}}' }), '0');
  assert.equal(await service.commits({ ...config, template: '{{username}}: {{commits}} [{{repositories}}] {{content}}' }),
    'example: 0 [] 0');
  assert.equal(await service.commits({ ...config, template: '' }), '');
  assert.equal(calls.length, 1);
});

test('repositories appear only when requested, independently of the deprecated flag', async t => {
  const calls = mockProvider(t, { data: { user: { contributionsCollection: {
    totalCommitContributions: 1,
    commitContributionsByRepository: [{ repository: { name: 'alpha' }, contributions: { nodes: [{ commitCount: 1 }] } }]
  } } } });
  const service = createContentService({ githubToken: 'test-only-github-key' });
  for (const showRepositories of [true, false, undefined]) {
    const config = { username: 'example', showRepositories };
    assert.equal(await service.commits(config), '1');
    assert.equal(await service.commits({ ...config, template: '{{repositories}}' }), 'alpha: 1');
    assert.equal(await service.commits({ ...config, template: 'Today: {{content}} commits ({{repositories}})' }), 'Today: 1 commits (alpha: 1)');
  }
  assert.equal(calls.length, 1);
});

test('weather condition uses provider description verbatim apart from ASCII normalization', async t => {
  mockProvider(t, { cod: 200, name: 'Madrid', main: { temp: 1 }, weather: [{ id: 800, description: 'Lluvia débil: CUSTOM' }] });
  const service = createContentService({ weatherKey: 'test-only-weather-key' });
  assert.equal(await service.weather({ city: 'Madrid', units: 'metric', template: '{{condition}}' }), 'Lluvia debil: CUSTOM');
});

test('invalid weather descriptions are rejected instead of synthesized from an ID', async t => {
  for (const description of [undefined, null, 800, [], {}]) {
    await t.test(`description ${JSON.stringify(description)}`, async t => {
      const calls = mockProvider(t, { cod: 200, name: 'Madrid', main: { temp: 1 }, weather: [{ id: 800, description }] });
      const service = createContentService({ weatherKey: 'test-only-weather-key' });
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(service.weather({ city: 'Madrid', units: 'metric' }), {
          message: 'OpenWeatherMap returned invalid weather data.', status: 502
        });
      }
      assert.equal(calls.length, 2);
    });
  }
});

test('plain text keeps literal tokens and wording without calling providers', async t => {
  t.mock.method(https, 'request', () => { throw new Error('Unexpected provider request'); });
  const service = createContentService({});
  const text = 'Today: {{content}} commits; {{city}}';
  assert.equal(await service.render({ mode: 'text', text }), text);
});

test('malformed provider bodies return provider errors and allow rotation fallback without caching failures', async t => {
  for (const [mode, payload] of [
    ['commits', null], ['weather', null],
    ['commits', { data: { user: { contributionsCollection: {
      totalCommitContributions: 1, commitContributionsByRepository: [null]
    } } } }]
  ]) {
    await t.test(`${mode}: ${JSON.stringify(payload)}`, async t => {
      const calls = mockProvider(t, payload);
      const service = createContentService({ githubToken: 'test-only-github-key', weatherKey: 'test-only-weather-key' });
      const input = validateSettings({ ...settings(), mode, text: 'Available text',
        rotation: { enabled: true, sources: ['text', mode] } });
      await assert.rejects(service.render(input), { status: 502 });
      assert.deepEqual(await renderDisplay(input, service, { now: () => 60000 }), {
        content: 'Available text', mode: 'text', skippedSources: [mode]
      });
      assert.equal(calls.length, 2);
    });
  }
});

test('provider UTF-8 text survives a network split inside an accented character', async t => {
  const body = Buffer.from(JSON.stringify({ cod: 200, name: 'Málaga', main: { temp: 21 },
    weather: [{ description: 'lluvia débil' }] }));
  const split = body.indexOf(Buffer.from('á')) + 1;
  mockProvider(t, null, [body.subarray(0, split), body.subarray(split)]);
  const service = createContentService({ weatherKey: 'test-only-weather-key' });
  assert.equal(await service.weather({ city: 'Malaga', units: 'metric', template: '{{city}}: {{condition}}' }),
    'Malaga: lluvia debil');
});

test('provider strings are interpolated once and never interpreted as template code', async t => {
  mockProvider(t, { cod: 200, name: '{{temperature}} $&', main: { temp: -2.6 }, weather: [{ id: 800, description: 'clear sky' }] });
  const service = createContentService({ weatherKey: 'test-only-weather-key' });
  assert.equal(await service.weather({ city: 'example', units: 'metric', template: '{{city}} / {{temperature}}' }),
    '{{temperature}} $& / -3');
});
