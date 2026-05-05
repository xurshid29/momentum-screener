# Multi-stage build for the web SPA.
# - Stage 1 (builder): vite + tsc build → static dist/.
# - Stage 2 (runtime): nginx:alpine serving the static files. Internal nginx
#   only — TLS and routing are handled by the outer nginx in compose. This
#   container exposes port 80 to the docker network and is reverse-proxied at
#   /  by the outer nginx.

ARG NODE_IMAGE=node:25-alpine

# ─── builder ───────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS builder

WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# Vite needs all deps (incl. dev) to build. Use --include-workspace-root so
# any root-level scripts/types resolve.
RUN npm ci --workspaces --include-workspace-root

COPY apps/web/ apps/web/
RUN npm run build --workspace=apps/web

# ─── runtime ───────────────────────────────────────────────────────────────
FROM nginx:alpine AS runtime

# SPA fallback config — every unknown path serves index.html so React Router
# handles the URL on the client side.
COPY deploy/web.nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /repo/apps/web/dist /usr/share/nginx/html

EXPOSE 80
