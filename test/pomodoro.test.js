const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createPomodoroService } = require('../lib/pomodoro');

const DEFAULTS = {
  workMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, sessionsBeforeLongBreak: 4,
  autoStartBreaks: true, autoStartWork: false, template: '{{time}}'
};
const MINUTE = 60000;

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deskhub-pomodoro-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dataFile = path.join(directory, 'data.json');
  const file = path.join(directory, 'pomodoro.json');
  let clock = 1700000000000;
  const now = () => clock;
  const service = createPomodoroService(dataFile, { now });
  return {
    service, file, directory, dataFile, now,
    advance: milliseconds => { clock += milliseconds; },
    setTime: timestamp => { clock = timestamp; },
    restart: () => createPomodoroService(dataFile, { now }),
    configure: overrides => service.configure({ ...DEFAULTS, ...overrides }, service.read().revision),
    act: action => service.act(action, service.read().revision)
  };
}

function rejects(operation, code, status) {
  assert.throws(operation, { code, status });
}

test('defaults and read-only rendering do not create storage or expose mutable state', t => {
  const f = fixture(t);
  const initial = f.service.read();
  assert.deepEqual(initial, {
    configuration: DEFAULTS, phase: 'work', status: 'idle', remainingMs: 25 * MINUTE,
    durationMs: 25 * MINUTE, endsAt: null, completedSessions: 0, session: 1,
    revision: 0, serverNow: f.now(), content: '25:00'
  });
  initial.configuration.workMinutes = 1;
  assert.equal(f.service.render(), '25:00');
  assert.equal(fs.existsSync(f.file), false);
});

test('deadlines use ceil seconds and transition exactly at the boundary without writes', t => {
  const f = fixture(t);
  const started = f.act('start');
  const saved = fs.readFileSync(f.file, 'utf8');
  const stat = fs.statSync(f.file);
  assert.equal(started.endsAt, f.now() + 25 * MINUTE);
  f.advance(25 * MINUTE - 1);
  assert.equal(f.service.render(), '00:01');
  assert.equal(f.service.read().completedSessions, 0);
  f.advance(1);
  const ended = f.service.read();
  assert.equal(ended.phase, 'shortBreak');
  assert.equal(ended.status, 'running');
  assert.equal(ended.remainingMs, 5 * MINUTE);
  assert.equal(ended.endsAt, f.now() + 5 * MINUTE);
  assert.equal(ended.completedSessions, 1);
  assert.equal(ended.revision, started.revision);
  f.advance(5 * MINUTE + 1000000);
  const waiting = f.service.read();
  assert.equal(waiting.phase, 'work');
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.session, 2);
  assert.equal(waiting.remainingMs, 25 * MINUTE);
  assert.equal(waiting.endsAt, null);
  assert.equal(fs.readFileSync(f.file, 'utf8'), saved);
  assert.equal(fs.statSync(f.file).mtimeMs, stat.mtimeMs);
});

test('pause and resume retain milliseconds and exclude paused time across restarts', t => {
  const f = fixture(t);
  f.act('start');
  f.advance(12345);
  const paused = f.act('pause');
  assert.equal(paused.remainingMs, 25 * MINUTE - 12345);
  assert.equal(paused.endsAt, null);
  f.advance(100000000);
  assert.equal(f.restart().read().remainingMs, paused.remainingMs);
  const resumed = f.act('resume');
  assert.equal(resumed.endsAt, f.now() + paused.remainingMs);
  f.advance(paused.remainingMs - 1);
  assert.equal(f.service.read().phase, 'work');
  f.advance(1);
  assert.equal(f.service.read().phase, 'shortBreak');
});

test('all automatic-start combinations stop at the first manual phase', t => {
  for (const autoStartBreaks of [false, true]) {
    for (const autoStartWork of [false, true]) {
      const f = fixture(t);
      f.configure({ workMinutes: 1, shortBreakMinutes: 1, longBreakMinutes: 1,
        autoStartBreaks, autoStartWork });
      f.act('start');
      f.advance(20 * MINUTE);
      const state = f.service.read();
      assert.equal(state.status, autoStartBreaks && autoStartWork ? 'running' : 'waiting');
      assert.equal(state.phase, autoStartBreaks ? 'work' : 'shortBreak');
      assert.equal(state.completedSessions, autoStartBreaks && autoStartWork ? 10 : 1);
      if (state.status === 'waiting') {
        assert.equal(f.act('start').endsAt, f.now() + MINUTE);
      }
    }
  }
});

test('long breaks follow session N and wrap the next work session, including N=1', t => {
  for (const sessionsBeforeLongBreak of [1, 3, 12]) {
    const f = fixture(t);
    f.configure({ workMinutes: 1, shortBreakMinutes: 2, longBreakMinutes: 3,
      sessionsBeforeLongBreak, autoStartWork: true });
    f.act('start');
    for (let session = 1; session <= sessionsBeforeLongBreak; session++) {
      f.advance(MINUTE);
      const state = f.service.read();
      assert.equal(state.phase, session === sessionsBeforeLongBreak ? 'longBreak' : 'shortBreak');
      assert.equal(state.session, session);
      assert.equal(state.completedSessions, session);
      f.advance((session === sessionsBeforeLongBreak ? 3 : 2) * MINUTE);
      assert.equal(f.service.read().phase, 'work');
      assert.equal(f.service.read().session, session % sessionsBeforeLongBreak + 1);
    }
  }
});

test('skip advances the cycle without completing work and preserves a paused state', t => {
  const f = fixture(t);
  f.configure({ sessionsBeforeLongBreak: 2 });
  f.act('start');
  assert.equal(f.act('skip').phase, 'shortBreak');
  const next = f.act('skip');
  assert.equal(next.status, 'waiting');
  assert.equal(next.session, 2);
  const longBreak = f.act('skip');
  assert.equal(longBreak.phase, 'longBreak');
  assert.equal(longBreak.status, 'running');
  f.act('pause');
  const work = f.act('skip');
  assert.equal(work.phase, 'work');
  assert.equal(work.status, 'paused');
  assert.equal(work.session, 1);
  assert.equal(work.completedSessions, 0);
  const shortBreak = f.act('skip');
  assert.equal(shortBreak.status, 'paused');
  assert.equal(shortBreak.phase, 'shortBreak');
  assert.equal(shortBreak.remainingMs, 5 * MINUTE);
});

test('skip honors disabled break auto-start and does not double-count an expired phase', t => {
  const f = fixture(t);
  f.configure({ autoStartBreaks: false, autoStartWork: true });
  f.act('start');
  assert.equal(f.act('skip').status, 'waiting');
  assert.equal(f.act('skip').status, 'running');
  f.advance(25 * MINUTE);
  const next = f.act('skip');
  assert.equal(next.phase, 'work');
  assert.equal(next.session, 3);
  assert.equal(next.completedSessions, 1);
});

test('configuration requires idle and reset clears progress from every status', t => {
  for (const status of ['idle', 'running', 'paused', 'waiting']) {
    const f = fixture(t);
    f.configure({ workMinutes: 10, autoStartBreaks: false });
    if (status !== 'idle') f.act('start');
    if (status === 'paused') f.act('pause');
    if (status === 'waiting') f.advance(10 * MINUTE);
    assert.equal(f.service.read().status, status);
    if (status !== 'idle') rejects(() => f.configure({}), 'pomodoro_state', 409);
    const reset = f.act('reset');
    assert.equal(reset.status, 'idle');
    assert.equal(reset.phase, 'work');
    assert.equal(reset.remainingMs, 10 * MINUTE);
    assert.equal(reset.session, 1);
    assert.equal(reset.completedSessions, 0);
    assert.equal(reset.endsAt, null);
    assert.equal(f.configure({ workMinutes: 240 }).content, '240:00');
  }
});

test('revision rejects duplicate commands and requires a nonnegative safe integer', t => {
  const f = fixture(t);
  for (const revision of [undefined, null, '0', -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    rejects(() => f.service.act('start', revision), 'pomodoro_state', 400);
    rejects(() => f.service.configure(DEFAULTS, revision), 'pomodoro_state', 400);
  }
  const first = f.service.act('start', 0);
  assert.equal(first.revision, 1);
  rejects(() => f.service.act('start', 0), 'pomodoro_conflict', 409);
  const second = f.service.act('skip', 1);
  assert.equal(second.revision, 2);
  rejects(() => f.service.act('skip', 1), 'pomodoro_conflict', 409);
  rejects(() => f.service.configure(DEFAULTS, 1), 'pomodoro_conflict', 409);
  assert.equal(f.service.read().revision, 2);
});

test('invalid actions and state transitions do not write', t => {
  const f = fixture(t);
  for (const action of ['pause', 'resume', 'skip']) rejects(() => f.act(action), 'pomodoro_state', 409);
  for (const action of ['unknown', '__proto__', null, ['start'], {}]) {
    rejects(() => f.act(action), 'pomodoro_state', 400);
  }
  assert.equal(fs.existsSync(f.file), false);
  f.act('start');
  for (const action of ['start', 'resume']) rejects(() => f.act(action), 'pomodoro_state', 409);
  f.act('pause');
  for (const action of ['start', 'pause']) rejects(() => f.act(action), 'pomodoro_state', 409);
  assert.equal(f.service.read().revision, 2);
});

test('large offline intervals skip complete cycles and preserve exact deadlines', { timeout: 1000 }, t => {
  const f = fixture(t);
  f.configure({ workMinutes: 1, shortBreakMinutes: 2, longBreakMinutes: 3,
    sessionsBeforeLongBreak: 3, autoStartWork: true });
  f.act('start');
  const cycles = 1000000000;
  f.advance(cycles * 10 * MINUTE + 2 * MINUTE + 123);
  const state = f.restart().read();
  assert.equal(state.phase, 'shortBreak');
  assert.equal(state.session, 1);
  assert.equal(state.completedSessions, cycles * 3 + 1);
  assert.equal(state.remainingMs, MINUTE - 123);
  assert.equal(state.endsAt, f.now() + MINUTE - 123);
  assert.equal(state.revision, 2);
});

test('catch-up from a partial break anchor agrees with uninterrupted execution', t => {
  const f = fixture(t);
  f.configure({ workMinutes: 1, shortBreakMinutes: 2, longBreakMinutes: 3,
    sessionsBeforeLongBreak: 3, autoStartWork: true });
  f.act('start');
  f.advance(MINUTE + 12345);
  f.act('pause');
  f.act('resume');
  f.advance(100000000 * 10 * MINUTE + 2 * MINUTE);
  const state = f.restart().read();
  assert.equal(state.phase, 'work');
  assert.equal(state.session, 2);
  assert.equal(state.completedSessions, 300000001);
  assert.equal(state.remainingMs, MINUTE - 12345);
});

test('restart restores idle, running, paused and derived waiting snapshots', t => {
  for (const status of ['idle', 'running', 'paused', 'waiting']) {
    const f = fixture(t);
    f.configure({ autoStartBreaks: false });
    if (status !== 'idle') f.act('start');
    if (status === 'paused') {
      f.advance(1234);
      f.act('pause');
    }
    if (status === 'waiting') f.advance(25 * MINUTE);
    assert.equal(f.service.read().status, status);
    assert.deepEqual(f.restart().read(), f.service.read());
  }
});

test('failed atomic persistence preserves both the active anchor and previous file', t => {
  const f = fixture(t);
  f.configure({ workMinutes: 1 });
  const before = f.service.read();
  const saved = fs.readFileSync(f.file, 'utf8');
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('private storage details'); });
  for (const operation of [() => f.act('start'), () => f.configure({ workMinutes: 2 })]) {
    assert.throws(operation, {
      status: 500, code: 'pomodoro_storage', message: 'Pomodoro state could not be loaded or saved.'
    });
    assert.deepEqual(f.service.read(), before);
    assert.equal(fs.readFileSync(f.file, 'utf8'), saved);
    assert.deepEqual(fs.readdirSync(f.directory), ['pomodoro.json']);
  }
  rename.mock.restore();
  assert.equal(f.act('start').revision, before.revision + 1);
});

test('configuration validation rejects missing, unknown and coerced values', t => {
  const f = fixture(t);
  for (const key of Object.keys(DEFAULTS).filter(key => key !== 'template')) {
    const configuration = { ...DEFAULTS };
    delete configuration[key];
    rejects(() => f.service.configure(configuration, 0), 'pomodoro_configuration', 400);
  }
  const invalid = [null, [], {}, { ...DEFAULTS, extra: true }];
  for (const key of ['workMinutes', 'shortBreakMinutes', 'longBreakMinutes', 'sessionsBeforeLongBreak']) {
    for (const value of [0, -1, 1.5, '1', null, true, Infinity, key === 'sessionsBeforeLongBreak' ? 13 : 241]) {
      invalid.push({ ...DEFAULTS, [key]: value });
    }
  }
  for (const key of ['autoStartBreaks', 'autoStartWork']) {
    for (const value of [0, 1, 'false', null]) invalid.push({ ...DEFAULTS, [key]: value });
  }
  for (const configuration of invalid) {
    rejects(() => f.service.configure(configuration, 0), 'pomodoro_configuration', 400);
  }
  const { template, ...configuration } = DEFAULTS;
  assert.equal(f.service.configure(configuration, 0).configuration.template, template);
});

test('templates support every token, ASCII normalization, whitespace and bounded output', t => {
  const f = fixture(t);
  f.configure({ template: 'Técnica\n{{ time }} {{phase}} {{status}} {{session}} {{completed}} ☕' });
  assert.equal(f.service.render(), 'Tecnica 25:00 WORK IDLE 1 0 ');
  assert.equal(f.act('start').content, 'Tecnica 25:00 WORK RUNNING 1 0 ');
  f.advance(25 * MINUTE);
  assert.equal(f.service.render(), 'Tecnica 05:00 BREAK RUNNING 1 1 ');
  assert.match(f.act('pause').content, /BREAK PAUSED/);
  f.act('reset');
  f.configure({ sessionsBeforeLongBreak: 1, autoStartBreaks: false, template: '{{phase}} {{status}}' });
  f.act('start');
  f.advance(25 * MINUTE);
  assert.equal(f.service.render(), 'LONG BREAK READY');
  f.act('reset');
  f.configure({ sessionsBeforeLongBreak: 1, template: '{{phase}}'.repeat(227) });
  f.act('start');
  f.advance(25 * MINUTE);
  assert.equal(f.service.render().length, 2048);
  assert.match(f.service.render(), /^[\x20-\x7e]*$/);
  f.act('reset');
  assert.equal(f.configure({ template: '' }).content, '');
});

test('templates reject malformed placeholders, unsupported variables and oversized inputs', t => {
  const f = fixture(t);
  for (const template of [null, 1, {}, 'a'.repeat(2049), '{{content}}', '{{TIME}}', '{{unknown}}',
    '{{time', 'time}}', '{{{time}}}', '{{time}}}}', '{{time.toString()}}', '{{}}']) {
    rejects(() => f.configure({ template }), 'pomodoro_configuration', 400);
  }
  assert.equal(f.configure({ template: 'a'.repeat(2048) }).content.length, 2048);
});

test('corrupt or inconsistent persisted anchors fail closed with sanitized errors', t => {
  const f = fixture(t);
  f.act('start');
  const valid = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  const invalid = [null, [], {}, { ...valid, secret: 'private' }, { ...valid, configuration: DEFAULTS }];
  delete invalid[4].endsAt;
  for (const [key, values] of Object.entries({
    phase: ['unknown', ['work']], status: ['unknown', ['running']], revision: [-1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1],
    remainingMs: [0, -1, valid.durationMs + 1], durationMs: [1], endsAt: [null, '1', -1, 8640000000000001],
    completedSessions: [-1, 0.5, Number.MAX_SAFE_INTEGER + 1], session: [0, 5]
  })) {
    for (const value of values) invalid.push({ ...valid, [key]: value });
  }
  invalid.push({ ...valid, status: 'paused' }, { ...valid, status: 'waiting', endsAt: null, remainingMs: 1 },
    { ...valid, status: 'idle', endsAt: null, session: 2 },
    { ...valid, phase: 'shortBreak', session: 4, durationMs: 5 * MINUTE, remainingMs: 5 * MINUTE },
    { ...valid, phase: 'longBreak', session: 1, durationMs: 15 * MINUTE, remainingMs: 15 * MINUTE },
    { ...valid, configuration: { ...DEFAULTS, template: '{{private}}' } },
    { ...valid, configuration: { ...DEFAULTS, template: undefined } });
  for (const data of invalid) {
    fs.writeFileSync(f.file, JSON.stringify(data));
    assert.throws(f.restart, {
      code: 'pomodoro_storage', status: 500, message: 'Pomodoro state could not be loaded or saved.'
    });
  }
  fs.writeFileSync(f.file, '{private invalid json');
  rejects(f.restart, 'pomodoro_storage', 500);
  fs.rmSync(f.file);
  fs.mkdirSync(f.file);
  rejects(f.restart, 'pomodoro_storage', 500);
});

test('unsafe clocks, deadline overflow and revision overflow cannot persist invalid state', t => {
  const f = fixture(t);
  for (const timestamp of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER, '0']) {
    f.setTime(timestamp);
    rejects(() => f.service.read(), 'pomodoro_storage', 500);
  }
  f.setTime(8640000000000000);
  rejects(() => f.act('start'), 'pomodoro_storage', 500);
  assert.equal(fs.existsSync(f.file), false);
  f.setTime(0);
  f.act('start');
  const saved = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  saved.revision = Number.MAX_SAFE_INTEGER;
  fs.writeFileSync(f.file, JSON.stringify(saved));
  const restarted = f.restart();
  rejects(() => restarted.act('reset', saved.revision), 'pomodoro_storage', 500);
  assert.equal(restarted.read().status, 'running');
});

test('a backwards clock never expands the remaining time beyond the persisted anchor', t => {
  const f = fixture(t);
  f.act('start');
  f.advance(-MINUTE);
  assert.equal(f.service.read().remainingMs, 25 * MINUTE);
  assert.equal(f.service.read().content, '25:00');
});
