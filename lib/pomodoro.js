const fs = require('node:fs');
const path = require('node:path');
const { saveSettings, validateTemplate } = require('./settings');
const { displayText } = require('./content');

const DEFAULT_CONFIGURATION = Object.freeze({
  workMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  sessionsBeforeLongBreak: 4,
  autoStartBreaks: true,
  autoStartWork: false,
  template: '{{time}}'
});
const PHASES = { work: 'WORK', shortBreak: 'BREAK', longBreak: 'LONG BREAK' };
const STATUSES = { idle: 'IDLE', running: 'RUNNING', paused: 'PAUSED', waiting: 'READY' };
const MAX_TIMESTAMP = 8640000000000000;
const ANCHOR_KEYS = ['configuration', 'phase', 'status', 'remainingMs', 'durationMs',
  'endsAt', 'completedSessions', 'session', 'revision'];

function failure(code, status) {
  const messages = {
    pomodoro_configuration: 'Invalid Pomodoro configuration.',
    pomodoro_conflict: 'Pomodoro revision is stale. Refresh before retrying.',
    pomodoro_state: 'Invalid Pomodoro action or state.',
    pomodoro_storage: 'Pomodoro state could not be loaded or saved.'
  };
  return Object.assign(new Error(messages[code]), { status, code });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validateConfiguration(input, { persisted = false } = {}) {
  const keys = Object.keys(DEFAULT_CONFIGURATION);
  if (!isObject(input) || Object.keys(input).some(key => !keys.includes(key)) ||
      keys.some(key => (key !== 'template' || persisted) && !Object.hasOwn(input, key)) ||
      !['workMinutes', 'shortBreakMinutes', 'longBreakMinutes'].every(key => integer(input[key], 1, 240)) ||
      !integer(input.sessionsBeforeLongBreak, 1, 12) ||
      typeof input.autoStartBreaks !== 'boolean' || typeof input.autoStartWork !== 'boolean') {
    throw failure('pomodoro_configuration', 400);
  }
  let template;
  try {
    template = validateTemplate(input.template, ['time', 'phase', 'status', 'session', 'completed'], '{{time}}');
  } catch {
    throw failure('pomodoro_configuration', 400);
  }
  return { ...input, template };
}

function duration(configuration, phase) {
  return configuration[`${phase}Minutes`] * 60000;
}

function idle(configuration, revision = 0) {
  const durationMs = duration(configuration, 'work');
  return { configuration, phase: 'work', status: 'idle', remainingMs: durationMs,
    durationMs, endsAt: null, completedSessions: 0, session: 1, revision };
}

function validateAnchor(input) {
  if (!isObject(input) || Object.keys(input).length !== ANCHOR_KEYS.length ||
      ANCHOR_KEYS.some(key => !Object.hasOwn(input, key))) {
    throw failure('pomodoro_storage', 500);
  }
  const configuration = validateConfiguration(input.configuration, { persisted: true });
  if (typeof input.phase !== 'string' || !Object.hasOwn(PHASES, input.phase) ||
      typeof input.status !== 'string' || !Object.hasOwn(STATUSES, input.status) ||
      !integer(input.revision, 0) || !integer(input.completedSessions, 0) ||
      !integer(input.session, 1, configuration.sessionsBeforeLongBreak) ||
      input.durationMs !== duration(configuration, input.phase) ||
      !integer(input.remainingMs, 1, input.durationMs) ||
      (input.status === 'running'
        ? !integer(input.endsAt, input.remainingMs, MAX_TIMESTAMP)
        : input.endsAt !== null) ||
      (['idle', 'waiting'].includes(input.status) && input.remainingMs !== input.durationMs) ||
      (input.status === 'idle' && (input.phase !== 'work' || input.session !== 1 || input.completedSessions !== 0)) ||
      (input.phase === 'shortBreak' && input.session === configuration.sessionsBeforeLongBreak) ||
      (input.phase === 'longBreak' && input.session !== configuration.sessionsBeforeLongBreak)) {
    throw failure('pomodoro_storage', 500);
  }
  return { ...input, configuration };
}

function checkedAdd(value, increment, maximum = Number.MAX_SAFE_INTEGER) {
  const result = value + increment;
  if (!integer(result, 0, maximum)) throw failure('pomodoro_storage', 500);
  return result;
}

function advance(state, timestamp, { skipped = false } = {}) {
  const { configuration } = state;
  const wasPaused = state.status === 'paused';
  if (state.phase === 'work') {
    if (!skipped) state.completedSessions = checkedAdd(state.completedSessions, 1);
    state.phase = state.session === configuration.sessionsBeforeLongBreak ? 'longBreak' : 'shortBreak';
  } else {
    state.phase = 'work';
    state.session = state.session % configuration.sessionsBeforeLongBreak + 1;
  }
  state.durationMs = duration(configuration, state.phase);
  state.remainingMs = state.durationMs;
  const autoStart = state.phase === 'work' ? configuration.autoStartWork : configuration.autoStartBreaks;
  state.status = wasPaused ? 'paused' : autoStart ? 'running' : 'waiting';
  state.endsAt = state.status === 'running' ? checkedAdd(timestamp, state.durationMs, MAX_TIMESTAMP) : null;
}

function derive(anchor, timestamp) {
  const state = { ...anchor, configuration: { ...anchor.configuration } };
  if (state.status !== 'running') return state;
  const config = state.configuration;
  if (config.autoStartWork && config.autoStartBreaks && timestamp >= state.endsAt) {
    // A full cycle returns to the same phase/session, regardless of the anchor phase.
    const cycleMs = config.sessionsBeforeLongBreak * duration(config, 'work') +
      (config.sessionsBeforeLongBreak - 1) * duration(config, 'shortBreak') + duration(config, 'longBreak');
    const cycles = Math.floor((timestamp - state.endsAt) / cycleMs);
    state.completedSessions = checkedAdd(state.completedSessions, cycles * config.sessionsBeforeLongBreak);
    state.endsAt = checkedAdd(state.endsAt, cycles * cycleMs, MAX_TIMESTAMP);
  }
  while (state.status === 'running' && timestamp >= state.endsAt) advance(state, state.endsAt);
  if (state.status === 'running') state.remainingMs = Math.min(state.remainingMs, state.endsAt - timestamp);
  return state;
}

function snapshot(state, serverNow) {
  const seconds = Math.ceil(state.remainingMs / 1000);
  const values = {
    time: `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`,
    phase: PHASES[state.phase], status: STATUSES[state.status],
    session: state.session, completed: state.completedSessions
  };
  const content = displayText(state.configuration.template.replace(/{{([\s\S]*?)}}/g,
    (match, token) => values[token.trim()])).slice(0, 2048);
  return { ...state, serverNow, content };
}

function createPomodoroService(dataFile, { now = Date.now } = {}) {
  const file = path.join(path.dirname(dataFile), 'pomodoro.json');
  let anchor;
  try {
    anchor = validateAnchor(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw failure('pomodoro_storage', 500);
    anchor = idle({ ...DEFAULT_CONFIGURATION });
  }

  function timestamp() {
    const value = now();
    if (!integer(value, 0, MAX_TIMESTAMP)) throw failure('pomodoro_storage', 500);
    return value;
  }

  function read() {
    const serverNow = timestamp();
    return snapshot(derive(anchor, serverNow), serverNow);
  }

  function checkRevision(revision) {
    if (!integer(revision, 0)) throw failure('pomodoro_state', 400);
    if (revision !== anchor.revision) throw failure('pomodoro_conflict', 409);
  }

  function commit(state, serverNow) {
    state.revision = checkedAdd(anchor.revision, 1);
    try {
      const validated = validateAnchor(state);
      saveSettings(file, validated);
      anchor = validated;
    } catch {
      throw failure('pomodoro_storage', 500);
    }
    return snapshot({ ...anchor, configuration: { ...anchor.configuration } }, serverNow);
  }

  function configure(configuration, revision) {
    checkRevision(revision);
    const serverNow = timestamp();
    if (derive(anchor, serverNow).status !== 'idle') throw failure('pomodoro_state', 409);
    return commit(idle(validateConfiguration(configuration)), serverNow);
  }

  function act(action, revision) {
    checkRevision(revision);
    const serverNow = timestamp();
    const state = derive(anchor, serverNow);
    if (action === 'reset') return commit(idle(state.configuration), serverNow);
    const allowed = { start: ['idle', 'waiting'], pause: ['running'], resume: ['paused'],
      skip: ['running', 'paused', 'waiting'] };
    if (typeof action !== 'string' || !Object.hasOwn(allowed, action)) throw failure('pomodoro_state', 400);
    if (!allowed[action].includes(state.status)) throw failure('pomodoro_state', 409);
    if (action === 'skip') {
      advance(state, serverNow, { skipped: true });
    } else if (action === 'pause') {
      state.status = 'paused';
      state.endsAt = null;
    } else {
      state.status = 'running';
      state.endsAt = checkedAdd(serverNow, state.remainingMs, MAX_TIMESTAMP);
    }
    return commit(state, serverNow);
  }

  return { read, configure, act, render: () => read().content };
}

module.exports = { createPomodoroService };
