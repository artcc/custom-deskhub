const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { saveSettings } = require('./settings');

const DEFAULT_CONFIGURATION = Object.freeze({
  mode: 'api', username: '', apiUrl: '', jsonKey: 'content', fetchRate: 60000,
  scrollingText: true, xUsername: '', animationType: 'pacman',
  timerDuration: 5, restDuration: 5, loopCount: 1
});
const MODES = ['github', 'api', 'timer', 'xfollowers'];
const ANIMATIONS = ['pacman', 'progress'];
const MAX_BYTES = 256 * 1024;
const MESSAGES = {
  device_address: 'Enter a private IPv4 address.',
  device_configuration: 'Invalid device configuration.',
  device_not_configured: 'Configure a device address first.',
  device_incompatible: 'The device configuration form is not compatible.',
  device_unreachable: 'The device could not be checked.',
  device_unconfirmed: 'The send outcome could not be confirmed. Check the device before sending again.',
  device_busy: 'A device operation is already in progress.',
  device_storage: 'Device metadata could not be saved locally.'
};

function deviceError(code, status = 400) {
  return Object.assign(new Error(MESSAGES[code]), { code, status, deviceError: true });
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validateAddress(address) {
  if (address === '') return address;
  if (typeof address !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(address)) {
    throw deviceError('device_address');
  }
  const octets = address.split('.').map(Number);
  if (octets.some(value => value > 255) || !(octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168))) throw deviceError('device_address');
  return address;
}

function validateConfiguration(input, draft = false) {
  const invalid = () => { throw deviceError('device_configuration'); };
  if (!exactKeys(input, Object.keys(DEFAULT_CONFIGURATION))) invalid();
  if (!MODES.includes(input.mode) || !ANIMATIONS.includes(input.animationType) ||
    typeof input.scrollingText !== 'boolean') invalid();
  for (const [key, maximum] of Object.entries({ username: 39, xUsername: 15, apiUrl: 2048, jsonKey: 128 })) {
    if (typeof input[key] !== 'string' || input[key].length > maximum || /[\x00-\x1f\x7f]/.test(input[key])) invalid();
  }
  if (input.username && (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(input.username) || input.username.includes('--'))) invalid();
  if (input.xUsername && !/^[a-z\d_]{1,15}$/i.test(input.xUsername)) invalid();
  if (input.jsonKey && !/^[a-z\d_.-]+$/i.test(input.jsonKey)) invalid();
  if (input.apiUrl) {
    let url;
    try { url = new URL(input.apiUrl); } catch { invalid(); }
    if (!/^https?:\/\//i.test(input.apiUrl) || !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname || url.username || url.password || /^https?:\/\/[^/]*@/i.test(input.apiUrl) ||
      input.apiUrl.includes('#') || /\s|\\/.test(input.apiUrl)) invalid();
  }
  if (!draft && ((input.mode === 'github' && !input.username) ||
    (input.mode === 'xfollowers' && !input.xUsername) || (input.mode === 'api' && !input.apiUrl))) invalid();
  for (const [key, minimum, maximum] of [
    ['fetchRate', 1000, 86400000], ['timerDuration', 1, 240], ['restDuration', 1, 240], ['loopCount', 1, 10]
  ]) {
    if (!Number.isInteger(input[key]) || input[key] < minimum || input[key] > maximum) invalid();
  }
  return Object.fromEntries(Object.keys(DEFAULT_CONFIGURATION).map(key => [key, input[key]]));
}

function attributes(source) {
  const result = Object.create(null);
  let rest = source.trim().replace(/\/$/, '').trim();
  while (rest) {
    const match = /^([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s'"=<>`]+)))?/.exec(rest);
    if (!match) throw deviceError('device_incompatible', 502);
    const name = match[1].toLowerCase();
    if (Object.hasOwn(result, name)) throw deviceError('device_incompatible', 502);
    result[name] = match[2] ?? match[3] ?? match[4] ?? '';
    rest = rest.slice(match[0].length).trim();
  }
  return result;
}

// A recognizer for the known firmware contract, not a browser or a settings reader.
function verifyForm(html) {
  const incompatible = () => { throw deviceError('device_incompatible', 502); };
  const source = html.replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
  const tags = source.matchAll(/<(\/?)([a-z][\w:-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi);
  let form = null;
  let found = false;
  let select = null;
  let templateDepth = 0;
  let textElement = null;
  const fieldsets = [];
  const fields = new Set();
  const options = { mode: [], animationType: [] };
  for (const [, closing, rawTag, rawAttributes] of tags) {
    const tag = rawTag.toLowerCase();
    // Apparent tags inside HTML text elements cannot close an ancestor template.
    if (textElement) {
      if (closing && tag === textElement) textElement = null;
      continue;
    }
    if (!closing && ['textarea', 'title', 'iframe', 'xmp', 'noembed', 'noframes', 'noscript'].includes(tag)) textElement = tag;
    const attrs = attributes(rawAttributes);
    if (tag === 'template') templateDepth = closing ? Math.max(0, templateDepth - 1) : templateDepth + 1;
    if (tag === 'fieldset') {
      if (closing) fieldsets.pop();
      else fieldsets.push(Object.hasOwn(attrs, 'disabled'));
    }
    if (tag === 'form') {
      if (closing) {
        if (form === 'configForm' && select) incompatible();
        form = null;
      } else {
        if (form !== null) incompatible();
        form = attrs.name || '';
        if (form === 'configForm') {
          if (found || templateDepth || fieldsets.includes(true) || attrs.action !== '/submit' || attrs.method?.toUpperCase() !== 'POST' ||
            (attrs.enctype && attrs.enctype !== 'application/x-www-form-urlencoded')) incompatible();
          found = true;
        }
      }
      continue;
    }
    if (Object.hasOwn(attrs, 'form')) incompatible();
    if (form !== 'configForm') continue;
    if (Object.hasOwn(attrs, 'disabled') || ['textarea', 'object', 'template', 'noscript', 'iframe'].includes(tag) ||
      Object.hasOwn(attrs, 'formaction') || Object.hasOwn(attrs, 'formmethod')) incompatible();
    if (closing) {
      if (tag === 'select') select = null;
      continue;
    }
    if (tag === 'option') {
      if (!select || !Object.hasOwn(attrs, 'value')) incompatible();
      options[select].push(attrs.value);
      continue;
    }
    if (!['input', 'select', 'button'].includes(tag)) continue;
    if (!attrs.name) {
      if (tag === 'select' || (tag === 'input' && attrs.type !== 'submit')) incompatible();
      continue;
    }
    const name = attrs.name;
    if (!Object.hasOwn(DEFAULT_CONFIGURATION, name) || fields.has(name)) incompatible();
    fields.add(name);
    if (tag === 'select') {
      if (select || !Object.hasOwn(options, name) || Object.hasOwn(attrs, 'multiple')) incompatible();
      select = name;
    } else {
      const expectedType = name === 'scrollingText' ? 'checkbox' :
        ['timerDuration', 'restDuration', 'loopCount'].includes(name) ? 'number' : 'text';
      if (tag !== 'input' || attrs.type !== expectedType || Object.hasOwn(options, name)) incompatible();
      if (name === 'scrollingText' && Object.hasOwn(attrs, 'value') && attrs.value !== 'on') incompatible();
    }
  }
  if (!found || form !== null || fields.size !== Object.keys(DEFAULT_CONFIGURATION).length) incompatible();
  for (const [name, expected] of [['mode', MODES], ['animationType', ANIMATIONS]]) {
    if (options[name].length !== expected.length || expected.some(value => !options[name].includes(value))) incompatible();
  }
}

function serializeConfiguration(configuration) {
  const values = Object.entries(configuration).filter(([key]) => key !== 'scrollingText');
  if (configuration.scrollingText) values.push(['scrollingText', 'on']);
  return new URLSearchParams(values).toString();
}

function exchange(address, method, body, request, timeoutMs) {
  return new Promise((resolve, reject) => {
    let req;
    let response;
    let settled = false;
    const failureCode = method === 'POST' ? 'device_unconfirmed' : 'device_unreachable';
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        response?.destroy();
        req?.destroy();
      } else resolve(result);
    };
    // Wall-clock deadline also bounds responses that keep trickling bytes.
    const timer = setTimeout(() => finish(deviceError(failureCode, 504)), timeoutMs);
    try {
      req = request({
        hostname: address, port: 80, path: method === 'GET' ? '/' : '/submit', method,
        agent: false, maxHeaderSize: 16384,
        headers: method === 'POST' ? {
          'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body)
        } : { Accept: 'text/html' }
      }, res => {
        response = res;
        let bytes = 0;
        const chunks = [];
        res.on('error', () => finish(deviceError(failureCode, 502)));
        res.on('aborted', () => finish(deviceError(failureCode, 502)));
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) return finish(deviceError(failureCode, 502));
          chunks.push(Buffer.from(chunk));
        });
        res.on('end', () => finish(null, {
          status: res.statusCode, location: res.headers.location, body: Buffer.concat(chunks).toString('utf8')
        }));
        if (Number(res.headers['content-length']) > MAX_BYTES) finish(deviceError(failureCode, 502));
      });
      req.on('error', () => finish(deviceError(failureCode, 502)));
      req.end(body);
    } catch {
      finish(deviceError(failureCode, 502));
    }
  });
}

function createDeviceService(dataFile, { request = (...args) => http.request(...args), timeoutMs = 5000 } = {}) {
  const file = path.join(path.dirname(dataFile), 'device.json');
  let device = { address: '', configuration: { ...DEFAULT_CONFIGURATION }, lastSentAt: null };
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!exactKeys(stored, ['address', 'configuration', 'lastSentAt']) ||
      (stored.lastSentAt !== null && (typeof stored.lastSentAt !== 'string' ||
        !Number.isFinite(Date.parse(stored.lastSentAt)) || !stored.address))) throw new Error();
    device = {
      address: validateAddress(stored.address),
      configuration: validateConfiguration(stored.configuration, stored.lastSentAt === null),
      lastSentAt: stored.lastSentAt
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Failed to load local device metadata.');
  }
  let busy = false;
  const read = () => structuredClone(device);
  const persist = updated => {
    saveSettings(file, updated);
    device = updated;
    return read();
  };
  const address = () => {
    if (!device.address) throw deviceError('device_not_configured', 409);
    return device.address;
  };
  const checkAddress = async target => {
    const response = await exchange(target, 'GET', undefined, request, timeoutMs);
    if (response.status !== 200) throw deviceError('device_incompatible', 502);
    verifyForm(response.body);
    return { compatible: true };
  };
  const lock = () => {
    if (busy) throw deviceError('device_busy', 409);
    busy = true;
  };
  return {
    read,
    saveAddress(input) {
      if (!exactKeys(input, ['address'])) throw deviceError('device_address');
      const target = validateAddress(input.address);
      lock();
      try {
        if (target === device.address) return read();
        return persist({ address: target, configuration: { ...DEFAULT_CONFIGURATION }, lastSentAt: null });
      } catch {
        throw deviceError('device_storage', 500);
      } finally { busy = false; }
    },
    async check() {
      lock();
      try { return await checkAddress(address()); } finally { busy = false; }
    },
    async apply(input) {
      if (!exactKeys(input, ['configuration'])) throw deviceError('device_configuration');
      const configuration = validateConfiguration(input.configuration);
      lock();
      try {
        const target = address();
        await checkAddress(target);
        const response = await exchange(target, 'POST', serializeConfiguration(configuration), request, timeoutMs);
        if (!((response.status >= 200 && response.status < 300) ||
          ([302, 303].includes(response.status) && response.location === '/'))) {
          throw deviceError('device_unconfirmed', 502);
        }
        try {
          return persist({ address: target, configuration, lastSentAt: new Date().toISOString() });
        } catch { throw deviceError('device_unconfirmed', 502); }
      } finally { busy = false; }
    }
  };
}

module.exports = { createDeviceService, DEFAULT_CONFIGURATION, validateAddress, validateConfiguration, verifyForm };
