<p align="center">
  <img src="docs/deskhub-logo.svg" alt="DeskHub D: icon" width="88" height="88">
</p>

<h1 align="center">Custom DeskHub Backend</h1>

> [!WARNING]
> **For local servers and trusted private networks only. Do not expose this service
> directly to the public Internet.** Do not publish it through router port forwarding
> or public tunnels. There is no login: anyone who can reach the server can change
> the display settings, manage integrations and configure a linked device. Keep access within your LAN or a
> private VPN. This application is not hardened for public Internet deployment.

A self-hosted control panel for [DeskHub](https://getdeskhub.com/). Configure one
URL on the device, then choose its content from your browser.

## Features

- A responsive web panel for custom text, GitHub contribution commits and weather.
- Independent draft previews and a view of the currently saved `/display` response.
- A 32 × 8 LED preview with bitmap text, column measurements and optional scroll simulation.
- Custom message formats combining your own text with GitHub or weather variables.
- Provider API keys managed through the web, encrypted in persistent storage.
- Optional device control by local IP: GitHub, API, Work Timer and X Followers,
  including API scrolling and timer options.
- Persistent source selection, username, city, units and text, with atomic saves.
- GitHub caching for 5 minutes and weather caching for 15 minutes, keyed by settings.
- Direct panel access without login, with CSRF protection for changes.
- English and Spanish (Spain), selected automatically from browser language preferences,
  with English as the fallback.
- Native HTML/CSS/JavaScript, Node.js 26 LTS and Express 5; no frontend build step.

This version has one active source. Rotation, schedules and firmware-level graphics
are not implemented. The **Device** tab configures the firmware's existing modes;
it does not install firmware or add new hardware rendering capabilities.

## Quick start: OrbStack on macOS

1. Install/open OrbStack.
2. Run:

   ```bash
   ./run_dev.sh
   ```

3. Open **http://localhost:3005/**. In **Integrations**, save a GitHub token and/or
   OpenWeatherMap key. Text mode requires neither.
4. Choose a source, configure it, optionally preview it, then save.

The script starts OrbStack if necessary, builds the local image and waits for a
healthy container. `docker-compose-dev.yml` is standalone and uses the same
Dockerfile, features and healthcheck as production. It uses `.env-dev`, the
`custom-deskhub-dev` container, `custom-deskhub:dev` image and `./data-dev` storage.
Run the script again after source changes to rebuild the image.

```bash
docker --context orbstack logs -f custom-deskhub-dev
docker --context orbstack stop custom-deskhub-dev
```

### Configure the device once

In the DeskHub's API mode, use:

- **URL:** `http://<server-lan-ip>:3005/display`
- **JSON key:** `content`
- **Fetch interval:** `60000` ms is a reasonable starting point.

Use a server hostname or IP address reachable from the device's network.
`localhost` and loopback addresses would point to the DeskHub itself, not the
server. The device does not use provider tokens.
Saved changes appear on its next poll. A preview shows server output; it does not
confirm that the physical device has fetched or displayed it.

## Local Node.js development

Requirements: Node.js **26 LTS** (`.nvmrc`) and npm **11**.

```bash
npm ci
npm run dev
```

`npm start` runs without watch mode. Both commands load `.env` when present;
process environment variables take precedence. Local runs use `data.json` beside
`index.js` by default.

| Command | Purpose |
|---------|---------|
| `npm start` | Start the server |
| `npm run dev` | Start with native Node.js watch mode |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Apply ESLint fixes |
| `npm test` | Run isolated regression tests with Node's native test runner |
| `./run_dev.sh` | Build and start the OrbStack development container |

## Server configuration

`.env` and `.env-dev` contain only server configuration. They are
versioned templates: **never commit real passwords or other credentials**.

| Variable | Purpose | Default / requirement |
|----------|---------|-----------------------|
| `PORT` | HTTP listening port | Required; templates use `3005` |
| `LOCALHOST` | Address shown in startup logs | Required; does not configure the device |
| `DATA_FILE` | Settings file location | `./data.json` beside `index.js`; Docker sets `/app/data/data.json` |

The panel opens directly without a username or password. CSRF protection prevents
cross-site writes; it does not restrict access by other users on the network.

## Panel languages

Translations live in `locale/en.json` and `locale/es.json` (Spanish from Spain).
The panel selects the first supported browser language and uses English when none
matches. Missing Spanish keys or an unavailable Spanish file fall back to English.
`public/i18n.js` loads the JSON dictionaries before the panel initializes; edit the
locale files to change copy, keeping keys and interpolation variables aligned.

## Integrations

The panel has three tabs: **Display** for content and previews; **Integrations**
for provider keys; **Device** for the hardware's display modes. Switching tabs preserves unsaved fields.
The selected tab is reflected in `#display`, `#integrations` or `#device`, including browser
back/forward navigation. Missing-key links open the matching provider card.

Manage provider keys in the panel's **Integrations** tab. Password fields
are never prefilled. Saving an empty, untouched field keeps its existing key;
removal is a separate explicit action. API responses only expose configured/not
configured status. Replacing or removing keys invalidates provider caches.

### GitHub

Create a [personal access token (classic)](https://github.com/settings/tokens/new)
with `read:user` for the contribution query. Start with that scope, not the broad
`repo` scope, which includes write permissions. Choose your username and add
`{{repositories}}` to your message format if you want a repository breakdown.

The displayed counts follow GitHub's contribution rules and cover the current
UTC day; they are not necessarily every commit pushed to every branch. Repository
totals sum `commitCount` across contribution records.

### Weather

Create an [OpenWeatherMap API key](https://home.openweathermap.org/api_keys), save
it in the panel, then choose the city and Celsius/Fahrenheit. A newly issued key
may need time to activate with the provider.

Saving keys stores them; a preview or device request checks that the provider
accepts them. Provider requests have a 10-second deadline. Invalid credentials,
upstream errors and invalid responses surface as errors instead of invented data.

### Custom message formats

In **Display**, choose GitHub or weather and edit **Message format**. Combine
ordinary text with variables, insert them at the cursor using the buttons, and
preview the result before saving. Each source keeps its own format.

| Source | Variables |
|--------|-----------|
| GitHub | `{{commits}}`, `{{repositories}}`, `{{username}}` |
| Weather | `{{city}}`, `{{temperature}}`, `{{unit}}`, `{{condition}}` |

Examples:

```text
Today I made {{commits}} commits. Keep going!
At {{city}}: {{temperature}} {{unit}} — {{condition}}
```

All wording comes from your template: the backend adds no `Today:`, commit labels
or weather summaries. `{{repositories}}` inserts names and counts as `repo: count,
other-repo: count`, without surrounding parentheses. Temperature is rounded;
`{{unit}}` is `C` or `F`. `{{condition}}` uses OpenWeatherMap's
`weather[0].description` (for example, `clear sky`), without locally generated
labels. Final output is normalized to printable ASCII, as with ordinary text.

Defaults are `{{commits}}` for GitHub and `{{temperature}} {{unit}}` for weather,
producing values such as `7` and `23 C`. **Reset format** restores the source's
default in the draft. Formats accept up to 2048 characters; an empty format
produces empty output. Unknown variables are rejected. Changing the format reuses
the cached provider data rather than requesting fresh data solely for formatting.

For older templates, `{{content}}` remains accepted as a scalar alias: the commit
count or rounded temperature. A template consisting only of `{{content}}` (including
whitespace inside the braces) loads as the new source-specific default. Custom
templates retain their literal text, including any wording you wrote yourself.

### LED preview

The preview renders **32 columns × 8 rows (256 square LED cells)** at a fixed 4:1
ratio, based on counting the matrix in the [official product photo](https://getdeskhub.com/hero2.webp).
Text lights individual cells; it does not use browser fonts, wrap onto extra lines
or shrink to fit. The complete ASCII output remains readable below the matrix.

The proportional bitmap font matches the visible letters in the official
[“Hello” photo](https://getdeskhub.com/desky.jpeg). The preview reports the message's
width in LED columns and how many columns lie beyond the fixed 32-column view.
**Simulate scroll**, **Pause**, the position slider and **Start** let you inspect
the complete message without sending anything to the device. Playback is opt-in
and stops when the preview leaves view, the tab is hidden or the draft changes.

Geometry is measured from the photographed model, not from a published firmware
specification. Font selection, left alignment, one-column character spacing and
80 ms per scrolling column are simulation choices; firmware behavior has not been
verified pixel-for-pixel. The preview's scroll control is independent of the
hardware's scrolling checkbox in **Device**.

## Device configuration

In **Device**, enter the DeskHub's private IPv4 address and **Save IP**. The server
(including its container) must be able to reach the device over HTTP on port 80.
Saving an IP only updates local server storage; **Check connection** reads the
device's configuration form. Opening the panel does not contact the hardware.
Clear the IP and save to unlink it.

The four **Display mode** options reproduce the observed device form:

| Mode | Options |
|------|---------|
| GitHub | GitHub username |
| API | URL, JSON key, fetch interval in milliseconds, scrolling text |
| Work Timer | Pacman or progress bar, work/rest duration (1–240 minutes), loops (1–10) |
| X Followers | X username without `@` |

For this panel's custom messages, GitHub templates or weather, choose **API** and
use `/display` with the JSON key `content`. **Use this panel** fills these values
and a 60000 ms interval. If the panel is open through localhost, enter the server's
LAN address manually. The native GitHub and X modes use the firmware's own
integrations, independently of this server's provider keys. Fetch intervals must
be whole milliseconds from 1000 to 86400000.

**Apply to DeskHub sends the complete display configuration and overwrites the
device's display settings**, including the values retained for inactive modes.
Wi-Fi is separate and is never submitted. Changing source content in **Display**
does not trigger this operation.

The inspected firmware serves an empty/default form rather than its saved settings.
This panel therefore shows defaults or its last acknowledged submission, not a
live snapshot. The server remembers the IP and last acknowledged configuration in
`device.json`. Changing the IP resets the remembered configuration for that address;
the browser keeps the current draft until reloaded or successfully applied.

Before applying, the server checks that the device still exposes the supported
form and its four modes, then posts URL-encoded fields to `/submit`. It does not
follow redirects or retry a submission. A successful HTTP acknowledgement does not
prove the physical display changed or that the firmware persisted the settings.
If the response is lost, the UI reports an unconfirmed result; inspect the device
before sending again. Incompatible firmware forms are rejected before any write.
The adapter uses only `GET /` and `POST /submit`; it never calls `/wifi`.

## Storage and upgrades

The directory containing `DATA_FILE` holds:

| File | Contents |
|------|----------|
| `data.json` (or your configured filename) | Source settings and text, no provider secrets |
| `credentials.json` | AES-256-GCM encrypted provider keys |
| `credentials.key` | Random local encryption key |
| `device.json` | Optional device IP and last acknowledged display configuration |

Credential files are created with owner-only permissions (`0600`). Back up the
whole directory: **both credential files are required to restore API keys**.
Encryption does not protect against someone who can read both files; restrict
access to the persistent volume. Runtime data and credentials are excluded from
Git and the Docker build context.

Docker stores data inside `/app/data`, mounted from `./data` in production or
`./data-dev` in development. Settings and credentials are saved by atomic rename;
failed saves preserve the previous active values. Legacy `{ "text": "..." }`
files load as text mode and upgrade on the next save. Corrupt persisted data causes
startup failure rather than silently replacing it.

### Migrate old environment-based integrations

Existing provider tokens, username, city and units can be imported without printing
the credentials. With Node.js 26, run the appropriate command before rebuilding:

```bash
# OrbStack development
node scripts/migrate-env.js .env-dev ./data-dev/data.json

# Local Node.js (use your actual settings path if DATA_FILE is customized)
node scripts/migrate-env.js .env ./data.json

# Production Compose
node scripts/migrate-env.js .env ./data/data.json
```

The tool persists provider credentials and settings before removing legacy
`GITHUB_*` and `OPENWEATHER_*` entries from the chosen environment file. It keeps
existing saved settings and refuses to overwrite a different stored credential.
New integrations are configured in the panel, not through environment variables.

Older images stored text at `/app/data.json`, outside the mounted directory.
Before recreating such a container, back up that file and copy it to the host's
`data/data.json` (or `data-dev/data.json`), checking for existing data first. A file
from a removed container cannot be recovered by the new image.

## API contract

Device content endpoints return printable ASCII text, for example:

```json
{ "content": "7" }
```

Text normalization removes accents and unsupported symbols and replaces line
breaks with spaces. The panel keeps the original text for editing. `/display` and
administration responses are sent with `Cache-Control: no-store`.

| Endpoint | Purpose | Access |
|----------|---------|--------|
| `GET /display` | Render the saved source: the fixed device URL | Public |
| `GET /commits` | GitHub output using saved GitHub settings | Public |
| `GET /weather` | Weather output using saved weather settings | Public |
| `GET /healthz` | `{ "status": "ok" }`, independent of providers | Public |
| `GET /` | Web control panel | Public |
| `GET /api/settings` | `{ settings, capabilities, csrfToken }` | Public |
| `PUT /api/settings` | Validate and persist settings; returns `{ settings }` | CSRF |
| `POST /api/preview` | Render a draft; returns `{ content, mode }`, without saving | CSRF |
| `PUT /api/credentials` | Update/remove provider keys; returns `{ capabilities }` | CSRF |
| `GET /api/device` | Locally remembered `{ device: { address, configuration, lastSentAt } }`; no hardware request | Public |
| `PUT /api/device` | Save `{ address }` (or empty string to unlink); returns `{ device }` | CSRF |
| `POST /api/device/check` | Check the saved IP's firmware form; returns `{ compatible: true }` | CSRF |
| `POST /api/device/apply` | Send `{ configuration }` to the device; remember an acknowledged submission; returns `{ device }` | CSRF |
| `GET /setDisplay?text=...` | Legacy update: save text and select text mode | CSRF |

Settings payload:

```json
{
  "mode": "text",
  "text": "Hello DeskHub",
  "github": { "username": "artcc", "showRepositories": true, "template": "{{commits}}" },
  "weather": { "city": "Madrid", "units": "metric", "template": "{{temperature}} {{unit}}" }
}
```

`mode` accepts `text`, `commits` and `weather`. Text is limited to 2048 characters,
usernames to 39 and cities to 100. Username/city may be empty only when their source
is not selected. Units accept `metric` and `imperial`.
Each source's optional `template` defaults to `{{commits}}` or
`{{temperature}} {{unit}}` when omitted, including when loading older settings
files. The deprecated `showRepositories` flag is retained for compatibility but
has no output effect; include `{{repositories}}` explicitly. Preview applies the draft template without
persisting it; `/display`, `/commits` and `/weather` use the saved templates.

Credentials payload supports `githubToken` and `weatherKey`: omitted fields are
unchanged, a nonempty string replaces a key, and `""` removes it. Unknown fields,
non-string values, whitespace and values exceeding 8192 characters are rejected.
Credentials are never returned by an API.

Device configuration payload (all fields are required, including inactive modes):

```json
{
  "configuration": {
    "mode": "api",
    "username": "",
    "apiUrl": "http://192.168.1.10:3005/display",
    "jsonKey": "content",
    "fetchRate": 60000,
    "scrollingText": true,
    "xUsername": "",
    "animationType": "pacman",
    "timerDuration": 5,
    "restDuration": 5,
    "loopCount": 1
  }
}
```

Device `mode` accepts `github`, `api`, `timer` and `xfollowers`. Address accepts
only RFC1918 IPv4 literals (10/8, 172.16/12, 192.168/16), without a scheme or port.
The submitted API URL accepts HTTP/HTTPS, without embedded credentials; do not put
secret tokens in it. JSON keys may be empty for endpoints whose firmware handling
does not require a key. Username is required in GitHub mode, X username in X mode,
and URL in API mode. Device errors include a controlled `code`; an unconfirmed
submission uses `device_unconfirmed`. HTTP 409 reports a device operation in progress.

Panel writes require JSON and the `X-CSRF-Token` returned by `GET /api/settings`.
The legacy GET writer also requires that header. Reload the panel after a server
restart to renew it. Writes without a valid token receive HTTP 403.

Errors return `{ "error": "..." }`: 400 invalid input,
403 invalid CSRF token, 413 oversized JSON, 500 storage/internal failure, 502 upstream
failure, 503 missing configuration and 504 upstream timeout.

## Docker deployment on a private server

Keep persistent storage and use the published image with `docker compose up -d`.
The published image contains only changes that have been pushed and built by CI.
For local source changes use `./run_dev.sh` on
macOS or build an image and select that image in your deployment configuration.

```bash
docker build -t custom-deskhub:local .
```

CI installs locked dependencies, runs lint and offline tests, then builds Docker
images for amd64/arm64. Pull requests do not publish images; configured non-PR
events publish to GHCR.

## Project website (GitHub Pages)

`docs/` contains the English static project website. To publish it from GitHub:

1. Open the repository's **Settings → Pages**.
2. Select **Deploy from a branch**.
3. Choose the branch containing the website and the **`/docs`** folder, then save.

No build step is required. Asset paths are relative, so the site works beneath a
repository URL such as `https://<owner>.github.io/<repository>/`. GitHub Pages
hosts the project information only; the Express backend and control panel run on
each user's own private server.

## Troubleshooting

- **Source unavailable:** configure its key in Integrations and its username/city
  in the content settings. An expired key must be replaced in the panel.
- **Requests but no display changes:** the healthcheck calls `/healthz`, not
  `/display`. Logs include status and socket peer address, although Docker may
  translate client addresses. Check the actual device URL and JSON key `content`.
- **Cannot decrypt credentials:** restore both credential files from the same
  backup. Do not delete or regenerate the key while keeping the encrypted file.
- **Preview works but hardware does not:** preview proves backend output only.
  Check LAN reachability, device polling interval and its saved configuration.

## Project layout

```text
index.js                  Express routes, CSRF protection and startup
lib/content.js            Provider requests, formatting and caching
lib/settings.js           Validation, migration and atomic settings persistence
lib/credentials.js        Validation and encrypted credential storage
lib/device.js             Device form compatibility, configuration and HTTP adapter
public/device.js          Device tab and independent hardware configuration draft
public/led-preview.js     256-cell SVG preview and local playback controls
public/led-layout.js      Bitmap message layout and clipped matrix frames
public/led-font.js        Separately licensed MD_MAX72XX printable ASCII font data
public/                   HTML, CSS and browser JavaScript
locale/en.json            English translations and fallback
locale/es.json            Spanish (Spain) translations
test/                     Isolated HTTP, CSRF, storage and provider regression tests
docs/deskhub-logo.svg      README brand icon
docs/index.html           English project website for GitHub Pages
scripts/migrate-env.js    One-time migration of legacy provider configuration
Dockerfile                Shared production/development image
docker-compose.yml        Private-server deployment
docker-compose-dev.yml    Standalone OrbStack development configuration
run_dev.sh                Development build/start helper
AGENTS.md                 Repository instructions for coding agents
```

Tests use temporary storage, synthetic credentials and mocked upstream responses;
they do not contact GitHub/OpenWeatherMap or modify the physical device. Device
tests use a synthetic firmware form and mocked HTTP transport. Physical application
of the four firmware modes has not been verified by these tests.

## License

Apache 2.0 — see [LICENSE](LICENSE).

The bitmap font in [`public/led-font.js`](public/led-font.js) is adapted from
[MD_MAX72XX](https://github.com/MajicDesigns/MD_MAX72XX), copyright (C) 2012–14
Marco Colli, and is distributed separately under **LGPL-2.1-or-later**, without
warranty. See the source header and the full
[font license](public/licenses/MD_MAX72XX-LGPL-2.1.txt). The font remains a separate,
unminified, replaceable JavaScript module; no font download is required at runtime.
