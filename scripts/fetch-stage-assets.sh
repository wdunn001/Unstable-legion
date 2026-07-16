#!/usr/bin/env bash
# Copies the legion-stage wasm glue + binary (scripts/build-wasm.sh output
# in legion-stage-runtime) into apps/demo/public/wasm/, where the Dockerfile
# picks them up as part of its normal `COPY apps/demo/ apps/demo/` — no
# Dockerfile change needed, they just need to physically exist in the build
# context before `docker compose build` runs.
#
# apps/demo/public/wasm/ is gitignored (see .gitignore) — every human dev
# and every deploy run populates it locally from a legion-stage-runtime
# checkout, same as the existing codec-local / stage-runtime file:
# dependency siblings this repo already leans on.
#
# Usage:
#   scripts/fetch-stage-assets.sh [path-to-legion-stage-runtime] [dest-dir]
# Defaults to ../legion-stage-runtime (the sibling checkout convention used
# everywhere else in this repo — see packages/*/package.json file: deps)
# and apps/demo/public/wasm (back-compat default). apps/chat needs the
# SAME wasm glue/binary (its own public/wasm/, gitignored the same way —
# see apps/chat/chatModelSource.ts's doc comment) — pass a second arg to
# fetch there instead, e.g.:
#   scripts/fetch-stage-assets.sh '' apps/chat/public/wasm

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_REPO="${1:-$ROOT/../legion-stage-runtime}"
WASM_SRC="$SRC_REPO/packages/stage-runtime/wasm"
WASM_DST="${2:-$ROOT/apps/demo/public/wasm}"

if [[ ! -f "$WASM_SRC/legion-stage.js" || ! -f "$WASM_SRC/legion-stage.wasm" ]]; then
  echo "missing legion-stage.{js,wasm} under $WASM_SRC" >&2
  echo "build them first: (cd '$SRC_REPO' && bash scripts/build-wasm.sh)" >&2
  exit 1
fi

mkdir -p "$WASM_DST"
cp "$WASM_SRC/legion-stage.js" "$WASM_SRC/legion-stage.wasm" "$WASM_DST/"

echo "fetched stage assets:"
echo "  $WASM_DST/legion-stage.js"
echo "  $WASM_DST/legion-stage.wasm"
