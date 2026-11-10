# Repository instructions

## Purpose and communication

- This project is a self-hosted backend for an existing DeskHub ESP32 device.
- Deploy only within trusted local/private networks, not directly on the public
  Internet. Both the panel and device endpoints deliberately have no login.
- Communicate with the developer in Spanish (Spain). Keep code, comments and
  repository documentation in English, following existing conventions.
- The integration currently supplies text through JSON. Do not assume the device
  accepts graphics, arbitrary rendering commands or firmware uploads over Wi-Fi.
- Inspect the relevant implementation before relying on README claims. Keep
  changes focused on the requested behavior and preserve unrelated working changes.

## Code and architecture

- Use Node.js 26 LTS, npm 11, Express 5 and CommonJS on the backend; use native ES
  modules in the browser. Keep `.nvmrc`, package engines,
  Docker and CI aligned when updating the runtime.
- `index.js` contains routes, CSRF protection and startup. `lib/content.js` handles
  provider requests and caching; `lib/settings.js` validates and persists settings;
  `lib/credentials.js` manages encrypted provider credentials.
  `public/` contains the native HTML/CSS/JavaScript control panel. Keep the stack simple.
- `lib/device.js` adapts the device's display configuration form; `public/device.js`
  owns the Device tab. Keep its draft independent of source settings and credentials.
- The LED preview is a 32 × 7 SVG grid (224 cells) using bitmap column data, never
  browser text wrapping or font scaling. Geometry was corrected by the device owner;
  font/alignment/scroll behavior is a simulation. Keep the MD_MAX72XX font
  attribution and LGPL license with its separate, replaceable source module.
- Localize all panel copy in English and Spanish (Spain). Select the first supported
  browser language preference and fall back to English. Keep deployment guidance
  generic: do not assume the user's operating system or hosting environment.
- Store translation dictionaries in `locale/en.json` and `locale/es.json`, never
  inline in JavaScript. `public/i18n.js` loads them and handles fallback/interpolation.
- Follow ESLint configuration: two-space indentation, single quotes and semicolons.
- Prefer native Node.js capabilities and existing dependencies. Update
  `package-lock.json` whenever dependencies change.
- Express 5 reports listen errors through the callback. Preserve nonzero exit
  status on startup failure and the explicitly configured query parser.

## Device-facing behavior

- Preserve successful response shape: `{ "content": "text" }`.
- Existing routes are `GET /display`, `GET /setDisplay?text=...`, `GET /commits`
  and `GET /weather`. Changing their paths, methods or response format affects
  existing device configurations and callers.
- `/display` renders the saved source. The panel uses `/api/settings` and
  `/api/preview`; previews never persist settings. `/healthz` must not call providers.
- Optional source rotation uses the last acknowledged device fetch interval, or
  60000 ms by default, equally for all included sources in fixed order. Select slots
  by server time, never request count. `/api/display` reports the rendered source
  and skipped sources; `/display` keeps its original response shape. Previews render
  the chosen editor source independently. Rotation must not submit hardware settings.
- GitHub and weather settings have optional `template` strings, defaulting to
  `{{commits}}` and `{{temperature}} {{unit}}`. Wording belongs in the editable
  template, never in implicit backend summaries. Legacy `{{content}}` is a scalar
  alias; exact old default templates normalize to the new defaults. Preserve custom
  literal text. Interpolate only supported variables, never evaluate user input.
  Cache provider data independently of message formatting.
- Provider keys are managed through `/api/credentials`. Return capability flags,
  never credential values; omitted keys remain unchanged and empty strings remove them.
- The panel opens without authentication. Preserve CSRF checks for writes,
  including legacy `/setDisplay`; they are not an access-control boundary.
- Prefer compact ASCII-compatible output for generated display content. Do not
  assume Unicode, HTML or multiline rendering works on the hardware.
- GitHub contribution nodes can represent multiple commits: sum `commitCount`,
  not the number of nodes. Keep date boundaries and cache behavior explicit.
- A failed persistence operation must not report success or replace the active
  in-memory text with an unsaved value.
- Optional device control uses an explicitly saved private IPv4 address, `GET /`
  for form compatibility and `POST /submit` for complete display configuration.
  Never submit Wi-Fi fields or call `/wifi`. Supported firmware modes are `github`,
  `api`, `timer` and `xfollowers`. Its HTML does not expose saved settings: show
  defaults or last acknowledged submission, never claim a live settings snapshot.
- Device contact operations require CSRF. Bound response sizes and request timeouts,
  reject incompatible forms, do not follow redirects or retry device submissions.
  A lost acknowledgement is unconfirmed, not proof that settings were not applied.

## Configuration and storage

- `.env` and `.env-dev` are intentionally versionable configuration files. Only
  empty credential values belong in commits. Never print or commit real tokens.
- `npm start` and `npm run dev` load `.env`; existing process variables take
  precedence. `run_dev.sh` explicitly uses `.env-dev` for Compose interpolation.
- `PORT` and `LOCALHOST` are required at startup. Provider keys, username, city and
  units are configured in the UI, not environment variables. Text mode needs no
  provider keys.
- Never put tokens in ordinary settings, responses, logs or browser storage.
  Credentials use AES-256-GCM with a separate local key; back up both credential
  files in the persistent directory and preserve their owner-only permissions.
- Local storage defaults to `data.json` beside `index.js`; `DATA_FILE` overrides it.
  Docker sets `DATA_FILE=/app/data/data.json` inside the persistent mount.
- Preserve existing data. Older containers may have `/app/data.json` outside the
  mount; migration requires copying it before removing the old container.
- Legacy `{ text }` data loads as text mode. Save full settings atomically and
  preserve the previous configuration on write failures.
- Keep runtime data and environment files out of Docker build contexts. Runtime
  data directories must also stay out of Git.

## Development and Docker

- `npm ci`: install locked dependencies.
- `npm run dev`: run locally with native Node.js watch mode.
- `npm start`: run locally without watch mode.
- `./run_dev.sh`: validate development configuration, start OrbStack if needed,
  build the local image, and wait for the service to become healthy.
- `docker-compose-dev.yml` is standalone and uses the same Dockerfile and application
  features as production. Keep environment options, healthcheck, ports and network
  behavior consistent between the two Compose files.
- Production uses `docker-compose.yml` and `./data`. Development uses the
  `custom-deskhub-dev` container, `custom-deskhub:dev` image and `./data-dev`.
- Development Docker commands target the `orbstack` context. Do not silently
  switch global Docker contexts or operate on another Docker host.
- Keep `run_dev.sh` compatible with macOS Bash, executable, and independent of the
  caller's working directory. Changes require rerunning it to rebuild the image.

## Verification and delivery

- Run `npm run lint` and `npm test` for JavaScript or dependency changes.
- Tests use Node's built-in runner, temporary storage and isolated subprocesses.
  Mock upstream requests for regression tests; do not require live API credentials
  or modify the physical DeskHub for ordinary test runs.
- For shell and Compose changes, check `bash -n run_dev.sh` and validate the relevant
  Compose configuration. Avoid printing resolved configuration containing tokens.
- Check the final diff for unrelated changes and secrets. Document configuration
  and behavior changes in the README.
- Distinguish local tests and mocked upstream results from a real Docker build,
  live API checks or device verification. Report checks that could not run.
- Do not push commits, publish images, deploy, or modify the device or router
  without explicit authorization. CI currently validates before building images
  and publishes on configured non-PR events.
