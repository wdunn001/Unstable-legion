#!/bin/bash
# Post-build guard against the PWA coming back.
#
# 2026-07-18 disabled the service worker because its app-shell cache made
# every field test unreproducible: a deployed fix could not be observed,
# since the SW kept serving the previously precached bundle +
# legion-stage.wasm. A "still broken" report could never be distinguished
# from "stale cache". See the VitePWA block in apps/chat/vite.config.ts.
#
# The disable is two settings deep (`selfDestroying: true` retires the
# worker, `manifest: false` stops the install prompt). Either one can be
# lost in a merge without breaking the build, and the failure is silent
# until users are stuck on a cached bundle again. Two branches currently
# predate the disable and WOULD reintroduce it if merged:
# feat/speech-tts-voice-loop and wip/47-incremental-load.
#
# Run this right after `docker compose build legion-chat`, before `up -d`,
# next to scripts/verify-turn-baked.sh.
#
# Usage: scripts/verify-no-pwa.sh [container-image]
#   scripts/verify-no-pwa.sh unstable-legion-legion-chat
set -euo pipefail

IMAGE="${1:-unstable-legion-legion-chat}"
ROOT=/usr/share/nginx/html

echo "Checking built image '$IMAGE' ships NO caching service worker ..."

run() { docker run --rm --entrypoint sh "$IMAGE" -c "$1"; }

fail() { echo "FAIL: $1" >&2; echo "Refusing to treat this build as deployable." >&2; exit 1; }

# 1. A precaching worker must never ship. Workbox bakes these markers into a
#    real SW; the self-destroying stub contains none of them.
SW=$(run "cat $ROOT/sw.js 2>/dev/null || true")
if [ -n "$SW" ]; then
  for marker in precacheAndRoute __WB_MANIFEST workbox-; do
    case "$SW" in
      *"$marker"*) fail "sw.js contains '$marker' — this is a PRECACHING worker. selfDestroying was lost." ;;
    esac
  done
  # 2. If sw.js exists at all it MUST be the self-destroying stub, so already
  #    installed workers in users' browsers keep getting retired.
  case "$SW" in
    *"registration.unregister()"*) : ;;
    *) fail "sw.js exists but does not call registration.unregister(). It is neither the kill-switch nor recognisable." ;;
  esac
  echo "  ok: sw.js is the self-unregistering kill-switch"
else
  # Deleting the plugin outright is ALSO wrong: workers already registered in
  # users' browsers survive removal and serve their cache forever.
  fail "no sw.js in the image. Existing installed workers will never be retired. Keep selfDestroying rather than removing VitePWA."
fi

# 3. No manifest => not installable => no standalone copy with its own storage.
if run "ls $ROOT/manifest.webmanifest $ROOT/manifest.json 2>/dev/null || true" | grep -q .; then
  fail "a web app manifest is present. 'manifest: false' was lost."
fi
echo "  ok: no web app manifest emitted"

# 4. index.html must not advertise install affordances either.
HTML=$(run "cat $ROOT/index.html")
case "$HTML" in
  *'rel="manifest"'*|*"rel='manifest'"*) fail "index.html links a manifest." ;;
esac
case "$HTML" in
  *apple-mobile-web-app-capable*|*apple-touch-icon*) fail "index.html still carries retired PWA meta tags." ;;
esac
echo "  ok: index.html advertises no install affordance"

echo "OK: $IMAGE ships no caching PWA."
