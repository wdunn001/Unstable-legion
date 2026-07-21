#!/usr/bin/env bash
# Mirror the Whisper ASR assets to the Legion CDN as a self-hosted FALLBACK.
#
# Policy (matches the LLM model layers): Hugging Face Hub is the PRIMARY
# source; this mirror is the fallback the browser engine falls back to when
# HF is unreachable / offline (see whisperEngine.ts `modelSources`).
#
# Two asset classes are mirrored:
#   1. Model weights + tokenizer/config/ONNX for the Whisper repo, laid out
#      in HF's own path shape (`<repo>/resolve/<rev>/…`) UNDER the mirror
#      root, so transformers.js' default `remotePathTemplate` resolves
#      unchanged once `env.remoteHost` is flipped to the mirror root.
#   2. The onnxruntime-web `.wasm` binaries (point `wasmPaths` here to
#      self-host the runtime instead of transformers.js' public CDN).
#
# This WRITES to the CDN host — run it at deploy time, not from automation.
# The CDN layout here must match `LEGION_MODEL_FALLBACK_HOST` in
# whisperEngine.ts (default `https://cdn.codecai.net/webllm/hf/`).
#
# Usage:
#   MIRROR_SSH=william@192.168.1.198 \
#   MIRROR_ROOT=/storage/mzfs/webllm-mirror/hf \
#   ORT_VERSION=1.22.0 \
#   ./mirror-whisper-to-cdn.sh [Xenova/whisper-base]
set -euo pipefail

REPO="${1:-Xenova/whisper-base}"
REV="${REV:-main}"
MIRROR_SSH="${MIRROR_SSH:?set MIRROR_SSH, e.g. william@192.168.1.198}"
MIRROR_ROOT="${MIRROR_ROOT:?set MIRROR_ROOT, e.g. /storage/mzfs/webllm-mirror/hf}"
ORT_VERSION="${ORT_VERSION:-1.22.0}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Fetching HF repo $REPO@$REV (weights + config + onnx)"
# huggingface_hub CLI keeps the repo's exact file layout; --local-dir gives us
# a plain tree we can rsync. onnx weights live under onnx/.
if command -v huggingface-cli >/dev/null 2>&1; then
  huggingface-cli download "$REPO" --revision "$REV" --local-dir "$WORK/repo" >/dev/null
else
  echo "huggingface-cli not found; falling back to git-lfs clone" >&2
  git clone --depth 1 --branch "$REV" "https://huggingface.co/$REPO" "$WORK/repo"
fi

# HF-layout target: <root>/<repo>/resolve/<rev>/<files>
DEST_REL="$REPO/resolve/$REV"
echo "==> Staging model files under $MIRROR_ROOT/$DEST_REL"
ssh "$MIRROR_SSH" "mkdir -p '$MIRROR_ROOT/$DEST_REL'"
rsync -av --delete "$WORK/repo/" "$MIRROR_SSH:$MIRROR_ROOT/$DEST_REL/"

echo "==> Mirroring onnxruntime-web $ORT_VERSION wasm binaries"
# Pull the exact wasm set from npm (same package version the app resolves).
npm pack "onnxruntime-web@$ORT_VERSION" --pack-destination "$WORK" >/dev/null
tar -xzf "$WORK"/onnxruntime-web-*.tgz -C "$WORK"
WASM_SRC="$WORK/package/dist"
ssh "$MIRROR_SSH" "mkdir -p '$MIRROR_ROOT/ort/$ORT_VERSION'"
rsync -av --include='*.wasm' --include='*.mjs' --exclude='*' \
  "$WASM_SRC/" "$MIRROR_SSH:$MIRROR_ROOT/ort/$ORT_VERSION/"

cat <<EOF

==> Done.
   Weights:  https://cdn.codecai.net/webllm/hf/$DEST_REL/
   Wasm:     https://cdn.codecai.net/webllm/hf/ort/$ORT_VERSION/
Wire the fallback in the app:
   createWhisperEngine({
     // HF stays primary; this is the fallback (already the default host):
     modelSources: [HF_MODEL_HOST, 'https://cdn.codecai.net/webllm/hf/'],
     // self-host the runtime wasm off the public CDN (optional):
     wasmPaths: 'https://cdn.codecai.net/webllm/hf/ort/$ORT_VERSION/',
   })
EOF
