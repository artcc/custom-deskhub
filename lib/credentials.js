const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID, createCipheriv, createDecipheriv } = require('node:crypto');

const FIELDS = ['githubToken', 'weatherKey'];

function validateCredentials(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !Object.keys(input).length || Object.keys(input).some(key => !FIELDS.includes(key))) {
    throw new Error('Supply githubToken and/or weatherKey.');
  }
  const result = {};
  for (const field of FIELDS) {
    if (!Object.hasOwn(input, field)) continue;
    const value = input[field];
    if (typeof value !== 'string' || value.length > 8192 || /[^\x21-\x7e]/.test(value)) {
      throw new Error('API keys must be strings without whitespace, up to 8192 characters.');
    }
    result[field] = value;
  }
  return result;
}

function createCredentialStore(dataFile) {
  const directory = path.dirname(dataFile);
  const file = path.join(directory, 'credentials.json');
  const keyFile = path.join(directory, 'credentials.key');

  function readKey(create = false) {
    if (create && !fs.existsSync(file)) {
      fs.mkdirSync(directory, { recursive: true });
      try {
        fs.writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    const key = fs.readFileSync(keyFile);
    if (key.length !== 32) throw new Error('Invalid credential encryption key.');
    return key;
  }

  function load() {
    let stored;
    try {
      stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { githubToken: '', weatherKey: '' };
      throw new Error('Cannot read the credential store.');
    }
    try {
      if (stored.version !== 1) throw new Error('Unsupported version.');
      const decipher = createDecipheriv('aes-256-gcm', readKey(), Buffer.from(stored.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(stored.data, 'base64')), decipher.final()]);
      return { githubToken: '', weatherKey: '', ...validateCredentials(JSON.parse(plain.toString('utf8'))) };
    } catch {
      throw new Error('Cannot decrypt credentials. Restore credentials.json and credentials.key from the same backup.');
    }
  }

  function save(credentials) {
    const values = validateCredentials(credentials);
    const key = readKey(true);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
    const stored = { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') };
    const temporaryFile = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryFile, JSON.stringify(stored), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporaryFile, file);
    } finally {
      fs.rmSync(temporaryFile, { force: true });
    }
  }

  return { load, save };
}

module.exports = { createCredentialStore, validateCredentials };
