const express = require('express');
const cors = require('cors');
const path = require('node:path');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const { loadSettings, saveSettings, validateSettings } = require('./lib/settings');
const { createContentService, displayText } = require('./lib/content');
const { createCredentialStore, validateCredentials } = require('./lib/credentials');
const { createDeviceService } = require('./lib/device');

const requiredEnvVars = ['PORT', 'LOCALHOST'];
const missingVars = requiredEnvVars.filter(name => !process.env[name]);
if (missingVars.length) {
  console.error(`Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

const PORT = process.env.PORT;
const LOCALHOST = process.env.LOCALHOST;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const csrfToken = randomBytes(32).toString('hex');
const credentialStore = createCredentialStore(DATA_FILE);
const defaults = {
  mode: 'text',
  text: '',
  github: { username: '', showRepositories: true, template: '{{commits}}' },
  weather: { city: '', units: 'metric', template: '{{temperature}} {{unit}}' }
};

let settings;
let credentials;
let device;
try {
  settings = loadSettings(DATA_FILE, defaults);
  credentials = credentialStore.load();
  device = createDeviceService(DATA_FILE);
} catch (error) {
  console.error('[ERROR] Failed to load display settings:', error.message);
  process.exit(1);
}
let content = createContentService(credentials);

function capabilities() {
  return { github: Boolean(credentials.githubToken), weather: Boolean(credentials.weatherKey) };
}

const app = express();
app.disable('x-powered-by');
// Preserve the original query parsing for legacy /setDisplay callers.
app.set('query parser', 'extended');
app.use((req, res, next) => {
  const client = req.socket.remoteAddress;
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} status=${res.statusCode} client=${client}`);
  });
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

function equalSecret(received, expected) {
  const hash = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(received), hash(expected));
}

function requireCSRF(req, res, next) {
  if (!equalSecret(req.get('x-csrf-token') || '', csrfToken)) {
    return res.status(403).json({ error: 'Invalid CSRF token. Reload the control panel and try again.' });
  }
  next();
}

function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

function readSelection(input) {
  const selection = validateSettings(input);
  if (selection.mode === 'commits' && !capabilities().github) {
    throw Object.assign(new Error('Configure a GitHub token in the Integrations section.'), { status: 503 });
  }
  if (selection.mode === 'weather' && !capabilities().weather) {
    throw Object.assign(new Error('Configure an OpenWeatherMap key in the Integrations section.'), { status: 503 });
  }
  return selection;
}

function persist(selection) {
  saveSettings(DATA_FILE, selection);
  settings = selection;
}

// Health is independent of external providers and of the selected display content.
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
app.options(['/display', '/commits', '/weather'], cors());
app.get('/display', cors(), noStore, async (req, res) => {
  res.json({ content: await content.render(settings) });
});
app.get('/commits', cors(), noStore, async (req, res) => {
  res.json({ content: await content.commits(settings.github) });
});
app.get('/weather', cors(), noStore, async (req, res) => {
  res.json({ content: await content.weather(settings.weather) });
});

app.get('/setDisplay', noStore, requireCSRF, (req, res) => {
  if (req.query.text === undefined || req.query.text === null) {
    return res.status(400).json({ error: 'Missing required parameter: text' });
  }
  let selection;
  try {
    selection = validateSettings({ ...settings, mode: 'text', text: req.query.text });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    persist(selection);
  } catch {
    console.error('[ERROR] Failed to save display text.');
    return res.status(500).json({ error: 'Failed to save display text' });
  }
  res.json({ content: displayText(selection.text) });
});

app.use('/api', noStore);
app.use('/api', express.json({ limit: '64kb' }));
app.get('/api/settings', (req, res) => res.json({ settings, capabilities: capabilities(), csrfToken }));
app.get('/api/device', (req, res) => res.json({ device: device.read() }));
app.put('/api/device', requireCSRF, (req, res) => res.json({ device: device.saveAddress(req.body) }));
app.post('/api/device/check', requireCSRF, async (req, res) => res.json(await device.check()));
app.post('/api/device/apply', requireCSRF, async (req, res) => res.json({ device: await device.apply(req.body) }));
app.put('/api/credentials', requireCSRF, (req, res) => {
  let updated;
  try {
    updated = { ...credentials, ...validateCredentials(req.body) };
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  try {
    credentialStore.save(updated);
  } catch {
    console.error('[ERROR] Failed to save provider credentials.');
    return res.status(500).json({ error: 'Failed to save provider credentials.' });
  }
  credentials = updated;
  // Replacing a provider key also discards any cached responses under the old key.
  content = createContentService(credentials);
  res.json({ capabilities: capabilities() });
});
app.put('/api/settings', requireCSRF, (req, res) => {
  let selection;
  try {
    selection = readSelection(req.body);
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message });
  }
  try {
    persist(selection);
  } catch {
    console.error('[ERROR] Failed to save display settings.');
    return res.status(500).json({ error: 'Failed to save display settings.' });
  }
  res.json({ settings });
});
app.post('/api/preview', requireCSRF, async (req, res) => {
  let selection;
  try {
    selection = readSelection(req.body);
  } catch (error) {
    return res.status(error.status || 400).json({ error: error.message });
  }
  res.json({ content: await content.render(selection), mode: selection.mode });
});
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown panel endpoint.' }));

function panelHeaders(req, res, next) {
  res.set('Content-Security-Policy', 'default-src \'self\'; script-src \'self\'; style-src \'self\'; object-src \'none\'; base-uri \'none\'; frame-ancestors \'none\'');
  res.set('Referrer-Policy', 'no-referrer');
  next();
}
app.use('/assets', noStore, panelHeaders, express.static(path.join(__dirname, 'public'), { index: false }));
app.use('/locale', noStore, panelHeaders, express.static(path.join(__dirname, 'locale'), { index: false }));
app.get('/', noStore, panelHeaders, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
  const status = error.status || 500;
  console.error(`[ERROR] ${req.method} ${req.path} failed with status ${status}.`);
  if (error.deviceError) return res.status(status).json({ error: error.message, code: error.code });
  res.status(status).json({ error: error.status ? error.message : 'Internal server error.' });
});

app.listen(PORT, '0.0.0.0', error => {
  if (error) {
    console.error('[ERROR] Failed to start server:', error.message);
    process.exitCode = 1;
    return;
  }
  console.log('Custom DeskHub Server Started');
  console.log(`Server URL: ${LOCALHOST}:${PORT}`);
  console.log(`Display mode: ${settings.mode}`);
});
