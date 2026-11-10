function selectLocale(preferences) {
  for (const preference of preferences) {
    const language = typeof preference === 'string' ? preference.toLowerCase().split('-')[0] : '';
    if (language === 'es') return 'es-ES';
    if (language === 'en') return 'en';
  }
  return 'en';
}

async function loadDictionary(language) {
  const response = await fetch(`/locale/${language}.json`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`Cannot load locale ${language}: HTTP ${response.status}`);
  const dictionary = await response.json();
  if (!dictionary || typeof dictionary !== 'object' || Array.isArray(dictionary) ||
      !Object.keys(dictionary).length || Object.values(dictionary).some(value => typeof value !== 'string' || !value)) {
    throw new Error(`Invalid locale dictionary: ${language}`);
  }
  return dictionary;
}

export async function loadI18n(preferences) {
  let locale = selectLocale(preferences);
  const english = await loadDictionary('en');
  let messages = english;
  if (locale === 'es-ES') {
    try {
      messages = { ...english, ...await loadDictionary('es') };
    } catch (error) {
      console.warn('Spanish translations could not be loaded; using English.', error);
      locale = 'en';
    }
  }
  return {
    locale,
    t(key, values = {}) {
      if (!Object.hasOwn(messages, key)) throw new Error(`Missing translation: ${key}`);
      return messages[key].replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
    }
  };
}
