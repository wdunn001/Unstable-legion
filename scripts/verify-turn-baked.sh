#!/bin/bash
# Post-build guard against the M0.5 regression: `docker compose build`
# succeeds silently even when VITE_TURN_URLS/.env is missing — the bundle
# just ships STUN-only with no error. Run this right after
# `docker compose build legion-demo` (before `up -d`) so a missing/blank
# .env fails loud instead of quietly degrading every cross-NAT peer.
#
# Usage: scripts/verify-turn-baked.sh [expected-turn-host] [container-image]
#   scripts/verify-turn-baked.sh legion.codecai.net unstable-legion-legion-demo
set -euo pipefail

EXPECTED_HOST="${1:-legion.codecai.net}"
IMAGE="${2:-unstable-legion-legion-demo}"

echo "Checking built image '$IMAGE' bakes in turn:${EXPECTED_HOST} ..."

CID=$(docker create "$IMAGE")
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT

FOUND=$(docker run --rm --entrypoint sh "$IMAGE" -c \
  "grep -lo 'turn:${EXPECTED_HOST}' /usr/share/nginx/html/assets/*.js 2>/dev/null || true")

if [ -z "$FOUND" ]; then
  echo "FAIL: no 'turn:${EXPECTED_HOST}' string found in the built bundle." >&2
  echo "This almost certainly means VITE_TURN_URLS was blank at build time" >&2
  echo "(missing .env, or docker compose build run without --env-file)." >&2
  echo "See .env.example. Refusing to treat this build as deployable." >&2
  exit 1
fi

echo "OK: TURN config is baked into $FOUND"
