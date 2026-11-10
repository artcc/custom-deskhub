const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MODES = ['text', 'commits', 'weather', 'pomodoro'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateTemplate(template, tokens, defaultTemplate) {
  if (template === undefined) return defaultTemplate;
  if (typeof template !== 'string' || template.length > 2048) {
    throw new Error('Template must be a string of at most 2048 characters.');
  }
  const literal = template.replace(/{{([\s\S]*?)}}/g, (match, token) => {
    if (!tokens.includes(token.trim())) {
      throw new Error('Template contains an unsupported placeholder.');
    }
    return '';
  });
  if (literal.includes('{{') || literal.includes('}}')) {
    throw new Error('Template contains an unsupported placeholder.');
  }
  return template.match(/^{{\s*content\s*}}$/)?.[0] === template ? defaultTemplate : template;
}

function validateRotation(input = { enabled: false, sources: ['text'] }) {
  if (!isObject(input) || typeof input.enabled !== 'boolean' || !Array.isArray(input.sources) ||
      input.sources.some(source => !MODES.includes(source)) ||
      new Set(input.sources).size !== input.sources.length || input.sources.length < (input.enabled ? 2 : 1)) {
    throw new Error('Rotation requires an enabled boolean and unique text, commits, weather or pomodoro sources (at least two when enabled).');
  }
  return { enabled: input.enabled, sources: MODES.filter(source => input.sources.includes(source)) };
}

function selectedSources(settings, { preview = false } = {}) {
  return !preview && settings.rotation.enabled ? settings.rotation.sources : [settings.mode];
}

function validateSettings(input, { preview = false } = {}) {
  if (!isObject(input) || !MODES.includes(input.mode)) {
    throw new Error('Choose text, commits, weather or pomodoro as the display mode.');
  }
  if (typeof input.text !== 'string' || input.text.length > 2048) {
    throw new Error('Text must be a string of at most 2048 characters.');
  }
  const rotation = validateRotation(input.rotation);
  const sources = selectedSources({ mode: input.mode, rotation }, { preview });
  if (!isObject(input.github) || typeof input.github.username !== 'string' ||
      (input.github.showRepositories !== undefined && typeof input.github.showRepositories !== 'boolean')) {
    throw new Error('GitHub settings require a username and an optional showRepositories boolean.');
  }
  const username = input.github.username.trim();
  if (username && (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(username) || username.includes('--'))) {
    throw new Error('Enter a valid GitHub username (up to 39 characters).');
  }
  if (sources.includes('commits') && !username) {
    throw new Error('A GitHub username is required for commits.');
  }
  if (!isObject(input.weather) || typeof input.weather.city !== 'string' ||
      !['metric', 'imperial'].includes(input.weather.units)) {
    throw new Error('Weather settings require a city and metric or imperial units.');
  }
  const city = input.weather.city.trim();
  if (city.length > 100 || /[\x00-\x1f\x7f]/.test(city)) {
    throw new Error('City must contain at most 100 characters without control characters.');
  }
  if (sources.includes('weather') && !city) {
    throw new Error('A city is required for weather.');
  }
  return {
    mode: input.mode,
    text: input.text,
    rotation,
    github: {
      username,
      showRepositories: input.github.showRepositories ?? true,
      template: validateTemplate(input.github.template, ['content', 'commits', 'repositories', 'username'], '{{commits}}')
    },
    weather: {
      city,
      units: input.weather.units,
      template: validateTemplate(input.weather.template, ['content', 'city', 'temperature', 'unit', 'condition'], '{{temperature}} {{unit}}')
    }
  };
}

function loadSettings(file, defaults) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return validateSettings(defaults);
    throw error;
  }
  if (!isObject(data)) throw new Error('Stored display settings must be an object.');
  // Older versions stored only { text }; retain it and default to text mode.
  return validateSettings({
    ...defaults,
    ...data,
    rotation: data.rotation,
    github: { ...defaults.github, ...data.github },
    weather: { ...defaults.weather, ...data.weather }
  });
}

function saveSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporaryFile = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(settings, null, 2), { flag: 'wx', mode: 0o600 });
    // Rename on the same filesystem keeps the previous configuration intact on failure.
    fs.renameSync(temporaryFile, file);
  } finally {
    fs.rmSync(temporaryFile, { force: true });
  }
}

module.exports = { loadSettings, saveSettings, validateSettings, selectedSources, validateTemplate };
