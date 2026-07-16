#!/bin/bash
# Post-build guard against the M0.5 regression: `docker compose build`
# succeeds silently even when VITE_TURN_URLS/.env is missing — the bundle
# just ships STUN-only with no error. Run this right after
# `docker compose build legion-chat` (before `up -d`) so a missing/blank
# .env fails loud instead of quietly degrading every cross-NAT peer.
#
# M6 root-swap: the built image now bundles BOTH apps/chat (served at /)
# and apps/demo (served at /classic/) from the same `legion-chat` service
# — both are built with the same VITE_TURN_* args (see
# apps/chat/Dockerfile), so one grep against the chat bundle's assets/*.js
# is sufficient; the demo build shares the identical ARG/ENV in the same
# build stage.
#
# Usage: scripts/verify-turn-baked.sh [expected-turn-host] [container-image]
#   scripts/verify-turn-baked.sh legion.codecai.net unstable-legion-legion-chat
set -euo pipefail

EXPECTED_HOST="${1:-legion.codecai.net}"
IMAGE="${2:-unstable-legion-legion-chat}"

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

# Mobile-carrier hardening (2026-07-16): the URL list must also carry the
# TLS fallback — UDP-only TURN is exactly what carriers break.
FOUND_TLS=$(docker run --rm --entrypoint sh "$IMAGE" -c \
  "grep -lo 'turns:${EXPECTED_HOST}' /usr/share/nginx/html/assets/*.js 2>/dev/null || true")
if [ -z "$FOUND_TLS" ]; then
  echo "FAIL: 'turn:' is baked but 'turns:${EXPECTED_HOST}' (TLS fallback) is missing." >&2
  echo "VITE_TURN_URLS should carry the 3-URL list — see .env.example." >&2
  exit 1
fi

echo "OK: TURN config is baked into $FOUND"
