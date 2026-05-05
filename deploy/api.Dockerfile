# Multi-stage build for the API.
# - Stage 1 (builder): install all deps via npm workspaces, compile TS → JS.
# - Stage 2 (runtime): copy compiled output + production-only deps into a slim
#   image. Final image is ~150 MB instead of ~600 MB with devDependencies.
#
# Built and pushed by .github/workflows/build-images.yml on every push to main.

ARG NODE_IMAGE=node:25-alpine

# ─── builder ───────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS builder

WORKDIR /repo

# Copy manifests first so npm ci is cached when only source files change.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN npm ci --workspaces --include-workspace-root

# Now copy the API source and tsconfig and build.
COPY apps/api/ apps/api/
RUN npm run build --workspace=apps/api

# ─── runtime ───────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Reinstall only production deps. We need every workspace's package.json
# present (npm validates the lockfile against the full workspace tree), but
# `--omit=dev` keeps devDependencies out of the runtime image.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspaces --include-workspace-root \
    && npm cache clean --force

COPY --from=builder /repo/apps/api/dist /app/apps/api/dist

EXPOSE 3001
CMD ["node", "apps/api/dist/index.js"]
