#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker CLI not found. Install or open OrbStack first." >&2
  exit 1
fi

if [[ ! -f .env-dev ]]; then
  echo "Missing .env-dev. Create it with the development configuration." >&2
  exit 1
fi

compose_dev() {
  docker --context orbstack compose \
    --project-name custom-deskhub-dev \
    --env-file .env-dev \
    -f docker-compose-dev.yml \
    "$@"
}

# Validate configuration before starting OrbStack or building the image.
compose_dev config --quiet

if ! docker --context orbstack info >/dev/null 2>&1; then
  if [[ "$(uname -s)" != Darwin ]]; then
    echo "This script requires OrbStack on macOS." >&2
    exit 1
  fi
  echo "Starting OrbStack..."
  open -a OrbStack
  deadline=$((SECONDS + 60))
  until docker --context orbstack info >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      echo "OrbStack did not become ready within 60 seconds." >&2
      exit 1
    fi
    sleep 2
  done
fi

echo "Building and starting DeskHub development server..."
if ! compose_dev up --build --detach --wait --wait-timeout 90; then
  echo "Startup failed. Inspect logs with:" >&2
  echo "docker --context orbstack logs custom-deskhub-dev" >&2
  exit 1
fi

echo
echo "DeskHub is healthy. Container and published ports:"
compose_dev ps
echo "Open / in your browser for the control panel."
echo "Configure DeskHub with /display on the published port, using a server address reachable from the device."
echo "Logs: docker --context orbstack logs -f custom-deskhub-dev"
echo "Stop: docker --context orbstack stop custom-deskhub-dev"
