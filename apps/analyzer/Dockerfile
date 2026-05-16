# syntax=docker/dockerfile:1.7
#
# Stoa analyzer service — Node 20 + Express, deployed to Railway.
#
# Build context: this Dockerfile must be built from the *repo root* so the
# context includes packages/bot-core and packages/insight-engine (referenced
# as file: deps from apps/analyzer/package.json).
#
# Build invocation (Railway uses this with `Dockerfile path = apps/analyzer/Dockerfile`):
#   docker build -f apps/analyzer/Dockerfile .
#
# Local test:
#   docker build -f apps/analyzer/Dockerfile -t stoa-analyzer .
#   docker run --rm -p 3000:3000 --env-file apps/analyzer/.env stoa-analyzer

FROM node:20-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Copy package manifests first for better Docker-layer caching. Both
# workspace packages must be present because apps/analyzer has file: refs
# to them.
COPY packages/bot-core/package.json    packages/bot-core/package.json
COPY packages/insight-engine/package.json packages/insight-engine/package.json
COPY apps/analyzer/package.json        apps/analyzer/package.json

# Copy sources
COPY packages/bot-core    packages/bot-core
COPY packages/insight-engine packages/insight-engine
COPY apps/analyzer        apps/analyzer

# Install all workspace deps (no frozen lockfile — Railway builds without
# the root lockfile and the file: refs are resolved fresh).
WORKDIR /app/packages/bot-core
RUN pnpm install --prod=false --ignore-scripts \
  && pnpm run build

WORKDIR /app/packages/insight-engine
RUN pnpm install --prod=false --ignore-scripts \
  && pnpm run build

WORKDIR /app/apps/analyzer
RUN pnpm install --prod=false --ignore-scripts \
  && pnpm run build

# ── Runtime stage ──────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Bring built deps + service over
COPY --from=builder /app /app

WORKDIR /app/apps/analyzer

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/index.js"]
