const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseEnv } = require('node:util');
const { createCredentialStore } = require('../lib/credentials');
const { loadSettings, saveSettings } = require('../lib/settings');

// Explicit file arguments keep migrations separate from application startup.
const [environmentFile, settingsFile] = process.argv.slice(2);
if (!environmentFile || !settingsFile) {
  console.error('Usage: node scripts/migrate-env.js <environment-file> <settings-file>');
  process.exit(1);
}

const providerFields = ['GITHUB_TOKEN', 'GITHUB_USERNAME', 'OPENWEATHER_API_KEY', 'OPENWEATHER_CITY', 'OPENWEATHER_UNITS'];
try {
  const source = fs.readFileSync(environmentFile, 'utf8');
  const values = parseEnv(source);
  if (!providerFields.some(field => Object.hasOwn(values, field))) {
    console.log('No provider configuration to migrate.');
    process.exit(0);
  }
  // Line-based removal must not leave fragments of multiline values behind.
  if (providerFields.some(field => /[\r\n]/.test(values[field] || ''))) {
    throw new Error('Multiline provider configuration is not supported.');
  }
  const cleaned = source.split(/\r?\n/).filter(line => {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*)$/);
    if (!match || !providerFields.includes(match[1])) return true;
    const value = match[2];
    if (/^['"`]/.test(value) && !value.slice(1).includes(value[0])) {
      throw new Error('Multiline provider configuration is not supported.');
    }
    return false;
  }).filter(line => line !== '# Optional: weather requires an API key.').join('\n');
  const remaining = parseEnv(cleaned);
  if (providerFields.some(field => Object.hasOwn(remaining, field)) ||
      Object.entries(values).some(([field, value]) => !providerFields.includes(field) && remaining[field] !== value)) {
    throw new Error('Cannot safely remove provider configuration.');
  }
  const file = path.resolve(settingsFile);
  const store = createCredentialStore(file);
  const credentials = store.load();
  for (const [field, environmentName] of [['githubToken', 'GITHUB_TOKEN'], ['weatherKey', 'OPENWEATHER_API_KEY']]) {
    const value = values[environmentName];
    if (!value) continue;
    if (credentials[field] && credentials[field] !== value) {
      throw new Error('The credential store contains a different key. Resolve this in the panel before migrating.');
    }
    credentials[field] = value;
  }
  const settings = loadSettings(file, {
    mode: 'text',
    text: '',
    github: { username: values.GITHUB_USERNAME || '', showRepositories: true },
    weather: { city: values.OPENWEATHER_CITY || '', units: values.OPENWEATHER_UNITS || 'metric' }
  });
  // Persist everything before removing the legacy values from the environment file.
  if (credentials.githubToken || credentials.weatherKey) store.save(credentials);
  saveSettings(file, settings);
  const temporaryFile = `${environmentFile}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, cleaned, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporaryFile, environmentFile);
  } finally {
    fs.rmSync(temporaryFile, { force: true });
  }
  console.log('Provider configuration migrated; legacy environment entries removed. No credential values were printed.');
} catch (error) {
  // Only our controlled errors are useful here; filesystem/parser errors can contain sensitive input.
  console.error('Migration failed. The environment file was not cleared. Check file permissions, settings validity and existing credential files.');
  if (error.message === 'The credential store contains a different key. Resolve this in the panel before migrating.') {
    console.error(error.message);
  }
  process.exitCode = 1;
}
