#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
. "$repo_root/deploy/dify/versions.env"
target=${1:-"$repo_root/.local/dify-$DIFY_VERSION"}
start=${2:-""}

"$repo_root/scripts/dify/check-prerequisites.sh"

if [ -e "$target" ]; then
  echo "Refusing to overwrite existing Dify target: $target" >&2
  exit 1
fi

mkdir -p "$(dirname -- "$target")"
git clone --depth 1 --branch "$DIFY_VERSION" https://github.com/langgenius/dify.git "$target"
actual_commit=$(git -C "$target" rev-parse --short=7 HEAD)
if [ "$actual_commit" != "$DIFY_RELEASE_COMMIT_SHORT" ]; then
  echo "Pinned Dify tag resolved to unexpected commit: $actual_commit" >&2
  exit 1
fi

cp "$target/docker/.env.example" "$target/docker/.env"
echo "Prepared Dify $DIFY_VERSION at $target. Secrets were not printed."

if [ "$start" = "--start" ]; then
  if [ "${TONGPIN_DIFY_LICENSE_APPROVED:-}" != "1" ]; then
    echo "Set TONGPIN_DIFY_LICENSE_APPROVED=1 only after confirming the Dify deployment/license scope." >&2
    exit 1
  fi
  docker compose -f "$target/docker/docker-compose.yaml" --env-file "$target/docker/.env" up -d
  docker compose -f "$target/docker/docker-compose.yaml" --env-file "$target/docker/.env" ps
else
  echo "Containers were not started. Re-run with --start after reviewing docker/.env and the license boundary."
fi
