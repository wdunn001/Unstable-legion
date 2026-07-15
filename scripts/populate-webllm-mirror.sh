#!/usr/bin/env bash
# =============================================================================
# populate-webllm-mirror.sh — reproducibly populate the MLC web-llm model
# mirror that legion.codecai.net / cdn.codecai.net serve at /webllm/.
#
# WHY THIS EXISTS: the mirror (/storage/mzfs/webllm-mirror on the .198 edge,
# bind-mounted read-only into the demo container) was originally filled by a
# manual extraction with no committed populator — a fresh host would serve
# 404s for every chat model. This script captures the model list + fetch so
# the mirror is reproducible. (The old persona/small-model chat is "leave as-is"
# per the pivot plan; this is the minimum to keep /classic reproducible.)
#
# The models are @mlc-ai/web-llm prebuilt repos on HuggingFace (mlc-ai/*).
# Each is served at <mirror>/<model-id>/resolve/main/<files> — i.e. the exact
# HF "resolve/main" layout, so a plain git-lfs clone into <model-id>/ under a
# resolve/main/ subtree reproduces the served paths.
#
# Usage:  populate-webllm-mirror.sh [MIRROR_DIR]
#   MIRROR_DIR defaults to /storage/mzfs/webllm-mirror
# Env:    IPV4=1 forces IPv4 (the .88 box has an IPv6 blackhole to HF).
# Idempotent: skips a model whose mlc-chat-config.json already exists.
# =============================================================================
set -euo pipefail

MIRROR_DIR="${1:-/storage/mzfs/webllm-mirror}"
HF_BASE="https://huggingface.co/mlc-ai"

# The MLC model set the /classic chat catalog references (default fp16 +
# mobile fp32 variants). Keep in sync with
# packages/mesh-react/src/modelCatalog.ts (DEFAULT_MODEL_CATALOG / MOBILE_*).
MODELS=(
  SmolLM2-360M-Instruct-q4f16_1-MLC
  SmolLM2-360M-Instruct-q4f32_1-MLC
  Qwen2.5-0.5B-Instruct-q4f16_1-MLC
  Qwen2.5-0.5B-Instruct-q4f32_1-MLC
  Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC
  Llama-3.2-1B-Instruct-q4f16_1-MLC
  Llama-3.2-1B-Instruct-q4f32_1-MLC
  Phi-3.5-mini-instruct-q4f16_1-MLC
  Hermes-3-Llama-3.2-3B-q4f16_1-MLC
  gemma-2-2b-jpn-it-q4f16_1-MLC
)

CURL_OPTS=(-fL --retry 3)
[[ "${IPV4:-}" == "1" ]] && CURL_OPTS+=(-4)

command -v git >/dev/null || { echo "git required" >&2; exit 1; }
git lfs version >/dev/null 2>&1 || { echo "git-lfs required (git lfs install)" >&2; exit 1; }

mkdir -p "$MIRROR_DIR"
for m in "${MODELS[@]}"; do
  dst="$MIRROR_DIR/$m/resolve/main"
  if [[ -f "$dst/mlc-chat-config.json" ]]; then
    echo "skip  $m (already present)"
    continue
  fi
  echo "fetch $m -> $dst"
  mkdir -p "$dst"
  # HF serves each repo file at /resolve/main/<file>; git-lfs clone reproduces
  # the whole tree, then we flatten into resolve/main/ to match served paths.
  tmp="$(mktemp -d)"
  GIT_LFS_SKIP_SMUDGE=0 git clone --depth 1 "$HF_BASE/$m" "$tmp/$m" || {
    echo "  clone failed for $m — skipping" >&2; rm -rf "$tmp"; continue; }
  # Move repo contents into resolve/main/ (served layout).
  shopt -s dotglob
  mv "$tmp/$m"/* "$dst/" 2>/dev/null || true
  shopt -u dotglob
  rm -rf "$tmp"
done

# nginx (in-container, unprivileged) must read everything.
chmod -R a+rX "$MIRROR_DIR"
echo "done. mirror at $MIRROR_DIR — served at /webllm/<model-id>/resolve/main/..."
