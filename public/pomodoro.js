export function createPomodoroPanel({ t, request, onChange }) {
  const byId = id => document.getElementById(id);
  const form = byId('pomodoro-settings-form');
  const fields = Object.fromEntries([...form.querySelectorAll('[name]')].map(input => [input.name, input]));
  const actions = [...document.querySelectorAll('[data-pomodoro-action]')];
  const variables = ['time', 'phase', 'status', 'session', 'completed'];
  const phaseKeys = { work: 'pomodoroWork', shortBreak: 'pomodoroShortBreak', longBreak: 'pomodoroLongBreak' };
  const statusKeys = { idle: 'pomodoroIdle', running: 'pomodoroRunning', paused: 'pomodoroPaused', waiting: 'pomodoroWaiting' };
  let saved = null;
  let known = false;
  let initialized = false;
  let active = false;
  let busy = false;
  let writing = false;
  let receivedAt = 0;
  let poll = null;
  let ticker = null;

  function message(text, error = false) {
    byId('pomodoro-feedback').textContent = text;
    byId('pomodoro-feedback').classList.toggle('error', error);
  }

  function configuration() {
    return Object.fromEntries(Object.entries(fields).map(([name, input]) => [name,
      input.type === 'checkbox' ? input.checked : input.type === 'number' ? input.valueAsNumber : input.value
    ]));
  }

  function dirty() {
    return saved !== null && Object.entries(configuration()).some(([name, value]) => value !== saved.configuration[name]);
  }

  function state() {
    return t(!known ? 'unconfirmed' : dirty() ? 'unsaved' : statusKeys[saved.status]);
  }

  function remaining() {
    return Math.max(0, saved.remainingMs - (saved.status === 'running' ? performance.now() - receivedAt : 0));
  }

  function renderTime() {
    const seconds = known ? Math.ceil(remaining() / 1000) : null;
    const text = seconds === null ? '—' : `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    if (byId('pomodoro-counter').textContent !== text) byId('pomodoro-counter').textContent = text;
  }

  function allowed(action) {
    if (!known || !saved) return false;
    const status = saved.status;
    if (action === 'start') return status === 'idle' || status === 'waiting';
    if (action === 'pause') return status === 'running';
    if (action === 'resume') return status === 'paused';
    if (action === 'skip') return status !== 'idle';
    return action === 'reset' && (status !== 'idle' || saved.completedSessions > 0);
  }

  function update() {
    byId('pomodoro-settings-fields').disabled = writing || !known || saved.status !== 'idle';
    byId('pomodoro-save').disabled = busy || !known || saved.status !== 'idle' || !dirty();
    byId('pomodoro-refresh').disabled = busy || !initialized;
    byId('pomodoro-refresh').textContent = t(known ? 'refresh' : 'retry');
    byId('pomodoro-tab-pending').hidden = !dirty();
    byId('pomodoro-draft-hint').hidden = !dirty();
    form.setAttribute('aria-busy', String(busy));
    for (const button of actions) {
      const action = button.dataset.pomodoroAction;
      button.hidden = !['start', 'reset'].includes(action) && !allowed(action);
      if (action === 'start') button.hidden = known && !allowed(action);
      button.disabled = busy || !initialized || !allowed(action);
    }
    const phase = known ? t(phaseKeys[saved.phase]) : '';
    const status = t(known ? statusKeys[saved.status] : 'unconfirmed');
    if (byId('pomodoro-phase').textContent !== phase) byId('pomodoro-phase').textContent = phase;
    if (byId('pomodoro-run-status').textContent !== status) byId('pomodoro-run-status').textContent = status;
    byId('pomodoro-sessions').textContent = known ? t('pomodoroSessionSummary', {
      session: saved.session, total: saved.configuration.sessionsBeforeLongBreak, completed: saved.completedSessions
    }) : '';
    byId('pomodoro-output').textContent = known ? saved.content || t('emptyText') : '—';
    byId('pomodoro-output').classList.toggle('placeholder', !known || !saved.content);
    renderTime();
    onChange();
  }

  function invalidTemplate(value) {
    let invalid = false;
    const rest = value.replace(/{{([\s\S]*?)}}/g, (match, variable) => {
      if (!variables.includes(variable.trim())) invalid = true;
      return '';
    });
    return invalid || rest.includes('{{') || rest.includes('}}');
  }

  function validConfiguration(value) {
    return value && ['workMinutes', 'shortBreakMinutes', 'longBreakMinutes', 'sessionsBeforeLongBreak'].every(name =>
      Number.isInteger(value[name]) && value[name] >= 1 && value[name] <= (name === 'sessionsBeforeLongBreak' ? 12 : 240))
      && typeof value.autoStartBreaks === 'boolean' && typeof value.autoStartWork === 'boolean'
      && typeof value.template === 'string' && value.template.length <= 2048 && !invalidTemplate(value.template);
  }

  function accept(data, replaceDraft = false) {
    const value = data?.pomodoro;
    if (!value || !validConfiguration(value.configuration) || !Object.hasOwn(phaseKeys, value.phase)
      || !Object.hasOwn(statusKeys, value.status) || !Number.isFinite(value.remainingMs) || value.remainingMs < 0
      || !Number.isFinite(value.durationMs) || value.durationMs <= 0 || value.remainingMs > value.durationMs
      || !Number.isFinite(value.serverNow) || !(value.endsAt === null || Number.isFinite(value.endsAt))
      || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !Number.isSafeInteger(value.completedSessions) || value.completedSessions < 0
      || !Number.isInteger(value.session) || value.session < 1 || value.session > value.configuration.sessionsBeforeLongBreak
      || typeof value.content !== 'string') {
      throw new Error(t('invalidResponse'));
    }
    const keepDraft = saved && dirty() && !replaceDraft;
    saved = value;
    receivedAt = performance.now();
    known = true;
    if (!keepDraft) {
      for (const [name, input] of Object.entries(fields)) {
        if (input.type === 'checkbox') input.checked = saved.configuration[name];
        else input.value = saved.configuration[name];
        input.setCustomValidity('');
      }
    }
  }

  // Only errors crossing the shared request boundary carry user-facing messages.
  async function receive(url, options, replaceDraft = false) {
    let data;
    try {
      data = await request(url, options);
    } catch (error) {
      throw Object.assign(new Error(error.message || t('unexpectedError')), { status: error.status });
    }
    try {
      accept(data, replaceDraft);
    } catch {
      throw new Error(t('invalidResponse'));
    }
  }

  function stopTimers() {
    window.clearTimeout(poll);
    window.clearInterval(ticker);
    poll = ticker = null;
  }

  function schedule() {
    stopTimers();
    if (!active || document.hidden || !initialized || !known) return;
    renderTime();
    ticker = window.setInterval(renderTime, 250);
    if (!busy) {
      const delay = saved.status === 'running' ? Math.min(5000, Math.max(250, remaining())) : 5000;
      poll = window.setTimeout(() => void refresh(true), delay);
    }
  }

  async function refresh(silent = false) {
    if (busy || !initialized) return;
    busy = true;
    stopTimers();
    if (!silent) message(t('pomodoroLoading'));
    update();
    schedule();
    try {
      await receive('/api/pomodoro');
      if (!silent) message(t('pomodoroChecked'));
    } catch (error) {
      known = false;
      message(`${error.message} ${t('pomodoroRefreshRequired')}`, true);
    } finally {
      busy = false;
      update();
      schedule();
    }
  }

  async function write(action) {
    if (busy || !initialized || !known || (action ? !allowed(action) : saved.status !== 'idle' || !dirty())) return;
    if (action === 'reset' && !window.confirm(t('pomodoroConfirmReset'))) return;
    const payload = action ? { action, revision: saved.revision } : { configuration: configuration(), revision: saved.revision };
    busy = true;
    writing = true;
    stopTimers();
    message(t('pomodoroWorking'));
    update();
    schedule();
    try {
      await receive(action ? '/api/pomodoro/actions' : '/api/pomodoro', {
        method: action ? 'POST' : 'PUT', body: JSON.stringify(payload)
      }, !action);
      message(t(action ? 'pomodoroActionApplied' : 'pomodoroConfigurationSaved'));
    } catch (error) {
      known = false;
      const uncertain = !error.status || error.status >= 500;
      const explanation = uncertain ? t('pomodoroMayHaveApplied') : '';
      try {
        // Reconcile state once; never repeat a possibly applied command.
        await receive('/api/pomodoro');
        message(`${error.message} ${explanation} ${t('pomodoroReconciled')}`, true);
      } catch {
        known = false;
        message(`${error.message} ${explanation} ${t('pomodoroRefreshRequired')}`, true);
      }
    } finally {
      writing = false;
      busy = false;
      update();
      schedule();
    }
  }

  function validate(input) {
    input.setCustomValidity('');
    if (input.validity.valueMissing) input.setCustomValidity(t('requiredField'));
    else if (input.type === 'number' && (!Number.isInteger(input.valueAsNumber)
      || input.valueAsNumber < Number(input.min) || input.valueAsNumber > Number(input.max))) {
      input.setCustomValidity(t('deviceNumberError', { min: input.min, max: input.max }));
    } else if (input === fields.template && input.value.length > 2048) input.setCustomValidity(t('tooLong', { limit: 2048 }));
    else if (input === fields.template && invalidTemplate(input.value)) input.setCustomValidity(t('invalidTemplateVariable'));
    else if (!input.validity.valid) input.setCustomValidity(t('invalidField'));
  }

  form.addEventListener('input', event => {
    if (typeof event.target.setCustomValidity === 'function') validate(event.target);
    update();
  });
  form.addEventListener('invalid', event => validate(event.target), true);
  form.addEventListener('submit', event => {
    event.preventDefault();
    for (const input of Object.values(fields)) validate(input);
    if (form.reportValidity()) void write();
  });
  for (const button of actions) button.addEventListener('click', () => void write(button.dataset.pomodoroAction));
  for (const button of form.querySelectorAll('[data-pomodoro-variable], [data-pomodoro-reset-template]')) {
    const variable = button.dataset.pomodoroVariable;
    if (variable) button.setAttribute('aria-label', t('insertVariable', { variable: `{{${variable}}}` }));
    button.addEventListener('click', () => {
      const input = fields.template;
      if (input.matches(':disabled')) return;
      if (!variable) input.value = '{{time}}';
      else {
        const text = `{{${variable}}}`;
        if (input.value.length - (input.selectionEnd - input.selectionStart) + text.length > input.maxLength) {
          message(t('tooLong', { limit: input.maxLength }), true);
          input.focus();
          return;
        }
        input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
      }
      input.focus();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function setActive(value) {
    const changed = active !== value;
    active = value;
    schedule();
    if (changed && active && !document.hidden && initialized) void refresh(true);
  }

  async function load() {
    initialized = true;
    await refresh();
  }

  byId('pomodoro-refresh').addEventListener('click', () => void refresh());
  document.addEventListener('visibilitychange', () => {
    schedule();
    if (active && !document.hidden && initialized) void refresh(true);
  });

  return { load, setActive, state, dirty };
}
