#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
. "$repo_root/deploy/dify/versions.env"

if ! command -v docker >/dev/null 2>&1; then
  echo "Dify prerequisite missing: docker was not found." >&2
  exit 1
fi

compose_version=$(docker compose version --short 2>/dev/null | sed 's/^v//' || true)
if [ -z "$compose_version" ]; then
  echo "Dify prerequisite missing: docker compose is unavailable." >&2
  exit 1
fi

minimum_major=$(printf '%s' "$DIFY_COMPOSE_MIN_VERSION" | cut -d. -f1)
minimum_minor=$(printf '%s' "$DIFY_COMPOSE_MIN_VERSION" | cut -d. -f2)
compose_major=$(printf '%s' "$compose_version" | cut -d. -f1)
compose_minor=$(printf '%s' "$compose_version" | cut -d. -f2)
if [ "$compose_major" -lt "$minimum_major" ] || { [ "$compose_major" -eq "$minimum_major" ] && [ "$compose_minor" -lt "$minimum_minor" ]; }; then
  echo "Dify requires Docker Compose >= $DIFY_COMPOSE_MIN_VERSION; found $compose_version." >&2
  exit 1
fi

echo "Docker Compose prerequisite satisfied: $compose_version"
echo "Pinned Dify release: $DIFY_VERSION ($DIFY_RELEASE_COMMIT_SHORT)"
echo "Pinned official Agent plugin: $DIFY_AGENT_PLUGIN_ID $DIFY_AGENT_PLUGIN_VERSION"
