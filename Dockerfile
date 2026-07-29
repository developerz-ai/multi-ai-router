# syntax=docker/dockerfile:1.7
#
# multi-ai-router — the router image: Hono API + the SolidJS admin SPA it serves,
# plus the `claude` CLI the Agent SDK spawns for Claude subscription accounts.
# PostgreSQL is a separate service (see docker-compose.yml), not part of this image.
#
# The repo layout this builds (design spec §5) —
#   apps/api/     Hono server (the router)
#   apps/web/     SolidJS admin SPA (Vite)
#   packages/db   Drizzle schema + migrations + repositories
#   packages/core shared types, errors, zod schemas
# If the layout changes, this file changes with it.

# ---- build ----
# `oven/bun` (Debian-based, not the -slim/-alpine variants) for the build stage:
# it carries the toolchain bits Vite and any native postinstall scripts expect.
# Size does not matter here — nothing from this stage ships except the built
# output.
#
# PINNED TO A VERSION AND A DIGEST, and both halves are load-bearing:
#
#   the version — `oven/bun:1` floats the whole major. CI runs the test suite on
#   the exact bun in .github/workflows/ci.yml's BUN_VERSION, and bun minor
#   releases change `bun test`, the bundler and the runtime often enough that a
#   floating tag means the image executes a bun nothing ever tested. The two are
#   held together by apps/api/test/integration/image-pins.test.ts, so this file
#   and that workflow cannot drift apart in silence.
#
#   the digest — a version tag is mutable. `oven/bun:1.3.0` can be re-pushed, and
#   a rebuild of an old release tag would then produce a different image from the
#   one that was tested and shipped. The digest is the only thing that makes a
#   rebuild reproducible.
#
# Both are the *index* (manifest list) digest, not a per-arch one: release.yml
# builds linux/amd64 and linux/arm64 from this same file, and a per-arch digest
# would resolve on one runner and fail on the other.
#
# To move either pin: `docker buildx imagetools inspect oven/bun:<version>` and
# copy the top-level `Digest:` line. Bump BUN_VERSION in ci.yml in the same
# commit — the drift test fails until you do.
FROM oven/bun:1.3.0@sha256:00cccad6e9c66bbacc250851f689168606aaea551ac473e908bbcf00a5645025 AS builder
WORKDIR /src

# The digest above is what actually resolves; the tag beside it is a comment the
# resolver ignores. So prove the two agree rather than trusting the pair to have
# been copied together — a digest that names a different bun than the tag claims
# is precisely the mistake this pin exists to prevent, and it is invisible in a
# diff.
RUN [ "$(bun --version)" = "1.3.0" ] || { \
      echo "base image is bun $(bun --version), not the pinned 1.3.0 — re-resolve the digest" >&2; \
      exit 1; \
    }

# The init the *runtime* stage runs as PID 1 (see its `---- PID 1 ----` block). Installed here so
# the shipped image never carries an apt cache for it, and installed *before* the source COPY so a
# source edit does not re-run an apt fetch. `tini-static` rather than `tini`: it is the same program
# with no libc to trip over on the way across stages — the trap documented at the `claude` COPY.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

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
#
# `--ignore-scripts` is a security floor, not an optimisation: a postinstall in
# any transitive dependency runs with the build's full context. Nothing we ship
# needs one — the `claude` binary arrives as a prebuilt platform package, not as
# a postinstall download (see the staging step below).
RUN bun install --frozen-lockfile --ignore-scripts

# Now the actual sources. `.dockerignore` keeps node_modules, dist, .git and any
# local *.db out of the context so this COPY is small and cache-stable.
COPY . .

# Produces both halves of the artifact:
#   dist/api/index.js  — the Hono server bundled with `bun build --target=bun`
#   dist/web/          — the Vite-built SPA, served as static assets by that
#                        same Hono process (same origin: no CORS, cookie auth
#                        just works — see spec §17b)
RUN bun run build

# ---- the `claude` binary ----
# Claude subscription Accounts go through the Claude Agent SDK, which SPAWNS A
# NATIVE `claude` BINARY as a subprocess (spec §11). Without it in the image,
# every Claude subscription account is dead on arrival — API-key accounts are
# unaffected.
#
# The binary is a prebuilt optional dependency of `@anthropic-ai/claude-agent-sdk`
# (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`), so it is already in the
# install tree at a lockfile-pinned version that cannot skew from the SDK calling
# it. Staging it here — rather than fetching `@anthropic-ai/claude-code` in the
# runtime stage — is the difference between one pinned copy and a second,
# separately versioned copy of the same executable.
#
# Resolved by the router's OWN ladder (`providers/claude-sdk/resolve-cli.ts`),
# run as source so module resolution anchors inside apps/api where the SDK's
# install tree is visible. Hard-coding the store path here would drift from the
# resolver the instant bun changes its layout — silently, which is the whole
# failure mode the ladder exists to expose. No binary, no image: the build fails
# here rather than at the first Claude subscription request.
RUN mkdir -p /opt/claude-cli \
 && cp "$(bun apps/api/src/providers/claude-sdk/print-cli-path.ts)" /opt/claude-cli/claude \
 && chmod 0755 /opt/claude-cli/claude

# Prune the install down to production-only, so the runtime stage copies a
# node_modules without Vite, Biome, type packages, etc. Anything the bundler
# already inlined is gone; what survives is native/externalised deps.
RUN bun install --frozen-lockfile --production --ignore-scripts

# …with one exception the prune cannot make: bun resolves the SDK's platform
# package for every libc it might need, so the tree holds a ~260 MB copy of the
# same executable per variant — half a gigabyte of image for a file we already
# staged on PATH and hand to the SDK explicitly (`pathToClaudeCodeExecutable`).
# Matched by size, not by store path, so a change in bun's install layout can
# neither break this line nor silently reinflate the image.
#
# THE SIZE IS A HEURISTIC, SO IT IS ASSERTED RATHER THAN TRUSTED. A bare
# `find -delete` succeeds when it matches nothing: the day the SDK's binary drops
# under 100 MB — a smaller build, a compressed payload, a split package — the
# image quietly grows back by half a gigabyte and every layer downstream still
# builds green. Nothing else in the pipeline weighs the result, so this is the
# only place that failure can be caught. Zero matches is a broken assumption, not
# a clean tree: fail here and make someone re-measure the threshold.
#
# The second sweep is not redundant. The first proves the heuristic still selects
# something; this one proves the deletion actually happened, which `find`'s exit
# status inside a command substitution would not have reported.
RUN set -eu; \
    pruned=$(find node_modules -type f -name claude -size +100M -print -delete | wc -l); \
    [ "$pruned" -gt 0 ] || { \
      echo "no claude binary over 100M in node_modules — the size heuristic no longer" >&2; \
      echo "matches the SDK's platform package, and ~500M of duplicates just shipped." >&2; \
      echo "Re-measure with: du -h \$(find node_modules -type f -name claude)" >&2; \
      exit 1; \
    }; \
    [ -z "$(find node_modules -type f -name claude -size +100M)" ] || { \
      echo "claude binaries over 100M survived the prune" >&2; \
      exit 1; \
    }; \
    echo "pruned $pruned duplicate claude binaries from node_modules"

# ---- runtime ----
# -slim: Debian without the build toolchain. Not distroless — the `claude` CLI
# subprocess and the healthcheck both want a normal glibc userland with a shell.
#
# Same version and the same kind of digest pin as the builder, for the same two
# reasons — see the block above the builder's FROM. It matters more here, not
# less: this is the bun that actually runs the router in production, and it is
# the one CI's BUN_VERSION claims the test suite covers.
FROM oven/bun:1.3.0-slim@sha256:2a5107edb70c550ea961aaa10a70ac587908f4833832390df67c18b8353eddd7 AS runtime
WORKDIR /app

RUN [ "$(bun --version)" = "1.3.0" ] || { \
      echo "runtime base is bun $(bun --version), not the pinned 1.3.0 — re-resolve the digest" >&2; \
      exit 1; \
    }

# Non-root by default. The oven/bun images already ship an unprivileged `bun`
# user (uid/gid 1000); reusing it avoids inventing a second account.
ENV NODE_ENV=production

# Which commit this image is, reported by `router_build_info{revision}` and the
# boot log. Baked in rather than derived at runtime: the runtime stage has no
# .git (`.dockerignore` excludes it) and, more to the point, a container has no
# business knowing where it was built from — the builder is the only party that
# knows. Release builds pass `--build-arg ROUTER_REVISION=<sha>`; a local
# `docker build` gets `unknown`, which is honest. It stays an ENV so an operator
# can override it on a re-tagged image without a rebuild.
ARG ROUTER_REVISION=unknown
ENV ROUTER_REVISION=${ROUTER_REVISION}

# Provenance, readable from the outside with `docker inspect` or
# `docker buildx imagetools inspect` — no `docker run` and no shell in the
# container required, which is the point: an operator holding a pulled image with
# no idea where it came from can answer "what is this, and which commit is it"
# before deciding to trust it.
#
# DECLARED HERE AND NOT ONLY IN CI. release.yml applies docker/metadata-action's
# label set on top of these, so a published image carries the richer version
# (created, ref name, and a real sha). But that means a local
# `docker build -t multi-ai-router:dev .` produced an image with no source, no
# licence and no version at all — the exact image someone builds when they are
# debugging a fork and least able to reconstruct where it came from. These are
# the floor; CI overrides what it can improve on.
#
# `version` is a restatement of packages/core/src/version.ts and is gated as one:
# `bin/verify-version` checks this line against the constant before release.yml
# builds a single layer, the same way it checks every workspace manifest. A label
# that disagrees with `/healthz` is worse than no label.
LABEL org.opencontainers.image.title="multi-ai-router" \
      org.opencontainers.image.description="Self-hosted API router — one pool of AI subscriptions and API keys behind a single OpenAI/Anthropic-compatible endpoint." \
      org.opencontainers.image.source="https://github.com/developerz-ai/multi-ai-router" \
      org.opencontainers.image.url="https://github.com/developerz-ai/multi-ai-router" \
      org.opencontainers.image.documentation="https://github.com/developerz-ai/multi-ai-router/blob/main/README.md" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="2.0.2" \
      org.opencontainers.image.revision="${ROUTER_REVISION}"

# ---- PID 1 ----
# `bun` is not an init, and this image needs one. Every Claude subscription request spawns a
# `claude` subprocess (spec §11, up to CLAUDE_SDK_MAX_CONCURRENCY at once), and anything *that*
# process spawns is re-parented to PID 1 the moment it outlives its parent. PID 1 is the only
# process the kernel will hand an orphan to, and one that never calls `wait()` leaves a zombie entry
# per orphan: a slow leak of the process table, on the longest-running process in the deployment,
# under a workload whose defining trait is a subprocess per request. Nothing in the router can fix
# that from inside — reaping is a property of PID 1, not of the code it runs.
#
# tini reaps them and forwards SIGTERM to bun unchanged, so the bounded drain in `main.ts` still
# runs and the exit code is still the router's. `-s` additionally registers it as a child subreaper,
# which is what keeps the reaping working when something puts *another* init above it — `docker run
# --init` or compose's `init: true` — since tini disables reaping when it is not PID 1 and nothing
# else in the image would notice.
COPY --from=builder /usr/bin/tini-static /usr/bin/tini
RUN tini --version

# ---- the `claude` CLI ----
# The binary staged in the builder, landing on /usr/local/bin — already on PATH
# for every user, so the CLI an operator runs (`docker exec … claude auth status`)
# and the CLI the SDK spawns are the same file. It is the real executable, not a
# shell wrapper: the SDK's launcher rejects a wrapper on some paths.
#
# THE LIBC TRAP, and it is why the next line is a `RUN` and not a comment: this is
# a NATIVE binary linked against one libc. Building on Debian/glibc and running on
# musl (alpine) produces an executable that cannot exec at all — the failure
# surfaces as a bare "no such file or directory" on a file that plainly exists,
# because the missing thing is the dynamic loader, not the binary. Both stages are
# Debian today, so the copy is sound; `claude --version` proves it *at build time*
# rather than leaving it to the first Claude subscription request. If either base
# image ever changes libc, this is the line that fails.
COPY --from=builder /opt/claude-cli/claude /usr/local/bin/claude
RUN claude --version

# One CLAUDE_CONFIG_DIR per Claude subscription Account lives under this root, so
# N subscriptions coexist with no cross-contamination (spec §11). Declared as a
# VOLUME so the directories — and the live credentials the CLI manages inside
# them — survive image upgrades. 0700: this tree is secret material and is NOT
# encrypted by ENCRYPTION_KEY the way the database is.
#
# CAUTION: a bare `VOLUME` creates an anonymous volume. In production, bind-mount
# this path to a named volume (docker-compose.yml example: `volumes:
# claude-config:/data/claude`) or a host directory for credential persistence
# across restarts. An anonymous volume is not automatically cleaned up and may
# accumulate as a separate orphan volume per container; the operator is
# responsible for either using a named volume or running `docker volume prune`.
# This bare declaration is provided for development and for operators who do not
# want Claude subscription accounts at all (in which case the volume is never
# written to and can be safely ignored).
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

# Exec form (no shell): the server receives SIGTERM directly, so in-flight upstream requests can be
# drained instead of the shell swallowing the signal. Through tini, for the reaping described above
# — it forwards the signal rather than absorbing it, so the drain is unaffected. The router applies
# Drizzle migrations against DATABASE_URL first: they are idempotent, and a failure aborts the boot
# instead of opening the listener.
#
# SHUTDOWN_DRAIN_MS bounds how long that drain waits for in-flight responses. Whatever stops this
# container must allow more than that — `stop_grace_period` in docker-compose.yml,
# `terminationGracePeriodSeconds` on Kubernetes — or the kill lands mid-drain and takes the queued
# usage rows with it.
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "bun", "run", "dist/api/index.js"]
