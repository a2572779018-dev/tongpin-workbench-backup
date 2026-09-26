#!/usr/bin/env bash
# Reproduces every OpenSquilla router artifact in this repository from the
# pinned upstream commit:
#   electron/opensquilla-router/bundle/                         converted runtime bundle
#   src/features/tongpin-ai/opensquilla/unicodeTables.generated.ts
#   src/features/tongpin-ai/opensquilla/__fixtures__/reference-v4.2.json
# Requires git, uv (or python3.12 + pip) and network access to GitHub/PyPI.
# Usage: scripts/opensquilla-router/rebuild.sh [work-dir]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/scripts/opensquilla-router"
WORK="${1:-$ROOT/.data/opensquilla-router}"
COMMIT=d27ba0e7ac452392b7c8e38f2f7f43cd5d6912c6
mkdir -p "$WORK"

if [ ! -d "$WORK/opensquilla/.git" ]; then
  GIT_LFS_SKIP_SMUDGE=1 git clone --filter=blob:none https://github.com/TokenRhythm/opensquilla.git "$WORK/opensquilla"
fi
git -C "$WORK/opensquilla" -c advice.detachedHead=false checkout --quiet "$COMMIT"

if [ ! -x "$WORK/venv/bin/python" ]; then
  if command -v uv >/dev/null 2>&1; then
    uv venv --python 3.12 "$WORK/venv"
    VIRTUAL_ENV="$WORK/venv" uv pip sync "$HERE/requirements-reference.txt"
  else
    python3.12 -m venv "$WORK/venv"
    "$WORK/venv/bin/pip" install --no-deps -r "$HERE/requirements-reference.txt"
  fi
fi
PY="$WORK/venv/bin/python"

"$PY" "$HERE/fetch_bundle.py" --clone "$WORK/opensquilla" --out "$WORK/v4.2_phase3_inference"
"$PY" "$HERE/gen_unicode_tables.py" --tokenizer "$WORK/v4.2_phase3_inference/bge_onnx/tokenizer.json" \
  --out "$ROOT/src/features/tongpin-ai/opensquilla/unicodeTables.generated.ts"
(cd "$HERE" && "$PY" make_reference.py --opensquilla-src "$WORK/opensquilla/src" --bundle "$WORK/v4.2_phase3_inference" \
  --out "$ROOT/src/features/tongpin-ai/opensquilla/__fixtures__/reference-v4.2.json")
"$PY" "$HERE/convert_bundle.py" --bundle "$WORK/v4.2_phase3_inference" --opensquilla-src "$WORK/opensquilla/src" \
  --out "$ROOT/electron/opensquilla-router/bundle" --fixture "$ROOT/src/features/tongpin-ai/opensquilla/__fixtures__/reference-v4.2.json"
echo "Rebuilt OpenSquilla router artifacts. Verify with: npx vitest run src/features/tongpin-ai/opensquilla"
