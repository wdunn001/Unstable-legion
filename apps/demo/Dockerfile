# Two-stage build: install + vite build inside, then serve the static
# bundle from a small nginx image. The build context is the repo root
# so we can `npm install` against workspaces, then copy out the demo's
# vite dist/.

FROM node:20-alpine AS build
WORKDIR /app

# Copy workspace metadata first so the install layer caches across
# source edits.
COPY package.json package-lock.json* ./
COPY packages/mesh-core/package.json packages/mesh-core/
COPY packages/mesh-react/package.json packages/mesh-react/
COPY apps/demo/package.json apps/demo/

# The mesh-core file: deps point at ../../../codec-local/packages/{web,web-safety},
# which is the build-host's path-clean symlink to the Codec repo. In the
# container we need those resolvable too — the build script that calls
# `docker compose build` (deploy.sh) copies the relevant Codec packages
# into ./codec-local/ at the repo root before invoking the build so the
# relative path resolves inside the image.
COPY codec-local/ ./codec-local/

RUN npm install --no-audit --no-fund --workspaces --include-workspace-root

COPY packages/ packages/
COPY apps/demo/ apps/demo/

# Build all the workspace TS packages first, then the demo bundle.
RUN npm run build -w @unstable-legion/core \
 && npm run build -w @unstable-legion/react \
 && npm run build -w @unstable-legion/demo

# ── runtime ──────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime

COPY --from=build /app/apps/demo/dist /usr/share/nginx/html

# SPA fallback (so a hard-reload on / works the same as on /anything).
COPY apps/demo/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
