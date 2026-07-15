#!/usr/bin/env bash
# Materializes this repo's two sibling-repo `file:` dependencies as real
# files inside the build context, so `docker compose build` (context: .,
# see docker-compose.yml) can resolve them. Docker's build-context tar does
# NOT dereference symlinks pointing outside the context — it ships them as
# broken symlinks — so this has to be real copied files, not the symlinks
# codec-local/ uses for local dev (see that dir's git-tracked symlink blobs,
# and apps/demo/Dockerfile's own comment about this).
#
# Populates, all gitignored:
#   codec-local/packages/{web,web-safety,web-llm}/  <- overwritten with real
#     copies (package.json + built dist/) from a Codec checkout. Only
#     touches the CHECKOUT this runs against — never the dev machine's
#     git-tracked symlinks (this script has no business running against a
#     git working tree you plan to commit from).
#   .deploy-context/legion-stage-runtime/packages/stage-runtime/  <- real
#     copy (package.json + built dist/) of @unstable-legion/stage-runtime.
#     apps/demo/Dockerfile COPYs this to /legion-stage-runtime/ in the
#     image — the exact absolute path every package.json's
#     `file:../../../legion-stage-runtime/packages/stage-runtime` (or
#     ../../ from apps/demo) resolves to once npm installs run from /app.
#   apps/demo/public/wasm/  <- delegates to fetch-stage-assets.sh.
#
# Usage:
#   scripts/prepare-deploy-context.sh [legion-stage-runtime-dir] [codec-dir]
# Both default to sibling checkouts (../legion-stage-runtime,
# ../codec-local — same convention as local dev / CI). Both siblings must
# already be BUILT (`npm run build`) before this runs.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LSR_DIR="${1:-$ROOT/../legion-stage-runtime}"
CODEC_DIR="${2:-$ROOT/../codec-local}"

require_dist() {
  local pkg_dir="$1" label="$2"
  if [[ ! -f "$pkg_dir/package.json" ]]; then
    echo "missing $label package.json: $pkg_dir/package.json" >&2
    exit 1
  fi
  if [[ ! -d "$pkg_dir/dist" ]]; then
    echo "missing $label dist/ — build it first: $pkg_dir" >&2
    exit 1
  fi
}

stage_package() {
  local src="$1" dst="$2" label="$3"
  require_dist "$src" "$label"
  rm -rf "$dst"
  mkdir -p "$dst"
  cp -a "$src/package.json" "$dst/"
  cp -a "$src/dist" "$dst/"
  [[ -d "$src/wasm" ]] && cp -a "$src/wasm" "$dst/"
  echo "staged $label -> $dst"
}

# --- codec-local: web, web-safety, web-llm ---
for pkg in web web-safety web-llm; do
  stage_package "$CODEC_DIR/packages/$pkg" "$ROOT/codec-local/packages/$pkg" "@codecai/$pkg"
done

# --- legion-stage-runtime sibling, staged for the Dockerfile to COPY to
# /legion-stage-runtime/packages/stage-runtime in the image ---
stage_package "$LSR_DIR/packages/stage-runtime" \
  "$ROOT/.deploy-context/legion-stage-runtime/packages/stage-runtime" \
  "@unstable-legion/stage-runtime"

# --- wasm glue/binary for apps/demo/public/wasm ---
bash "$ROOT/scripts/fetch-stage-assets.sh" "$LSR_DIR"

echo "deploy context ready."
