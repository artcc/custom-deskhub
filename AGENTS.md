# Repository instructions

## Purpose and communication

- This project is a self-hosted backend for an existing DeskHub ESP32 device.
- Communicate with the developer in Spanish (Spain). Keep code, comments and
  repository documentation in English, following existing conventions.
- The integration currently supplies text through JSON. Do not assume the device
  accepts graphics, arbitrary rendering commands or firmware uploads over Wi-Fi.
- Inspect the relevant implementation before relying on README claims. Keep
  changes focused on the requested behavior and preserve unrelated working changes.

## Code and architecture

- Use Node.js 26 LTS, npm 11, Express 5 and CommonJS. Keep `.nvmrc`, package engines,
  Docker and CI aligned when updating the runtime.
- `index.js` contains configuration, routes, upstream requests, caching and storage.
  Prefer small changes; extract modules when a concrete responsibility warrants it.
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
- Prefer compact ASCII-compatible output for generated display content. Do not
  assume Unicode, HTML or multiline rendering works on the hardware.
- GitHub contribution nodes can represent multiple commits: sum `commitCount`,
  not the number of nodes. Keep date boundaries and cache behavior explicit.
- A failed persistence operation must not report success or replace the active
  in-memory text with an unsaved value.

## Configuration and storage

- `.env` and `.env-dev` are intentionally versionable configuration files. Only
  empty credential values belong in commits. Never print or commit real tokens.
- `npm start` and `npm run dev` load `.env`; existing process variables take
  precedence. `run_dev.sh` explicitly uses `.env-dev` for Compose interpolation.
- `GITHUB_TOKEN`, `GITHUB_USERNAME`, `PORT` and `LOCALHOST` are currently required
  at startup. OpenWeatherMap configuration is optional.
- Local storage defaults to `data.json` beside `index.js`; `DATA_FILE` overrides it.
  Docker sets `DATA_FILE=/app/data/data.json` inside the persistent mount.
- Preserve existing data. Older containers may have `/app/data.json` outside the
  mount; migration requires copying it before removing the old container.
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
