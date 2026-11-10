function rotationIntervalMs(device) {
  return device.lastSentAt ? device.configuration.fetchRate : 60000;
}

async function renderDisplay(settings, content, { intervalMs = 60000, now = Date.now } = {}) {
  if (!settings.rotation.enabled) {
    return { content: await content.render(settings), mode: settings.mode, skippedSources: [] };
  }
  const { sources } = settings.rotation;
  // Absolute epoch slots preserve phase across reads and restarts, including the first read.
  const slot = Math.floor(now() / intervalMs) % sources.length;
  const skippedSources = [];
  for (let offset = 0; offset < sources.length; offset++) {
    const mode = sources[(slot + offset) % sources.length];
    try {
      return { content: await content.render({ ...settings, mode }), mode, skippedSources };
    } catch (error) {
      if (!['commits', 'weather'].includes(mode) || ![502, 503, 504].includes(error.status)) throw error;
      skippedSources.push(mode);
    }
  }
  throw Object.assign(new Error('No display source is currently available.'), { status: 503 });
}

module.exports = { renderDisplay, rotationIntervalMs };
