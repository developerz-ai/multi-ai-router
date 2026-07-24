# syntax=docker/dockerfile:1.7
#
# multi-ai-router — the router image: Hono API + the SolidJS admin SPA it serves,
# plus the `claude` CLI the Agent SDK spawns for Claude subscription accounts.
# PostgreSQL is a separate service (see docker-compose.yml), not part of this image.
#
# NOTE: this targets the PLANNED repo layout from the design spec (§5) —
#   apps/api/    Hono server (the router)
#   apps/web/    SolidJS admin SPA (Vite)
#   packages/db  Drizzle schema + migrations + repositories
#   packages/core shared types, errors, zod schemas
# No source exists yet. The paths below are the contract the implementation is
# expected to satisfy; if the layout changes, this file changes with it.

# ---- build ----
# `oven/bun:1` (Debian-based, not the -slim/-alpine variants) for the build
# stage: it carries the toolchain bits Vite and any native postinstall scripts
# expect. Size does not matter here — nothing from this stage ships except the
# built output.
FROM oven/bun:1 AS builder
WORKDIR /src

# Manifests first, source second: this layer only busts when a dependency
# actually changes, so day-to-day source edits reuse the cached install. The
# `packages/*/package.json` globs keep workspace resolution intact — bun needs
# every workspace manifest present to build the dependency tree, but not the
# workspace source.
COPY package.json bun.lock* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/

# `--frozen-lockfile` makes the image build fail rather than silently resolving
# a different tree than CI tested. Same flag CI uses.
RUN bun install --frozen-lockfile

# Now the actual sources. `.dockerignore` keeps node_modules, dist, .git and any
# local *.db out of the context so this COPY is small and cache-stable.
COPY . .

# Produces both halves of the artifact:
#   dist/api/index.js  — the Hono server bundled with `bun build --target=bun`
#   dist/web/          — the Vite-built SPA, served as static assets by that
#                        same Hono process (same origin: no CORS, cookie auth
#                        just works — see spec §17b)
RUN bun run build

# Prune the install down to production-only, so the runtime stage copies a
# node_modules without Vite, Biome, type packages, etc. Anything the bundler
# already inlined is gone; what survives is native/externalised deps.
RUN bun install --frozen-lockfile --production

# ---- runtime ----
# -slim: Debian without the build toolchain. Not distroless — the `claude` CLI
# subprocess and the healthcheck both want a normal glibc userland with a shell.
FROM oven/bun:1-slim AS runtime
WORKDIR /app

# Non-root by default. The oven/bun images already ship an unprivileged `bun`
# user (uid/gid 1000); reusing it avoids inventing a second account.
ENV NODE_ENV=production

# ---- the `claude` CLI ----
# Claude subscription Accounts go through the Claude Agent SDK, which SPAWNS THIS
# BINARY as a subprocess (spec §11). Without it in the image, every Claude
# subscription account is dead on arrival — API-key accounts are unaffected.
#
# INSTALLED IN THE RUNTIME STAGE ON PURPOSE, and this is a trap worth stating:
# the CLI is a NATIVE binary selected for the platform's libc. Fetching it in the
# Debian builder stage and copying it into a musl runtime (alpine) produces an
# executable that cannot exec at all — the failure surfaces as a bare "no such
# file or directory" on a file that plainly exists, which is the dynamic loader
# missing, not the binary. Install it in the stage whose libc matches the runtime,
# and if the runtime base ever changes libc, this line moves with it.
#
# BUN_INSTALL puts the global bin on /usr/local/bin, which is already on PATH for
# every user — a global install under root's home would be invisible to `bun`.
ENV BUN_INSTALL=/usr/local
RUN bun install -g @anthropic-ai/claude-code

# One CLAUDE_CONFIG_DIR per Claude subscription Account lives under this root, so
# N subscriptions coexist with no cross-contamination (spec §11). Declared as a
# VOLUME so the directories — and the live credentials the CLI manages inside
# them — survive image upgrades. 0700: this tree is secret material and is NOT
# encrypted by ENCRYPTION_KEY the way the database is.
ENV CLAUDE_CONFIG_ROOT=/data/claude
RUN mkdir -p /data/claude && chown -R bun:bun /data && chmod 700 /data/claude
VOLUME ["/data/claude"]

# Ownership matters even for read-only files: the process runs as `bun`, and a
# root-owned tree is a silent trap the first time something wants to write.
COPY --from=builder --chown=bun:bun /src/dist ./dist
COPY --from=builder --chown=bun:bun /src/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /src/package.json ./package.json

# The default listen port. Overridable via `PORT` (spec §15); EXPOSE is metadata
# only, so this stays a documentation/compose hint, not an enforcement. Kept at
# 8080 so the image, docker-compose.yml and the env reference in
# docs/idea/09-deployment.md all name the same number.
ENV PORT=8080
EXPOSE 8080

USER bun

# Liveness only — `/healthz` answers without touching the DB or any upstream, so
# a router with zero healthy accounts is still "up" and does not get restart-
# looped by the orchestrator. Readiness (`/readyz`, which does check the DB and
# account health) is deliberately NOT used here: it belongs to the load balancer.
# Implemented with `bun -e` rather than curl/wget because the slim base ships
# neither, and adding one just for a healthcheck is a needless layer + CVE surface.
# start-period covers boot migrations: they run before the listener opens, and a
# failed migration exits non-zero rather than serving a half-migrated schema.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e 'const r = await fetch(`http://127.0.0.1:${process.env.PORT ?? 8080}/healthz`); process.exit(r.ok ? 0 : 1)'

# Exec form (no shell): the server receives SIGTERM directly, so in-flight
# upstream requests can be drained instead of the shell swallowing the signal.
# The entrypoint applies Drizzle migrations against DATABASE_URL first — they are
# idempotent, and a failure aborts the boot instead of opening the listener.
ENTRYPOINT ["bun", "run", "dist/api/index.js"]
