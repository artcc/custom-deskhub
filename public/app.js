import { loadI18n } from './i18n.js';
import { createDevicePanel } from './device.js';
import { createLedPreview } from './led-preview.js';
import { createPomodoroPanel } from './pomodoro.js';

const preferences = navigator.languages?.length ? navigator.languages : [navigator.language];
const { locale, t } = await loadI18n(preferences).catch(error => {
  document.getElementById('locale-error').hidden = false;
  document.getElementById('load-status').hidden = true;
  throw error;
});

document.documentElement.lang = locale;
for (const element of document.querySelectorAll('[data-i18n]')) {
  element.textContent = t(element.dataset.i18n);
}
for (const attribute of ['placeholder', 'aria-label', 'title']) {
  for (const element of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
    element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
  }
}

class PanelError extends Error {}

function errorMessage(error) {
  return error instanceof PanelError ? error.message : t('unexpectedError');
}

const elements = {
  form: document.getElementById('settings-form'),
  fields: document.getElementById('editor-fields'),
  text: document.getElementById('display-text'),
  username: document.getElementById('github-username'),
  githubTemplate: document.getElementById('github-template'),
  city: document.getElementById('weather-city'),
  units: document.getElementById('weather-units'),
  weatherTemplate: document.getElementById('weather-template'),
  rotationEnabled: document.getElementById('rotation-enabled'),
  rotationOptions: document.getElementById('rotation-options'),
  rotationInterval: document.getElementById('rotation-interval'),
  rotationStatus: document.getElementById('rotation-status'),
  save: document.getElementById('save-button'),
  preview: document.getElementById('preview-button'),
  saveState: document.getElementById('save-state'),
  editorStatus: document.getElementById('editor-status'),
  loadStatus: document.getElementById('load-status'),
  retry: document.getElementById('retry-load'),
  previewContent: document.getElementById('preview-content'),
  previewStatus: document.getElementById('preview-status'),
  previewPanel: document.getElementById('preview-panel'),
  liveContent: document.getElementById('live-content'),
  liveStatus: document.getElementById('live-status'),
  liveSource: document.getElementById('live-source'),
  liveSkipped: document.getElementById('live-skipped'),
  livePanel: document.getElementById('live-panel'),
  refresh: document.getElementById('refresh-display'),
  credentialsForm: document.getElementById('credentials-form'),
  credentialsFields: document.getElementById('credentials-fields'),
  githubToken: document.getElementById('github-token'),
  weatherKey: document.getElementById('weather-key'),
  saveCredentials: document.getElementById('save-credentials'),
  removeGithub: document.getElementById('remove-github-key'),
  removeWeather: document.getElementById('remove-weather-key'),
  credentialsStatus: document.getElementById('credentials-status'),
  refreshIntegrations: document.getElementById('refresh-integrations')
};

const templateVariables = {
  github: ['content', 'commits', 'repositories', 'username'],
  weather: ['content', 'city', 'temperature', 'unit', 'condition']
};
const templateDefaults = { github: '{{commits}}', weather: '{{temperature}} {{unit}}' };
const sourceRadios = [...document.querySelectorAll('input[name="mode"]')];
const sourceModes = sourceRadios.map(input => input.value);
const rotationInputs = [...document.querySelectorAll('input[name="rotationSource"]')];
const sourceName = mode => sourceRadios.find(input => input.value === mode).closest('label').querySelector('.source-name').textContent;

function hasInvalidTemplate(input) {
  const variables = templateVariables[input === elements.githubTemplate ? 'github' : 'weather'];
  let invalid = false;
  const remaining = input.value.replace(/{{([\s\S]*?)}}/g, (match, variable) => {
    if (!variables.includes(variable.trim())) invalid = true;
    return '';
  });
  return invalid || remaining.includes('{{') || remaining.includes('}}');
}

function localizeValidation(input) {
  if (typeof input.setCustomValidity !== 'function') return;
  input.setCustomValidity('');
  if (input === elements.githubToken || input === elements.weatherKey) {
    if (input.value.length > 8192 || /\s/.test(input.value)) input.setCustomValidity(t('invalidKey'));
  } else if (input.validity.valueMissing || (input.required && [elements.username, elements.city].includes(input) && !input.value.trim())) {
    input.setCustomValidity(t('requiredField'));
  } else if (input === elements.username && input.validity.patternMismatch) {
    input.setCustomValidity(t('invalidUsername'));
  } else if ([elements.githubTemplate, elements.weatherTemplate].includes(input) && hasInvalidTemplate(input)) {
    input.setCustomValidity(t('invalidTemplateVariable'));
  } else if (input === elements.city && [...input.value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    input.setCustomValidity(t('invalidField'));
  } else if (input === elements.units && !['metric', 'imperial'].includes(input.value)) {
    input.setCustomValidity(t('invalidField'));
  } else if (input.maxLength >= 0 && input.value.length > input.maxLength) {
    input.setCustomValidity(t('tooLong', { limit: input.maxLength }));
  } else if (!input.validity.valid) {
    input.setCustomValidity(t('invalidField'));
  }
}

// Browser validation messages otherwise follow the browser UI language, not our locale.
for (const form of [elements.form, elements.credentialsForm]) {
  form.addEventListener('invalid', (event) => localizeValidation(event.target), true);
  form.addEventListener('input', (event) => localizeValidation(event.target), true);
}

let savedSettings = null;
let settingsKnown = false;
let settingsLoading = false;
let legacyShowRepositories = true;
let capabilities = { github: false, weather: false };
let csrfToken = '';
let saving = false;
let credentialsSaving = false;
let capabilitiesKnown = false;
let revision = 0;
let previewController = null;
let displayController = null;
let rotationIntervalMs = 60000;
const tabNames = ['display', 'integrations', 'pomodoro', 'device'];
let activeTab = tabNames.includes(window.location.hash.slice(1)) ? window.location.hash.slice(1) : 'display';
let devicePanel = null;
let pomodoroPanel = null;
const ledPreview = createLedPreview({ t });

const deviceErrorKeys = {
  device_address: 'deviceAddressError', device_not_configured: 'deviceLinkHint',
  device_incompatible: 'deviceIncompatible', device_unreachable: 'deviceUnreachable',
  device_unconfirmed: 'deviceUnconfirmed', device_busy: 'deviceBusy',
  device_configuration: 'deviceConfigurationError', device_storage: 'deviceStorageError'
};
const pomodoroErrorKeys = {
  pomodoro_configuration: 'pomodoroConfigurationError', pomodoro_conflict: 'pomodoroConflictError',
  pomodoro_state: 'pomodoroStateError', pomodoro_storage: 'pomodoroStorageError'
};

function setMessage(element, message, error = false) {
  element.textContent = message;
  element.classList.toggle('error', error);
}

function readSettings() {
  return {
    mode: document.querySelector('input[name="mode"]:checked').value,
    text: elements.text.value,
    github: { username: elements.username.value, showRepositories: legacyShowRepositories, template: elements.githubTemplate.value },
    weather: { city: elements.city.value, units: elements.units.value, template: elements.weatherTemplate.value },
    rotation: { enabled: elements.rotationEnabled.checked, sources: rotationInputs.filter(input => input.checked).map(input => input.value) }
  };
}

function writeSettings(settings) {
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.checked = radio.value === settings.mode;
  }
  elements.text.value = settings.text;
  elements.username.value = settings.github.username;
  legacyShowRepositories = settings.github.showRepositories ?? true;
  elements.githubTemplate.value = settings.github.template ?? templateDefaults.github;
  elements.city.value = settings.weather.city;
  elements.units.value = settings.weather.units;
  elements.weatherTemplate.value = settings.weather.template ?? templateDefaults.weather;
  elements.rotationEnabled.checked = settings.rotation?.enabled ?? false;
  for (const input of rotationInputs) input.checked = (settings.rotation?.sources ?? ['text']).includes(input.value);
}

function selectedSources(settings = readSettings()) {
  return settings.rotation.enabled ? settings.rotation.sources : [settings.mode];
}

function canSaveSelection() {
  const settings = readSettings();
  return (!settings.rotation.enabled || settings.rotation.sources.length >= 2)
    && selectedSources(settings).every(isAvailable);
}

function validateSources(sources) {
  elements.username.required = sources.includes('commits');
  elements.city.required = sources.includes('weather');
  for (const mode of sourceModes) {
    const fieldset = document.getElementById(`fields-${mode}`);
    fieldset.disabled = false;
    const inputs = [...fieldset.querySelectorAll('input, textarea, select')];
    for (const input of inputs) localizeValidation(input);
    const invalid = inputs.find(input => !input.validity.valid);
    if (invalid) {
      const radio = sourceRadios.find(input => input.value === mode);
      if (!radio.checked) {
        radio.checked = true;
        invalidatePreview();
      }
      updateControls();
      invalid.reportValidity();
      invalid.focus();
      return false;
    }
    fieldset.disabled = mode !== readSettings().mode;
  }
  return true;
}

function updateRotationInterval(value) {
  if (Number.isInteger(value) && value >= 1000 && value <= 86400000) rotationIntervalMs = value;
  elements.rotationInterval.textContent = t('rotationInterval', {
    seconds: new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(rotationIntervalMs / 1000)
  });
}

function isAvailable(mode) {
  return ['text', 'pomodoro'].includes(mode) || (capabilitiesKnown && (mode === 'commits' ? capabilities.github : capabilities.weather));
}

function applyCapabilities(value) {
  if (typeof value?.github !== 'boolean' || typeof value?.weather !== 'boolean') {
    throw new PanelError(t('capabilitiesError'));
  }
  capabilities = { github: value.github, weather: value.weather };
  capabilitiesKnown = true;
}

function isDirty() {
  return savedSettings !== null && (!settingsKnown || JSON.stringify(readSettings()) !== JSON.stringify(savedSettings));
}

function updateControls() {
  const settings = readSettings();
  const { mode, rotation } = settings;
  elements.username.required = selectedSources(settings).includes('commits');
  elements.city.required = selectedSources(settings).includes('weather');
  elements.fields.disabled = !savedSettings || saving || settingsLoading;
  elements.retry.disabled = saving || settingsLoading;
  elements.rotationOptions.hidden = !rotation.enabled;
  document.getElementById('source-picker-title').textContent = t(rotation.enabled ? 'rotationEditSource' : 'contentSource');
  const missingSources = selectedSources(settings).filter(source => !isAvailable(source));
  const rotationProblem = rotation.sources.length < 2 ? t('rotationMinimum')
    : missingSources.length ? t('rotationMissing', { sources: missingSources.map(sourceName).join(', ') }) : '';
  setMessage(elements.rotationStatus, rotationProblem, Boolean(rotationProblem));
  for (const name of sourceModes) {
    const fieldset = document.getElementById(`fields-${name}`);
    fieldset.hidden = name !== mode;
    fieldset.disabled = name !== mode;
  }
  const dirty = isDirty();
  const keysPending = Boolean(elements.githubToken.value || elements.weatherKey.value);
  const keyCount = Number(capabilities.github) + Number(capabilities.weather);
  elements.save.disabled = !savedSettings || saving || settingsLoading || credentialsSaving || !dirty || !canSaveSelection();
  elements.preview.disabled = !savedSettings || saving || settingsLoading || credentialsSaving || previewController !== null || !isAvailable(mode);
  const displayState = t(saving ? 'saving' : !savedSettings ? 'disconnected' : !settingsKnown ? 'unconfirmed' : dirty ? 'unsaved' : 'allSaved');
  const integrationState = credentialsSaving ? t('saving') : keysPending ? t('keysPending')
    : !capabilitiesKnown ? t('unconfirmed') : t('keysSummary', { count: keyCount, total: 2 });
  const utilityPanel = activeTab === 'device' ? devicePanel : activeTab === 'pomodoro' ? pomodoroPanel : null;
  const state = utilityPanel ? utilityPanel.state() : activeTab === 'display' ? displayState : integrationState;
  if (elements.saveState.textContent !== state) elements.saveState.textContent = state;
  elements.saveState.classList.toggle('unsaved', utilityPanel ? Boolean(utilityPanel.dirty()) : activeTab === 'display' ? dirty : keysPending);
  document.getElementById('display-tab-pending').hidden = !dirty;
  document.getElementById('integrations-tab-pending').hidden = !keysPending;
  document.getElementById('integration-count').textContent = capabilitiesKnown ? `${keyCount}/2` : '—';
  document.getElementById('text-count').textContent = t('characterCount', { count: elements.text.value.length, limit: 2048 });
  document.getElementById('github-availability').hidden = !capabilitiesKnown || capabilities.github;
  document.getElementById('weather-availability').hidden = !capabilitiesKnown || capabilities.weather;
  for (const provider of ['github', 'weather']) {
    const status = document.getElementById(`${provider}-key-state`);
    status.textContent = t(!capabilitiesKnown ? 'unconfirmed' : capabilities[provider] ? 'configured' : 'notConfigured');
    status.classList.toggle('configured', capabilitiesKnown && capabilities[provider]);
    document.getElementById(`integration-${provider}`).classList.toggle('has-key', capabilitiesKnown && capabilities[provider]);
  }
  const credentialsDisabled = !savedSettings || saving || settingsLoading || credentialsSaving || !capabilitiesKnown;
  elements.credentialsFields.disabled = credentialsDisabled;
  elements.saveCredentials.disabled = credentialsDisabled || !(elements.githubToken.value || elements.weatherKey.value);
  elements.removeGithub.disabled = credentialsDisabled || !capabilities.github;
  elements.removeWeather.disabled = credentialsDisabled || !capabilities.weather;
  elements.refreshIntegrations.hidden = capabilitiesKnown || !savedSettings;
  elements.refreshIntegrations.disabled = saving || settingsLoading || credentialsSaving;
}

function selectTab(name, { focus = false, history = true } = {}) {
  if (!tabNames.includes(name)) return;
  const hidingFocus = document.getElementById(activeTab).contains(document.activeElement) && name !== activeTab;
  activeTab = name;
  ledPreview.setActive(name === 'display');
  pomodoroPanel?.setActive(name === 'pomodoro');
  for (const tabName of tabNames) {
    const selected = tabName === name;
    const tab = document.getElementById(`tab-${tabName}`);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tabName).hidden = !selected;
  }
  const headings = { display: 'heading', integrations: 'integrationsHeading', device: 'deviceHeading', pomodoro: 'pomodoroHeading' };
  const intros = { display: 'intro', integrations: 'integrationsPageIntro', device: 'devicePageIntro', pomodoro: 'pomodoroPageIntro' };
  document.getElementById('page-title').textContent = t(headings[name]);
  document.getElementById('page-intro').textContent = t(intros[name]);
  if (history && window.location.hash !== `#${name}`) window.history.pushState(null, '', `#${name}`);
  if (focus || hidingFocus) document.getElementById(`tab-${name}`).focus({ preventScroll: true });
  updateControls();
}

async function request(url, options = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, url === '/api/display' ? 30000 : 20000);
  try {
    const response = await fetch(url, {
      ...options,
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken } : {})
      }
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      if (url.startsWith('/api/pomodoro')) {
        const key = response.status === 403 ? 'csrfError' : Object.hasOwn(pomodoroErrorKeys, data?.code) ? pomodoroErrorKeys[data.code] : null;
        throw Object.assign(new PanelError(key ? t(key) : t('requestError', { status: response.status })), { status: response.status });
      }
      if (url.startsWith('/api/device')) {
        const key = response.status === 403 ? 'csrfError' : Object.hasOwn(deviceErrorKeys, data?.code) ? deviceErrorKeys[data.code] : null;
        throw Object.assign(new PanelError(key ? t(key) : t('requestError', { status: response.status })), {
          status: response.status, code: Object.hasOwn(deviceErrorKeys, data?.code) ? data.code : undefined
        });
      }
      // Never expose raw backend/provider errors: they may include credentials.
      if (response.status === 403) throw new PanelError(t('csrfError'));
      if (response.status === 503) throw new PanelError(t('sourceUnavailable'));
      throw new PanelError(t('requestError', { status: response.status }));
    }
    if (!data || typeof data !== 'object') throw new PanelError(t('invalidResponse'));
    return data;
  } catch (error) {
    if (timedOut) throw new PanelError(t('timeoutError'));
    if (error instanceof TypeError) throw new PanelError(t('networkError'));
    throw error;
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}

function invalidatePreview(message = t('previewChanged')) {
  ledPreview.clear();
  revision += 1;
  if (previewController) previewController.abort();
  previewController = null;
  elements.previewPanel.setAttribute('aria-busy', 'false');
  elements.preview.textContent = t('generatePreview');
  elements.previewContent.textContent = t('previewPlaceholder');
  elements.previewContent.classList.add('placeholder');
  setMessage(elements.previewStatus, message);
}

async function loadSettings() {
  if (settingsLoading) return false;
  settingsLoading = true;
  elements.retry.hidden = true;
  elements.form.setAttribute('aria-busy', 'true');
  setMessage(elements.loadStatus, t('loadingSettings'));
  updateControls();
  try {
    const data = await request('/api/settings');
    if (!data.settings || !data.capabilities || typeof data.csrfToken !== 'string') {
      throw new PanelError(t('invalidSettings'));
    }
    applyCapabilities(data.capabilities);
    csrfToken = data.csrfToken;
    void pomodoroPanel.load();
    updateRotationInterval(data.rotationIntervalMs);
    const draft = savedSettings ? readSettings() : null;
    writeSettings(data.settings);
    savedSettings = readSettings();
    settingsKnown = true;
    if (draft) writeSettings(draft);
    else void devicePanel.load();
    setMessage(elements.loadStatus, '');
    if (!selectedSources(savedSettings).every(isAvailable)) {
      setMessage(elements.editorStatus, t('savedSourceUnavailable'), true);
    }
    return true;
  } catch (error) {
    setMessage(elements.loadStatus, errorMessage(error), true);
    elements.retry.hidden = false;
    return false;
  } finally {
    settingsLoading = false;
    elements.form.setAttribute('aria-busy', String(saving));
    updateControls();
  }
}

async function generatePreview() {
  if (!savedSettings || saving || settingsLoading || credentialsSaving || !isAvailable(readSettings().mode) || !validateSources([readSettings().mode])) return;
  const currentRevision = revision;
  const controller = new AbortController();
  previewController = controller;
  elements.previewPanel.setAttribute('aria-busy', 'true');
  elements.preview.textContent = t('generating');
  setMessage(elements.previewStatus, t('queryingPreview'));
  updateControls();
  try {
    const draft = { ...readSettings(), rotation: { enabled: false, sources: [readSettings().mode] } };
    const data = await request('/api/preview', { method: 'POST', body: JSON.stringify(draft), signal: controller.signal });
    if (currentRevision !== revision || controller.signal.aborted) return;
    if (typeof data.content !== 'string') throw new PanelError(t('invalidPreview'));
    elements.previewContent.textContent = data.content || t('emptyText');
    elements.previewContent.classList.toggle('placeholder', !data.content);
    ledPreview.setText(data.content);
    setMessage(elements.previewStatus, elements.rotationEnabled.checked
      ? t('rotationPreviewSource', { source: sourceName(draft.mode) }) : t('previewGenerated'));
  } catch (error) {
    if (currentRevision !== revision || controller.signal.aborted) return;
    elements.previewContent.textContent = t('previewUnavailable');
    elements.previewContent.classList.add('placeholder');
    ledPreview.clear();
    setMessage(elements.previewStatus, errorMessage(error), true);
  } finally {
    if (previewController === controller) {
      previewController = null;
      elements.previewPanel.setAttribute('aria-busy', 'false');
      elements.preview.textContent = t('generatePreview');
      updateControls();
    }
  }
}

async function refreshDisplay() {
  if (displayController) displayController.abort();
  const controller = new AbortController();
  displayController = controller;
  elements.refresh.disabled = true;
  elements.refresh.textContent = t('querying');
  elements.livePanel.setAttribute('aria-busy', 'true');
  setMessage(elements.liveStatus, t('queryingSaved'));
  elements.liveSource.hidden = elements.liveSkipped.hidden = true;
  try {
    const data = await request('/api/display', { signal: controller.signal });
    if (controller.signal.aborted) return;
    if (typeof data.content !== 'string' || !sourceModes.includes(data.mode) ||
        !Array.isArray(data.skippedSources) || data.skippedSources.some(source => !sourceModes.includes(source))) {
      throw new PanelError(t('invalidContent'));
    }
    elements.liveContent.textContent = data.content || t('emptyText');
    elements.liveContent.classList.toggle('placeholder', !data.content);
    const time = new Date().toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setMessage(elements.liveStatus, t('lastChecked', { time }));
    elements.liveSource.textContent = t('liveSource', { source: sourceName(data.mode) });
    elements.liveSource.hidden = false;
    elements.liveSkipped.hidden = data.skippedSources.length === 0;
    setMessage(elements.liveSkipped, data.skippedSources.length
      ? t('rotationSkipped', { sources: data.skippedSources.map(sourceName).join(', ') }) : '', true);
  } catch (error) {
    if (controller.signal.aborted) return;
    elements.liveContent.textContent = t('contentUnavailable');
    elements.liveContent.classList.add('placeholder');
    setMessage(elements.liveStatus, errorMessage(error), true);
  } finally {
    if (displayController === controller) {
      displayController = null;
      elements.refresh.disabled = false;
      elements.refresh.textContent = t('refresh');
      elements.livePanel.setAttribute('aria-busy', 'false');
    }
  }
}

elements.form.addEventListener('input', event => {
  if (event.target === elements.rotationEnabled && !elements.rotationEnabled.checked && !rotationInputs.some(input => input.checked)) {
    rotationInputs.find(input => input.value === readSettings().mode).checked = true;
  }
  invalidatePreview();
  setMessage(elements.editorStatus, '');
  updateControls();
});

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!savedSettings || saving || settingsLoading || credentialsSaving || !isDirty() || !canSaveSelection() || !validateSources(selectedSources())) return;
  const settings = readSettings();
  saving = true;
  elements.fields.disabled = true;
  elements.form.setAttribute('aria-busy', 'true');
  elements.save.textContent = t('saving');
  setMessage(elements.editorStatus, t('savingSettings'));
  updateControls();
  try {
    const data = await request('/api/settings', { method: 'PUT', body: JSON.stringify(settings) });
    if (!data.settings) throw new PanelError(t('saveUnconfirmed'));
    writeSettings(data.settings);
    savedSettings = readSettings();
    settingsKnown = true;
    elements.retry.hidden = true;
    setMessage(elements.loadStatus, '');
    if (JSON.stringify(settings) !== JSON.stringify(savedSettings)) invalidatePreview();
    setMessage(elements.editorStatus, t('settingsSaved'));
    void refreshDisplay();
  } catch (error) {
    settingsKnown = false;
    const reconciled = await loadSettings();
    setMessage(elements.editorStatus, t(reconciled ? 'settingsReconciled' : 'settingsKept', { error: errorMessage(error) }), true);
  } finally {
    saving = false;
    elements.fields.disabled = false;
    elements.form.setAttribute('aria-busy', 'false');
    elements.save.textContent = t('saveChanges');
    updateControls();
  }
});

async function updateCredentials(payload) {
  if (!savedSettings || saving || settingsLoading || credentialsSaving || !capabilitiesKnown) return;
  credentialsSaving = true;
  elements.credentialsForm.setAttribute('aria-busy', 'true');
  elements.saveCredentials.textContent = t('saving');
  invalidatePreview(t('integrationsUpdating'));
  setMessage(elements.credentialsStatus, t('updatingKeys'));
  updateControls();
  try {
    const data = await request('/api/credentials', { method: 'PUT', body: JSON.stringify(payload) });
    applyCapabilities(data.capabilities);
    elements.githubToken.value = '';
    elements.weatherKey.value = '';
    elements.githubToken.setCustomValidity('');
    elements.weatherKey.setCustomValidity('');
    setMessage(elements.credentialsStatus, t('integrationsUpdated'));
    setMessage(elements.editorStatus, isAvailable(readSettings().mode) ? '' : t('selectedSourceUnavailable'), !isAvailable(readSettings().mode));
    invalidatePreview(t('integrationsChanged'));
    void refreshDisplay();
  } catch (error) {
    // A lost response does not establish whether the server persisted the write.
    capabilitiesKnown = false;
    setMessage(elements.credentialsStatus, t('credentialsUnconfirmed', { error: errorMessage(error) }), true);
    setMessage(elements.previewStatus, t('checkBeforePreview'));
  } finally {
    credentialsSaving = false;
    elements.credentialsForm.setAttribute('aria-busy', 'false');
    elements.saveCredentials.textContent = t('saveCredentials');
    updateControls();
  }
}

elements.credentialsForm.addEventListener('input', () => {
  updateControls();
});

elements.credentialsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!elements.credentialsForm.reportValidity()) return;
  const payload = {};
  if (elements.githubToken.value) payload.githubToken = elements.githubToken.value;
  if (elements.weatherKey.value) payload.weatherKey = elements.weatherKey.value;
  if (!Object.keys(payload).length) {
    setMessage(elements.credentialsStatus, t('enterKey'), true);
    return;
  }
  void updateCredentials(payload);
});

function removeCredential(provider, key) {
  if (saving || settingsLoading || credentialsSaving || !capabilitiesKnown || !capabilities[provider]) return;
  const name = provider === 'github' ? 'GitHub' : 'OpenWeatherMap';
  if (!window.confirm(t('confirmRemoval', { name }))) return;
  void updateCredentials({ [key]: '' });
}

elements.removeGithub.addEventListener('click', () => removeCredential('github', 'githubToken'));
elements.removeWeather.addEventListener('click', () => removeCredential('weather', 'weatherKey'));
elements.refreshIntegrations.addEventListener('click', async () => {
  if (saving || settingsLoading || credentialsSaving) return;
  credentialsSaving = true;
  elements.credentialsForm.setAttribute('aria-busy', 'true');
  setMessage(elements.credentialsStatus, t('checkingIntegrations'));
  updateControls();
  try {
    const data = await request('/api/settings');
    if (typeof data.csrfToken !== 'string') throw new PanelError(t('missingCsrf'));
    applyCapabilities(data.capabilities);
    csrfToken = data.csrfToken;
    updateRotationInterval(data.rotationIntervalMs);
    setMessage(elements.credentialsStatus, t('integrationsChecked'));
    void refreshDisplay();
  } catch (error) {
    setMessage(elements.credentialsStatus, errorMessage(error), true);
  } finally {
    credentialsSaving = false;
    elements.credentialsForm.setAttribute('aria-busy', 'false');
    updateControls();
  }
});

elements.preview.addEventListener('click', generatePreview);
elements.refresh.addEventListener('click', refreshDisplay);
elements.retry.addEventListener('click', loadSettings);

for (const button of document.querySelectorAll('[data-template], [data-reset-template]')) {
  if (button.dataset.variable) button.setAttribute('aria-label', t('insertVariable', { variable: `{{${button.dataset.variable}}}` }));
  button.addEventListener('click', () => {
    const provider = button.dataset.template || button.dataset.resetTemplate;
    const input = provider === 'github' ? elements.githubTemplate : elements.weatherTemplate;
    if (input.matches(':disabled')) return;
    if (button.dataset.resetTemplate) {
      input.value = templateDefaults[provider];
    } else {
      const variable = `{{${button.dataset.variable}}}`;
      if (input.value.length - (input.selectionEnd - input.selectionStart) + variable.length > input.maxLength) {
        setMessage(elements.editorStatus, t('tooLong', { limit: input.maxLength }), true);
        input.focus();
        return;
      }
      input.setRangeText(variable, input.selectionStart, input.selectionEnd, 'end');
    }
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

for (const name of tabNames) {
  const tab = document.getElementById(`tab-${name}`);
  tab.addEventListener('click', () => selectTab(name, { focus: true }));
  tab.addEventListener('keydown', event => {
    const index = tabNames.indexOf(name);
    const next = { ArrowRight: (index + 1) % tabNames.length, ArrowLeft: (index + tabNames.length - 1) % tabNames.length, Home: 0, End: tabNames.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectTab(tabNames[next], { focus: true });
  });
}
for (const link of document.querySelectorAll('[data-provider], [data-navigate]')) {
  link.addEventListener('click', event => {
    event.preventDefault();
    const provider = link.dataset.provider;
    selectTab(provider ? 'integrations' : link.dataset.navigate, { focus: true });
    if (provider) {
      const field = provider === 'github' ? elements.githubToken : elements.weatherKey;
      const target = elements.credentialsFields.disabled ? document.getElementById(`integration-${provider}`) : field;
      target.focus();
    }
  });
}
function restoreTab() {
  const name = window.location.hash.slice(1);
  if (tabNames.includes(name)) selectTab(name, { history: false });
  else if (!name) selectTab('display', { history: false });
}
window.addEventListener('popstate', restoreTab);
window.addEventListener('hashchange', restoreTab);
if (!window.location.hash) window.history.replaceState(null, '', `#${activeTab}`);
devicePanel = createDevicePanel({ t, locale, request, onChange: updateControls, onDeviceSaved: device => {
  updateRotationInterval(device.lastSentAt ? device.configuration.fetchRate : 60000);
} });
pomodoroPanel = createPomodoroPanel({ t, request, onChange: updateControls });
updateRotationInterval(rotationIntervalMs);
selectTab(activeTab, { history: false });

document.getElementById('device-url').textContent = `${window.location.origin}/display`;
document.getElementById('text-count').textContent = t('characterCount', { count: elements.text.value.length, limit: 2048 });

void loadSettings();
void refreshDisplay();
