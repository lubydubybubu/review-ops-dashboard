# syntax=docker/dockerfile:1.7
# Review Ops — production image (see docs/DEPLOYMENT.md). Not built or run in this repository's CI.
#
#   docker build --target runtime -t review-ops:<git-sha> .     # the app (no dev deps, no secrets)
#   docker build --target migrate -t review-ops-migrate:<git-sha> .  # one-shot migration job
#
# Pin the base by digest at deploy review time (tag below = the Node version this was developed on):
#   FROM node:24.21.0-bookworm-slim@sha256:<digest>
ARG NODE_IMAGE=node:24.21.0-bookworm-slim

# ---- deps: exact lockfile install, no lifecycle scripts beyond the lock's own
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- build: standalone Next.js server
FROM deps AS build
COPY . .
ENV NEXT_OUTPUT_STANDALONE=1 NODE_ENV=production
RUN npx next build

# ---- migrate: one-shot jobs (migrations; `auth:revoke-all`). The ONLY place the schema-owner credential is used.
FROM deps AS migrate
COPY db ./db
COPY scripts ./scripts
COPY src ./src
ENV NODE_ENV=production OPS_DEPLOYMENT=production
USER node
# MIGRATION_DATABASE_URL_FILE (owner role) and the runtime role name come from the job's environment.
ENTRYPOINT ["node", "--import", "tsx", "scripts/migrate.ts"]
CMD ["--grant", "ops_app"]

# ---- runtime: non-root, read-only friendly, no shell tools needed
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    OPS_DEPLOYMENT=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
# Unauthenticated, fixed body ({"status":"ok"}): process up + database answering. No data, no versions.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Startup runs the server only: never migrations, never demo seed/reset.
CMD ["node", "server.js"]
