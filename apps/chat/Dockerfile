# Two-stage build: install + vite build inside, then serve the static
# bundle from a small nginx image. Mirrors apps/demo/Dockerfile's proven
# shape (same workspace-install layering, same codec-local/legion-stage-
# runtime materialization story) — see that file's comments for the full
# rationale of each COPY below.
#
# M6 root-swap: this image now builds BOTH apps/chat (the flagship
# product, served at `/`) AND apps/demo (the original workstream
# showcase, served at `/classic/`) — one nginx, one container, two
# location roots. See apps/chat/nginx.conf for the routing and
# README.md's "CI + deploy" section for why (nginx-proxy routes by
# HOSTNAME, not path, so two separate VIRTUAL_HOST containers can't
# both answer legion.codecai.net at different paths). apps/demo is
# built with `--base=/classic/` so its emitted asset URLs resolve under
# that subpath instead of colliding with the chat bundle's own /assets/.

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/mesh-core/package.json packages/mesh-core/
COPY packages/mesh-react/package.json packages/mesh-react/
COPY apps/chat/package.json apps/chat/
COPY apps/demo/package.json apps/demo/

# codec-local/ and .deploy-context/legion-stage-runtime/ — see
# apps/demo/Dockerfile's comments; scripts/prepare-deploy-context.sh
# materializes both as real files (not symlinks) before `docker compose
# build`, since Docker's build-context tar doesn't dereference symlinks
# pointing outside the context.
COPY codec-local/ ./codec-local/
COPY .deploy-context/legion-stage-runtime/ /legion-stage-runtime/

RUN npm install --no-audit --no-fund --workspaces --include-workspace-root

COPY packages/ packages/
COPY apps/chat/ apps/chat/
COPY apps/demo/ apps/demo/

# Build-time TURN config — same convention as apps/demo/Dockerfile. Both
# apps/chat and apps/demo read the SAME VITE_TURN_* args (both go through
# packages/mesh-core/src/iceServers.ts), so one set of ARG/ENV covers both
# builds below — no credential is duplicated or re-entered, just reused.
ARG VITE_TURN_URLS=
ARG VITE_TURN_USERNAME=
ARG VITE_TURN_CREDENTIAL=
ARG VITE_TURN_USE_DEFAULT=
# OpenPanel analytics (apps/chat only — telemetry.quasarke.net). Build-time
# only (Vite inlines import.meta.env.VITE_*). Absent → tracking is a no-op
# (the app never depends on analytics being reachable). CLIENT_ID comes from
# the "Legion Chat" OpenPanel project (created in the dashboard behind
# Authentik) — see apps/chat README / docs/TELEMETRY.md.
ARG VITE_OPENPANEL_CLIENT_ID=
ARG VITE_OPENPANEL_API_URL=
ARG VITE_OPENPANEL_SCRIPT_URL=
ENV VITE_TURN_URLS=$VITE_TURN_URLS \
    VITE_TURN_USERNAME=$VITE_TURN_USERNAME \
    VITE_TURN_CREDENTIAL=$VITE_TURN_CREDENTIAL \
    VITE_TURN_USE_DEFAULT=$VITE_TURN_USE_DEFAULT \
    VITE_OPENPANEL_CLIENT_ID=$VITE_OPENPANEL_CLIENT_ID \
    VITE_OPENPANEL_API_URL=$VITE_OPENPANEL_API_URL \
    VITE_OPENPANEL_SCRIPT_URL=$VITE_OPENPANEL_SCRIPT_URL

RUN npm run build -w @unstable-legion/core \
 && npm run build -w @unstable-legion/react \
 && npm run build -w @unstable-legion/chat \
 && npm run build -w @unstable-legion/demo -- --base=/classic/

# ── runtime ──────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

COPY --from=build /app/apps/chat/dist /usr/share/nginx/html
COPY --from=build /app/apps/demo/dist /usr/share/nginx/html/classic

# apps/demo's public/.well-known/{codec,mcp}/ (tokenizer maps + MCP
# registry snapshot, fetched at ROOT-absolute paths by mesh-react's
# useCodecMap/useMcpRegistry — see those files' DEFAULT_URL constants)
# ships inside demo/dist/.well-known/ same as any other public/ asset,
# which lands under /classic/.well-known/ once copied above. apps/chat
# doesn't call those hooks (its own stageWorker detokenizes locally via
# stage-runtime, not the MLC tokenizer-map path — see App.tsx's comment
# on deliberately not reusing MeshChatPanel), so it ships no .well-known/
# of its own. Mirror demo's copy to the root too so `/.well-known/codec/`
# keeps resolving at the bare hostname exactly like it always has,
# regardless of which app a given client/tool expects it under.
COPY --from=build /app/apps/demo/dist/.well-known /usr/share/nginx/html/.well-known

COPY apps/chat/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
