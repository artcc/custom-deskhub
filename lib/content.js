const https = require('node:https');

function failure(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

function displayText(value) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7e]/g, '');
}

function renderTemplate(template, values) {
  return displayText(template.replace(/{{([\s\S]*?)}}/g, (match, token) => values[token.trim()]));
}

function requestJSON(options, body, provider) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, response => {
      let data = '';
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          req.destroy(failure(`${provider} response is too large.`));
          return;
        }
        data += chunk;
      });
      response.on('error', () => finish(failure(`${provider} response was interrupted.`)));
      response.on('aborted', () => finish(failure(`${provider} response was interrupted.`)));
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          finish(failure(`${provider} returned HTTP ${response.statusCode}.`));
          return;
        }
        try {
          finish(null, JSON.parse(data));
        } catch {
          finish(failure(`${provider} returned invalid JSON.`));
        }
      });
    });
    const timer = setTimeout(() => req.destroy(failure(`${provider} request timed out.`, 504)), 10000);
    timer.unref();
    function finish(error, value) {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    }
    req.on('error', error => finish(error.status ? error : failure(`${provider} is unavailable.`)));
    if (body) req.write(body);
    req.end();
  });
}

function createContentService({ githubToken, weatherKey }) {
  let commitsCache;
  let weatherCache;

  async function commits({ username, template = '{{commits}}' }) {
    if (!githubToken || !username) throw failure('GitHub is not configured.', 503);
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    const from = date.toISOString();
    const key = JSON.stringify([username, from]);
    let contributions;
    if (commitsCache?.key === key && Date.now() - commitsCache.timestamp < 5 * 60 * 1000) {
      contributions = commitsCache.data;
    } else {
      const query = `query($username: String!, $from: DateTime!) {
        user(login: $username) {
          contributionsCollection(from: $from) {
            totalCommitContributions
            commitContributionsByRepository(maxRepositories: 100) {
              repository { name }
              contributions(first: 100) { nodes { commitCount } }
            }
          }
        }
      }`;
      const result = await requestJSON({
        hostname: 'api.github.com',
        path: '/graphql',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${githubToken}`,
          'User-Agent': 'custom-deskhub'
        }
      }, JSON.stringify({ query, variables: { username, from } }), 'GitHub');
      if (result.errors?.length) throw failure('GitHub rejected the query. Check the token and its permissions.');
      contributions = result.data?.user?.contributionsCollection;
      if (!contributions || !Number.isInteger(contributions.totalCommitContributions) || contributions.totalCommitContributions < 0 ||
          !Array.isArray(contributions.commitContributionsByRepository)) {
        throw failure('GitHub returned invalid contribution data.');
      }
      for (const repo of contributions.commitContributionsByRepository) {
        if (typeof repo.repository?.name !== 'string' || !Array.isArray(repo.contributions?.nodes) ||
            repo.contributions.nodes.some(node => !Number.isInteger(node?.commitCount) || node.commitCount < 0)) {
          throw failure('GitHub returned invalid repository contributions.');
        }
      }
      commitsCache = { key, data: contributions, timestamp: Date.now() };
    }
    const total = contributions.totalCommitContributions;
    const repositories = contributions.commitContributionsByRepository.map(repo => {
      const count = repo.contributions.nodes.reduce((sum, node) => sum + node.commitCount, 0);
      return `${repo.repository.name}: ${count}`;
    }).join(', ');
    return renderTemplate(template, { content: total, commits: total, repositories, username });
  }

  async function weather({ city, units, template = '{{temperature}} {{unit}}' }) {
    if (!weatherKey || !city) throw failure('Weather service not configured', 503);
    const key = JSON.stringify([city, units]);
    let data;
    if (weatherCache?.key === key && Date.now() - weatherCache.timestamp < 15 * 60 * 1000) {
      data = weatherCache.data;
    } else {
      const query = new URLSearchParams({ q: city, appid: weatherKey, units });
      data = await requestJSON({
        hostname: 'api.openweathermap.org',
        path: `/data/2.5/weather?${query}`,
        method: 'GET'
      }, null, 'OpenWeatherMap');
      if (Number(data.cod) !== 200 || !Number.isFinite(data.main?.temp) ||
          typeof data.name !== 'string' || typeof data.weather?.[0]?.description !== 'string') {
        throw failure('OpenWeatherMap returned invalid weather data.');
      }
      weatherCache = { key, data, timestamp: Date.now() };
    }
    const temperature = Math.round(data.main.temp);
    const unit = units === 'imperial' ? 'F' : 'C';
    const condition = data.weather[0].description;
    return renderTemplate(template, { content: temperature, city: data.name, temperature, unit, condition });
  }

  async function render(settings) {
    if (settings.mode === 'commits') return commits(settings.github);
    if (settings.mode === 'weather') return weather(settings.weather);
    return displayText(settings.text);
  }

  return { render, commits, weather };
}

module.exports = { createContentService, displayText };
