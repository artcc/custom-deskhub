# Changelog

## [1.0.0] - 2026-11-10

Initial release of the self-hosted Custom DeskHub control panel for trusted local
and private networks.

### Added

- Responsive Display, Integrations and Device tabs, with keyboard navigation,
  English and Spanish (Spain) translations, and drafts preserved between tabs.
- Custom text, GitHub contribution counts for the current UTC day, and
  OpenWeatherMap weather with Celsius or Fahrenheit units.
- Editable per-source message templates with supported variables, insertion
  controls and reset-to-default actions. User-authored text is preserved while
  device output is normalized to printable ASCII.
- Individual sources or clock-based rotation in Text → GitHub → Weather order.
  All included sources share the last acknowledged device fetch interval,
  defaulting to 60 seconds, with fallback and skipped-source diagnostics.
- Independent draft previews and a view of the saved server response. Previews
  neither persist changes nor advance rotation.
- A 32 × 7 LED matrix preview (224 cells), bitmap text, column measurements and
  optional scrolling simulation with pause, seek and restart controls.
- Provider key management in the panel, AES-256-GCM encrypted credential storage,
  a separate local encryption key and owner-only credential file permissions.
- Provider caching: five minutes for GitHub and fifteen minutes for weather,
  with bounded response sizes, timeouts and validation of upstream data.
- Optional device control over a private IPv4 address, firmware-form compatibility
  checks and complete display configuration for GitHub, API, Work Timer and
  X Followers, including scrolling and timer options. Wi-Fi settings are excluded.
- Persistent source settings, credentials and last acknowledged device configuration,
  using atomic saves and separate storage files with a configurable `DATA_FILE`.
- Compatibility with legacy text settings and templates, plus a migration utility
  for environment-based integrations.
- A fixed `/display` endpoint returning `{ "content": "..." }`, direct GitHub and
  weather endpoints, panel management endpoints and provider-independent health checks.
- CSRF protection for writes, including the legacy text endpoint. The panel opens
  without login and is intended for trusted networks.
- Node.js 26 and Express 5 backend, native browser ES modules, isolated regression
  tests and ESLint checks.
- Multi-stage Docker builds, persistent development and production Compose setups,
  health checks and an OrbStack development launcher. Build contexts include only
  application files and exclude runtime secrets and custom storage directories.
- GitHub Actions validation and multi-platform container builds for amd64 and arm64,
  with publishing to GitHub Container Registry on configured non-PR events.
- An English static documentation website, setup and API documentation, and
  Apache-2.0 project licensing with separate bitmap-font attribution and licensing.
