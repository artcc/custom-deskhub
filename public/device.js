export function createDevicePanel({ t, locale, request, onChange }) {
  const byId = id => document.getElementById(id);
  const addressForm = byId('device-address-form');
  const form = byId('device-settings-form');
  const address = byId('device-address');
  const mode = byId('device-mode');
  const modes = ['github', 'api', 'timer', 'xfollowers'];
  const fields = Object.fromEntries([...form.querySelectorAll('[name]')].map(input => [input.name, input]));
  const descriptionKeys = {
    github: 'deviceGithubDescription', api: 'deviceApiDescription',
    timer: 'deviceTimerDescription', xfollowers: 'deviceXDescription'
  };
  let saved = null;
  let busy = false;
  let uncertain = false;

  function message(id, text, error = false) {
    byId(id).textContent = text;
    byId(id).classList.toggle('error', error);
  }

  function configuration() {
    return Object.fromEntries(Object.entries(fields).map(([name, input]) => [name,
      input.type === 'checkbox' ? input.checked : input.type === 'number' ? input.valueAsNumber : input.value
    ]));
  }

  function addressDirty() {
    return saved !== null && address.value !== saved.address;
  }

  function dirty() {
    return saved !== null && (addressDirty() || Object.entries(configuration())
      .some(([name, value]) => value !== saved.configuration[name]));
  }

  function state() {
    return t(busy ? 'deviceWorking' : !saved ? 'unconfirmed' : uncertain ? 'unconfirmed'
      : dirty() ? 'unsaved' : !saved.address ? 'deviceNotLinked' : saved.lastSentAt ? 'deviceSentState' : 'deviceNotSent');
  }

  function update() {
    byId('device-address-fields').disabled = !saved || busy;
    byId('device-settings-fields').disabled = !saved || busy;
    byId('device-save-address').disabled = !saved || busy || !addressDirty();
    byId('device-check').disabled = !saved?.address || busy || addressDirty();
    byId('device-apply').disabled = !saved?.address || busy || addressDirty();
    byId('device-apply').textContent = t(busy ? 'deviceWorking' : 'deviceApply');
    byId('device-retry').disabled = busy;
    addressForm.setAttribute('aria-busy', String(busy));
    form.setAttribute('aria-busy', String(busy));
    for (const name of modes) {
      byId(`device-fields-${name}`).hidden = name !== mode.value;
      byId(`device-fields-${name}`).disabled = name !== mode.value;
    }
    byId('device-mode-description').textContent = t(descriptionKeys[mode.value]);
    byId('device-tab-pending').hidden = !dirty();
    const link = byId('device-open');
    link.hidden = !saved?.address;
    if (saved?.address) link.href = `http://${saved.address}/`;
    else link.removeAttribute('href');
    byId('device-last-sent').textContent = saved?.lastSentAt
      ? t('deviceLastSent', { time: new Date(saved.lastSentAt).toLocaleString(locale) }) : t('deviceNeverSent');
    onChange();
  }

  function accept(data) {
    const device = data?.device;
    if (!device || typeof device.address !== 'string' || !device.configuration ||
        !modes.includes(device.configuration.mode) ||
        Object.keys(fields).some(key => !Object.hasOwn(device.configuration, key)) ||
        (device.lastSentAt !== null && !Number.isFinite(Date.parse(device.lastSentAt)))) {
      throw new Error(t('invalidResponse'));
    }
    saved = device;
  }

  async function load() {
    if (busy) return;
    busy = true;
    byId('device-retry').hidden = true;
    message('device-connection-status', t('loadingSettings'));
    update();
    try {
      accept(await request('/api/device'));
      address.value = saved.address;
      for (const [name, input] of Object.entries(fields)) {
        if (input.type === 'checkbox') input.checked = saved.configuration[name];
        else input.value = saved.configuration[name];
      }
      message('device-connection-status', t(saved.address ? 'deviceAddressLoaded' : 'deviceLinkHint'));
    } catch (error) {
      message('device-connection-status', error.message, true);
      byId('device-retry').hidden = false;
    } finally {
      busy = false;
      update();
    }
  }

  function validate(input) {
    input.setCustomValidity('');
    if (input === address && input.value) {
      const parts = input.value.split('.');
      const valid = parts.length === 4 && parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
      const [first, second] = parts.map(Number);
      if (!valid || !(first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168))) {
        input.setCustomValidity(t('deviceAddressError'));
      }
    } else if (input.validity.valueMissing) input.setCustomValidity(t('requiredField'));
    else if (input.validity.rangeUnderflow || input.validity.rangeOverflow || input.validity.stepMismatch) {
      input.setCustomValidity(t('deviceNumberError', { min: input.min, max: input.max }));
    } else if (!input.validity.valid) input.setCustomValidity(t('invalidField'));
  }

  for (const currentForm of [addressForm, form]) {
    currentForm.addEventListener('input', event => {
      if (typeof event.target.setCustomValidity === 'function') validate(event.target);
      update();
    });
    currentForm.addEventListener('invalid', event => validate(event.target), true);
  }
  mode.addEventListener('change', update);

  addressForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !saved || !addressDirty()) return;
    validate(address);
    if (!addressForm.reportValidity()) return;
    busy = true;
    message('device-connection-status', t('saving'));
    update();
    try {
      accept(await request('/api/device', { method: 'PUT', body: JSON.stringify({ address: address.value }) }));
      address.value = saved.address;
      uncertain = false;
      message('device-connection-status', t(saved.address ? 'deviceAddressSaved' : 'deviceUnlinked'));
    } catch (error) {
      message('device-connection-status', error.message, true);
    } finally {
      busy = false;
      update();
    }
  });

  byId('device-check').addEventListener('click', async () => {
    if (busy || !saved?.address || addressDirty()) return;
    busy = true;
    message('device-connection-status', t('deviceChecking'));
    update();
    try {
      const data = await request('/api/device/check', { method: 'POST', body: '{}' });
      if (data.compatible !== true) throw new Error(t('deviceIncompatible'));
      message('device-connection-status', t('deviceCompatible'));
    } catch (error) {
      message('device-connection-status', error.message, true);
    } finally {
      busy = false;
      update();
    }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !saved?.address || addressDirty() || !form.reportValidity()) return;
    const draft = configuration();
    busy = true;
    message('device-apply-status', t('deviceApplying'));
    update();
    try {
      accept(await request('/api/device/apply', { method: 'POST', body: JSON.stringify({ configuration: draft }) }));
      uncertain = false;
      message('device-apply-status', t('deviceApplied'));
    } catch (error) {
      // A lost acknowledgement can still mean the hardware accepted the settings.
      uncertain = !error.status || error.code === 'device_unconfirmed' || (error.status >= 500 && !error.code);
      message('device-apply-status', uncertain ? t('deviceUnconfirmed') : error.message, true);
    } finally {
      busy = false;
      update();
    }
  });

  byId('device-use-panel').addEventListener('click', () => {
    fields.jsonKey.value = 'content';
    fields.fetchRate.value = '60000';
    const host = window.location.hostname;
    if (host === 'localhost' || host.endsWith('.localhost') || host.startsWith('127.') || host === '[::1]') {
      message('device-apply-status', t('devicePanelLocalhost'), true);
    } else {
      fields.apiUrl.value = `${window.location.origin}/display`;
      message('device-apply-status', t('devicePanelReady'));
    }
    for (const input of [fields.apiUrl, fields.jsonKey, fields.fetchRate]) validate(input);
    fields.apiUrl.focus();
    update();
  });
  byId('device-retry').addEventListener('click', load);

  return { load, dirty, state };
}
