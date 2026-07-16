# Two-stage build: install + vite build inside, then serve the static
# bundle from a small nginx image. Mirrors apps/demo/Dockerfile's proven
# shape (same workspace-install layering, same codec-local/legion-stage-
# runtime materialization story) — see that file's comments for the full
# rationale of each COPY below.

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/mesh-core/package.json packages/mesh-core/
COPY packages/mesh-react/package.json packages/mesh-react/
COPY apps/chat/package.json apps/chat/

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

# Build-time TURN config — same convention as apps/demo/Dockerfile.
ARG VITE_TURN_URLS=
ARG VITE_TURN_USERNAME=
ARG VITE_TURN_CREDENTIAL=
ARG VITE_TURN_USE_DEFAULT=
ENV VITE_TURN_URLS=$VITE_TURN_URLS \
    VITE_TURN_USERNAME=$VITE_TURN_USERNAME \
    VITE_TURN_CREDENTIAL=$VITE_TURN_CREDENTIAL \
    VITE_TURN_USE_DEFAULT=$VITE_TURN_USE_DEFAULT

RUN npm run build -w @unstable-legion/core \
 && npm run build -w @unstable-legion/react \
 && npm run build -w @unstable-legion/chat

# ── runtime ──────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

COPY --from=build /app/apps/chat/dist /usr/share/nginx/html

COPY apps/chat/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
