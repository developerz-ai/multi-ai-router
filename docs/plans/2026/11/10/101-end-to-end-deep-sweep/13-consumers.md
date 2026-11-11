# 13 — Consumers (the applications and services that call the router)

> Part of [`overview.md`](overview.md). Depends on: none. Owns: `docs/clients.md` in this repo; every other fix names a consumer repo (edited from its own repo) or an owner slice.

Read-only code + config audit, 2026-11-10. No cluster commands, no network calls, no `.env` / secret values read. Abbreviations:
`DZ` = `/home/superuser/workspace/developerz-ai/developerz.ai`, `TS` = `/home/superuser/workspace/tesote/tesote.ai`,
`DZI` = `/home/superuser/workspace/developerz-ai/infrastructure`, `TI` = `/home/superuser/workspace/tesote/infrastructure`.
Evidence grade: **read** = I read the cited lines; **sub** = a delegated read-only pass read them, not re-read by me; `unverified` = inferred.

## Consumer inventory

| Consumer | Repo path / config | Router deployment | Dialect / endpoint | Client | Stream | Models asked | Key env (NAME only) |
|---|---|---|---|---|---|---|---|
| developerz.ai cluster, `router` BYOK provider (agents-manager, worker lanes) | `DZ/packages/agent/src/providers/router.ts:55-80`, default URL `DZ/packages/domain/src/value-objects/llm-credential/wire.ts:118` | `router.ai.developerz.ai` | Anthropic `/v1/messages`, bearer, `x-session-id` | Vercel AI SDK `@ai-sdk/anthropic` | no (`generateObject`/`generateText`) | DB row per key (prod: deepseek-v4.1-flash, glm-5.3-flash, gpt-6-luna, qwen, MiniMax-M3, k3) | none — per-org encrypted BYOK row |
| developerz.ai cluster, `custom` key at router `/v1` | `DZ/packages/agent/src/providers/custom.ts:44` | either host | OpenAI `/v1/chat/completions` | `@ai-sdk/openai` `.chat()` | no | DB row (gpt-6.x) | BYOK row |
| developerz.ai fleet boxes (dz-runner), sealed per-task credential + env profile | `DZ/apps/runner/src/modes/worker/review-brain/model-resolve.ts:206-345`, `DZ/apps/runner/src/harness/model.ts:266-402`; provisioned by `DZI/scripts/lib/virt/fleet-agent.ts:56-59,135-138` | `router.ai.developerz.ai` | follows wire: Anthropic `/v1/messages` (x-api-key) or chat completions | AI SDK | yes | `MiniMax-M3` hard-coded in provisioning; `DZ_MODEL_OVERRIDE` | `DZ_BACKEND_TOKEN` / `DZ_BACKEND_TOKEN_B64`, `DZ_BACKEND_BASE_URL` — one value shared by all hv-1 runners |
| dz-runner boot preflight | `DZ/apps/runner/src/backend/preflight.ts:308-312` | same | `POST /v1/messages` or `/chat/completions`, body `{}` | raw fetch, 10 s | no | none | same as above |
| developerz.ai key verify / catalogue / probes | `DZ/packages/billing/src/router-auth-probe-url.ts:17-33`, `DZ/packages/agent/src/providers/structured-probe.ts:618`, `reasoning-probe.ts:168` | either | `GET /v1/models`, `GET /v1/catalog`; probes as the key's wire | AI SDK / fetch | no | every model on the key | BYOK row |
| developerz.ai operator probe (manual) | `DZ/scripts/infra/llm-probe.ts:129-176` | operator-supplied | both dialects, forced tool, `max_tokens: 256` | raw fetch | no | operator-supplied | operator-supplied |
| tesote.ai — all chat (backend, jobs, agent-runner, partner passthrough) via tesote's own Rust `apps/router` | `TS/apps/router/src/config/chat_upstream.rs:20-22,88`; `TI/stacks/tesote-ai/k8s/base/deployment-router.yaml:124-126` | in-cluster `multi-ai-router.multi-ai-router.svc:8080/v1` (v2.51.0) | OpenAI `/v1/chat/completions` only → ChatGPT sub (Responses) = always translated | reqwest (`TS/apps/router/src/upstream/openrouter/transport.rs:139-160`); TS side AI SDK `openai-compatible` → `apps/router` | both | `gpt-6-luna` (`TS/apps/router/src/registry.rs:278`, `pricing.rs:46`) | `CHAT_UPSTREAM_API_KEY`, `CHAT_UPSTREAM_BASE_URL` — one key `tesote-ai` |
| tesote marketing agents | `TI/stacks/marketing/k8s/overlays/production/configmap.yaml:63-67` | `router-ai.miamibeachstart.com/v1` | OpenAI (app code not in scope) | unverified | unverified | `gpt-6-luna`, `gpt-6.1-sol` | `LLM_API_KEY` (SealedSecret) |
| discord-server bot | `DZI/stacks/apps/discord-server/manifests/configmap.yml:21,24` | `router.ai.developerz.ai/v1` | OpenAI chat | app `lib/ai.ts` (not in scope) | unverified | `xiaomi/mimo-v2.6-flash` | `OPENROUTER_API_KEY` (holds a router key; SealedSecret) |
| legaldiligencemedellin article-writer | `DZI/stacks/apps/legaldiligencemedellin/manifests/configmap.yml:55,61` | same | OpenAI chat + OpenRouter `plugins:[web]` passed through | RubyLLM | unverified | not in manifest | `OPENROUTER_API_KEY` (router key; SealedSecret) |
| notificado-co KYC reader | `DZI/stacks/apps/notificado-co/manifests/configmap.yml:85-86` | same, pool `cn-models-team` | unverified | unverified | `glm-5.3-flash` | `KYC_READER_ROUTER_KEY` (SealedSecret) |
| People: Claude Code / opencode / codex | `DZI/stacks/apps/multi-ai-router/ROSTER.md` | `router.ai.developerz.ai` | both | CLI tools | yes | client-chosen | per-person keys, nothing committed |
| Operator scripts | `DZI/scripts/lib/router/client.ts:13-33`, `DZI/scripts/router/catalog.ts:48-90` | same | admin API, `GET /v1/catalog`, `/v1/providers` | fetch | no | none | `MULTI_AI_ROUTER_ADMIN_TOKEN`, `MULTI_AI_ROUTER_KEY` |

Not consumers (checked): `4fantasia.com` / `4fantasia-router` — its own Rust axum gateway to Kubeez + OpenRouter (`DZI/stacks/apps/4fantasia/manifests/deployment-router.yml`; `ROUTER_API_KEY` there is its internal bearer). `masterouter.net` — unrelated product. `ai-designer` — BYOK browser extension defaulting to openrouter.ai. `wurk` — no LLM calls. tesote fleet VMs — OpenRouter (`TI/bin/servers/enroll-fleet-vm.sh:25`). `tesote/tesote.ai-operations`, `tesote/ai-dev` — empty checkouts. `dz-prompts`, `dz-retire`, `dz-scrape`, `dz-w5` are clones of developerz.ai; `infra-router`, `infra-mon` clones of the infrastructure repo; `mar-stream` a clone of this repo — none audited separately. No committed `.claude/settings*.json` env block, `opencode.json` or codex `config.toml` points at the router in any audited repo.

## Router-side asks

- **[13] `docs/clients.md`** — add an "Errors, retries and timeouts" section (13.1). Owned here.
- **[02 dataplane]** — stream-end / in-stream error event must carry the typed `error.router` object in a form the AI SDK and tesote's Rust router can see; a relayed upstream error should still carry `x-router-*` headers (13.5, 13.9).
- **[02 dataplane / 01 transport]** — `503 no_healthy_account` and bare roll-time 503s: state `Retry-After` (or a `retryable` flag in `error.router`) so clients stop inventing 50 ms / 2 s ladders (13.4, 13.6, 13.8).
- **[02 dataplane]** — a cheap, documented, token-free "is this the right wire + is my key good" probe so clients stop POSTing `{}` to an inference route; alternatively classify an empty-object body as a probe (own usage outcome, debug log) (13.2).
- **[06 translate / 07 cost]** — document in `docs/clients.md` that translated answers have carried `usage.cost` + `cost_source` + `cost_basis` since 2.48.0, and that `cost_basis: notional` is not a spend; add an `upstream`/served-account-kind hint or point at `x-router-provider` so a downstream ledger can label the leg (13.3, 13.16).
- **[03 routing / 04 providers]** — `GET /v1/models` or `/v1/catalog` should state the per-account real context window for an alias (dz#3251, open) (13.15).
- **[07 usage / 09 web]** — "zero successes in N minutes while requests arrive" and "every member of a pool unusable" signals as metrics/alerts (dz#3252, open) (13.14).
- **[04 providers / 06 translate]** — normalise or reject-with-typed-error the known upstream quirks consumers work around: forced `tool_choice` refusal by CN upstreams, dotted tool names, dropped `verbosity` (13.17).
- **[11 devex/release]** — "done means merged, tagged, image published" has no "rolled" step; stack READMEs say 2.45.6 (13.7). (The pins themselves are live at 2.55.0 — see the correction on 13.7.)
- **[01 transport/config]** — `SHUTDOWN_DRAIN_MS` default/guidance vs measured call lengths; single-replica `Recreate` makes every roll a client-visible outage (13.6).
- **[09 web]** — key-mint "Point your tool at it" panel: state the retry/timeout guidance beside the snippet; per-key account composition via `/v1/providers` is what dz#8507 consumes — keep its shape stable or version it (13.15).

## Findings

(ranked: money and outage first)

### 13.1 high — `docs/clients.md` documents how to connect and nothing about how to fail
- **Kind:** docs
- **Where:** `docs/clients.md:1-214` (no occurrence of `Retry-After`, `402`, `x-router-`, `maxRetries`, timeout); contract lives only in `docs/KEYS.md:125-150`, `docs/idea/05-routing-and-failover.md:592-609,904-934`, `docs/idea/06-protocol-translation.md:734-758`.
- **Defect:** the one doc a client author reads never states the error contract, the typed `error.router` object, the `x-router-*` headers, the router's own failover (so SDK retries should be 0–1), the upstream clocks (first byte 5 min, idle 55 s, non-stream 10 min), `x-session-id`, `x-router-usage: cost`, or `/readyz` vs `/`.
- **Failure scenario:** every consumer below re-derived the contract from production incidents — tesote flattens 402 to a retryable 502 (13.3), developerz.ai stacks `maxRetries: 3` on the router's failover (13.4), a runner probes with `{}` (13.2), an uptime monitor hits `/` (13.10).
- **Fix:** add a section "Errors, retries and timeouts" to `docs/clients.md`: status table (copy from `docs/KEYS.md:131-138` plus `504`, `503 key_verification_unavailable`), `error.router` fields with a JSON example, the `x-router-*` header list (`x-router-request-id`, `-attempts`, `-account`, `-provider`, `-served-model`, `-session-restart`, `-usage`), "set SDK `maxRetries` to 0 or 1; never retry 402/403/401", recommended client timeouts (≥ first-byte clock for streams, ≥ `UPSTREAM_TIMEOUT_MS` for non-stream, prefer streaming), "abort the fetch on cancel", "probe with `GET /v1/models`, monitor `/readyz`", "send `x-session-id`", cost fields. Per-SDK lines for AI SDK, OpenAI SDK, Anthropic SDK, reqwest.
- **Test:** docs only; extend the existing doc-claims test if one covers `clients.md` (unverified whether one exists).

### 13.2 high — the fleet's "empty `{}` every ~8 min" poster is the dz-runner boot preflight; the cadence means a box is restart-looping
- **Kind:** bug (consumer) + router ask
- **Where:** `DZ/apps/runner/src/backend/preflight.ts:308-312` (read): `method: 'POST'`, `body: '{}'`, 10 s timeout, to the configured inference route; graded healthy on a structured 400. Wired at boot only: `DZ/apps/runner/src/wiring/backend-preflight.ts:20-31`, `boot-deps.ts:393`. Unit is `Restart=always`, `RestartSec=5` (`DZI/scripts/lib/virt/fleet-runner.ts:639-640`, sub).
- **Defect:** a deliberately invalid inference POST is the wire check; it runs once per process boot, so a periodic 400 from one fleet key is a process restarting on that period. The shared `DZ_BACKEND_TOKEN` (13.11) hides which box.
- **Failure scenario:** router `usage_records` show one key producing a 400 `invalid_request` every ~8 min → router error-rate dashboards carry permanent noise, and the real defect (a box crash/self-update loop; likely an aborted swap after quiesce per `DZ/apps/runner/docs/the-swap-preflight.md`, `unverified`) goes unnoticed.
- **Fix:** consumer (`DZ/apps/runner`): probe with `GET <base>/v1/models` (proves wire, auth and scope, no 400) and find the looping box via its journal (`swap_aborted` / `update_aborted_quiesced`). Router (slice 02): either document `GET /v1/models` as the canonical preflight in `docs/clients.md` (13.1) or record an empty-object body under its own outcome so it never counts as a client error.
- **Test:** consumer unit — preflight issues a GET and grades 200/401/403 distinctly. Router integration — `POST /v1/messages` with `{}` writes a `UsageRecord` with the dedicated outcome.

### 13.3 high — tesote's Rust router turns the router's `402` / `401` into a retryable `502`, and silently moves every `429`/`5xx` to paid OpenRouter
- **Kind:** bug (consumer)
- **Where:** `TS/apps/router/src/upstream/openrouter/upstream_error.rs:271-284` (read: "401/402/404 … stay 502"); `TS/apps/router/src/upstream/failover.rs:113-118` (read: `status == 429 || (500..600)` moves to secondary); `TS/apps/router/src/upstream/openrouter/transport.rs:37,43` (read: 3 attempts, 50 ms constant); backend retry `TS/apps/backend/src/agent/step-retry.ts:171,191` (sub).
- **Defect:** the typed contract is discarded at the first hop: `credits_exhausted` and `key_revoked` become `upstream_error` 502 which the backend re-dials at 2/4/8 s; `quota_exhausted`, `key_rate_limited` and `no_healthy_account` all fail over to the platform's OpenRouter key with only a `warn` line.
- **Failure scenario:** ChatGPT weekly window drains (already happened: 30 of 30 calls on 2026-10-17, `TS/apps/router/src/registry.rs:76-79`, sub) → 100 % of tesote chat bills on OpenRouter for days with no alert; a router-side per-key rate limit cannot cap tesote's spend, it redirects it. Billing wall → users see generic upstream failures, up to 12 dispatches per step (`step-retry.ts:68-70`, sub), nobody paged.
- **Fix:** consumer (`TS/apps/router`): read `error.router.wall` / code from the body and `Retry-After`; map 402 → non-retryable, alerting error; 401/403 → config error at `error` level; make the OpenRouter move a counted metric with an alert, and gate it on wall kind (capacity yes, `key_rate_limited` no). Router: 13.1 doc; 13.8 for `Retry-After` on 503.
- **Test:** consumer — `failover/tests.rs`: 402 from primary never dispatches secondary and renders non-retryable; `key_rate_limited` 429 does not move.

### 13.4 high — developerz.ai stacks SDK retries, key hops and uncharged redrives on top of the router's own failover
- **Kind:** bug (consumer)
- **Where:** `DZ/apps/runner/src/harness/loop.ts:630` (read: `maxRetries: TRANSIENT_PROVIDER_MAX_RETRIES`, value 3 per sub); `DZ/packages/agent/src/providers/grade.ts:415` (read: any `status >= 500` → `ProviderError`, `error.router.wall` not consulted); `DZ/packages/agent/src/loop/failover.ts:82-86` (sub: 5xx hops to the next key, each cooled 60 s); `DZ/apps/worker/src/consumers/plan-execute-call.ts:82,284` (sub: 3 attempts × 3 keys).
- **Defect:** one logical call fans to 4 × K requests (K = keys on the same router), each of which the router already walks across every account; a `503 no_healthy_account` that needs an operator is treated as transient and redriven uncharged with no count cap.
- **Failure scenario:** pool `cn-models-team` fully dark (dz#3252: 820+ `quota_exhausted` in hours, zero successes for 8 h) → the fleet multiplies load on the router exactly when nothing can serve, and never reaches a terminal state.
- **Fix:** consumer: `maxRetries: 0–1` on router keys; treat same-router-origin sibling keys as one failure domain for 5xx (no hop); grade 5xx by `error.router.wall` before status. Router (02): `Retry-After` or `retryable` on router-authored 503 so the client has a number (13.8).
- **Test:** consumer unit — a router 503 with `wall: operator` produces one request and a park, not a hop.

### 13.5 high — a mid-stream router error loses its type in both consumers
- **Kind:** bug (consumer) + router ask · part `unverified`
- **Where:** `DZ/apps/runner/src/llm/streamed-generate.ts:292,346` (sub: `@ai-sdk/anthropic` surfaces `{type, message}`, status-less rethrow no grading arm matches); `DZ/packages/domain/src/value-objects/llm-credential/router-verdict.ts:16-18` (sub: "in-stream errors carry no `error.router`"); `DZ/packages/agent/src/providers/reasoning-required.ts:9-37` (sub: 18 of 18 runs 2026-11-05); `TS/apps/router/src/upstream/openrouter/in_band_fault.rs:59-83` (sub: closed set of OpenRouter-shaped codes; router codes not in it).
- **Defect:** the stream-end / first-event error is the one place the typed verdict is not machine-readable to these clients, so a wall there is neither paced nor failed over — on developerz.ai the whole task may be re-run (up to `TASK_MAX_ATTEMPTS = 3`, `unverified` which failure kind), on tesote the turn dies unretried.
- **Failure scenario:** stream opens 200, upstream walls before content on a deployment older than 2.53.0 (both prod pins, 13.7) → client sees an untyped error, re-runs the task, duplicate spend.
- **Fix:** router slice 02: confirm the exact frame emitted per dialect and that it carries `error.router` at a path the AI SDK preserves (Anthropic `error` event body; OpenAI chunk `error`); document the frame in `docs/clients.md`. Consumers: parse it (`DZ` grading arm for status-less stream errors; `TS` add router codes to `in_band_fault.rs`).
- **Test:** router integration — streamed wall after first byte: last SSE event parses to `error.router.wall`. Consumer units mirror the frame.

### 13.6 high — every router roll is a client-visible outage and cuts any request older than 20 s; consumers built failover/sleeps around it
- **Kind:** bug (deployment) · owner: `DZI`, `TI`, router slice 01/11
- **Where:** `DZI/stacks/apps/multi-ai-router/manifests/configmap.yml:99` and `TI/stacks/multi-ai-router/k8s/base/configmap.yaml:59` (`SHUTDOWN_DRAIN_MS=20000`, sub); `DZI/.../deployment.yml:51-57,94`, `TI/.../deployment.yaml:23-28,48` (1 replica, `Recreate`, sub). Consumer workarounds: `TS/apps/router/src/upstream/failover.rs:4-11` (whole module exists for ~4 rolls/day), `DZ/apps/runner/src/llm/provider-outage.ts:59-62` (120 s wait; bare 503 for 31 s on 2026-11-05), dz#8174.
- **Defect:** drain is 20 s while tesote's own measurement of calls through it is p99 93 s, max 390 s, 15 % over 22 s (`TI/stacks/tesote-ai/k8s/base/deployment-router.yaml:101-110`, sub); the layer above drains 900 s, the router beneath it 20 s.
- **Failure scenario:** any roll (plus Reloader on re-seal on the dev cluster) → ~15 % of in-flight calls cut; on tesote all chat during the gap bills on OpenRouter (13.3); on pins < 2.53.0 the cut is a bare drop with no typed event.
- **Fix:** infra repos: raise `SHUTDOWN_DRAIN_MS` toward measured p99 (grace periods already allow 90–100 s) or run 2 replicas with a rolling strategy if the per-Account `CLAUDE_CONFIG_DIR` volume allows (slice 05 to say). Router slice 01: `docs/idea/09-deployment.md` should state drain sizing against observed call length.
- **Test:** none in this repo beyond the existing drain integration test; infra: `drain-test.sh`-style check.

### 13.7 low — stack READMEs and local infra checkouts trail the live pin (was: "both deployments trail the tag" — falsified)
- **Coordinator correction (2026-11-11):** live evidence contradicts the original claim. Both pods run `2.55.0` (10 Baseline: pod = repo = remote infra `main` pin, Argo synced; 12 Evidence window: tesote pod `2.55.0`, 44/44 migrations). The `2.52.1` / `v2.51.0` pins below were read from stale local checkouts. What survives: the stack READMEs' version cells and the stale working copies (see 10.19, 12.16), and the consumer workaround retirement below — which must first wait for 10.4, a `2.55.0` regression on the very path that hold guards. Everything else in this finding is void; "both prod pins" in 13.5's failure scenario is void too.
- **Kind:** docs / release · owner: `DZI`, `TI`, slice 11
- **Where:** `DZI/stacks/apps/multi-ai-router/manifests/deployment.yml:610` (2.52.1), `TI/stacks/multi-ai-router/k8s/overlays/production/kustomization.yaml:89-90` (v2.51.0) (sub); READMEs say 2.45.6 / "deployed: 2.40.0" (`DZI/stacks/apps/multi-ai-router/README.md`, `TI/stacks/multi-ai-router/README.md:14`).
- **Defect:** dev cluster lacks 2.53.0 (streaming wall failover + typed stream-end), 2.54.1, 2.55.0 (fast-mode forced `tool_choice` / `response_format`); tesote additionally lacks 2.52.x (`overloaded` ≠ rate limit).
- **Failure scenario:** developerz.ai keeps a probe hold for the 2026-11-08 fast-path 400 (`DZ/packages/agent/src/providers/structured-probe.ts:349-367`, sub) that 2.55.0 fixed but prod does not run; consumer workarounds cannot be retired.
- **Fix:** roll both; fix READMEs; slice 11: add "pins rolled" to the release checklist. Auditors 10/12 own the live confirmation.
- **Test:** n/a.

### 13.8 medium — router-authored `503` gives clients no number, so each invents a ladder
- **Kind:** bug (router contract) · owner: slice 02
- **Where:** `docs/KEYS.md:138` ("No `Retry-After`"); consumers: `TS/.../transport.rs:43` (50 ms constant, no jitter), `DZ` SDK 2/4/8 s, `DZ/.../provider-outage.ts` 2 s doubling to 120 s.
- **Defect:** `no_healthy_account` covers "every attempt failed" (retryable) and "model not served / account disabled" (not retryable) under one status with the distinction only in prose.
- **Failure scenario:** tesote retries a non-retryable 503 three times in 150 ms then pays OpenRouter; developerz.ai retries an operator-only 503 for an hour.
- **Fix:** slice 02 — expose `error.router.retryable` (or reuse `wall`) consistently on 503 and add `Retry-After` when retryable; document in `docs/idea/05-routing-and-failover.md` and `docs/clients.md`.
- **Test:** integration — model-unsupported 503 has `retryable: false`; all-attempts-failed 503 has `Retry-After`.

### 13.9 medium — neither consumer reads `x-router-*`; developerz.ai still grades by English prose on envelope-less seams
- **Kind:** bug (consumer) + router ask
- **Where:** `DZ/packages/domain/src/value-objects/llm-credential/router-prose.ts:50-60` (sub; four regexes incl. `N of M accounts … rate limited`, `earliest reset <ISO>Z`); `router-verdict.ts:95-114` (read: prose fallback when no envelope; strict zod enums); grep `x-router` in `TS/apps/router/src` and `DZ` → nothing (sub).
- **Defect:** a reworded router sentence, or a new `wall`/`scope` enum value, silently regrades a wall (recorded: 1,737 redrives in 12 h on 2026-10-17; two keys cooled 1 h on 2026-11-05; dz#8323 closed).
- **Failure scenario:** router adds a `scope` value → developerz.ai's zod parse fails → prose fallback reads "out of credits" in a member clause → healthy key cooled 1 h.
- **Fix:** router: treat `error.router` enum additions as a client-breaking change (CHANGELOG callout + `docs/clients.md` note "ignore unknown values, fall back to status"); keep the sentences `router-prose.ts` matches under a test until developerz.ai deletes it. Consumer: tolerant enums; read `x-router-attempts` / `x-router-request-id` into logs.
- **Test:** router unit — snapshot test of the four sentence shapes named above.

### 13.10 medium — dev-cluster uptime monitor probes the SPA shell
- **Kind:** bug (deployment) · owner: `DZI`
- **Where:** `DZI/stacks/platform/observability/blackbox-exporter/manifests/probe.yml:72` (read: `https://router.ai.developerz.ai/`). tesote probes `/readyz` (`TI/platform/observability/config/prometheus.yml:376`, sub).
- **Defect:** `/` is static; it presumably answers 200 while `/readyz` is 503 (Postgres down, draining) — `unverified` at runtime. No `NoActiveAccount`-class alert on this cluster either.
- **Failure scenario:** DB outage → every inference call fails, uptime stays green (compare dz#3252).
- **Fix:** probe `/readyz`; port tesote's five router alerts (`TI/.../alerts.yml:1266-1323`).
- **Test:** n/a.

### 13.11 medium — shared keys: no per-box / per-service attribution, wide mount on tesote
- **Kind:** structure (consumer/ops)
- **Where:** `DZI/docs/off-platform-hosts.md:443-447,576` (one `DZ_BACKEND_TOKEN` for all hv-1 runners, sub); `TI/stacks/tesote-ai/stack.yml:298` (one key `tesote-ai`), `envFrom` of `tesote-ai-secrets` into api, internal-api, jobs, agent-runner and migrate jobs (`TI/stacks/tesote-ai/k8s/base/deployment-api.yaml:148`, `deployment-jobs.yaml:94`, `deployment-agent-runner.yaml:88`, sub); NetworkPolicy admits every `app: tesote-ai` pod (`TI/stacks/multi-ai-router/k8s/base/networkpolicy.yaml:54-60`, sub); `ROSTER.md` has no row for `KYC_READER_ROUTER_KEY` or the hv-1 token (sub).
- **Defect:** usage cannot be attributed below "the fleet" / "tesote"; any tesote pod can bypass `apps/router` metering; revoking the fleet key stops every runner.
- **Failure scenario:** 13.2 cannot be pinned to a box from router data; a compromised tesote jobs pod spends the pooled subscription unmetered.
- **Fix:** per-box keys named `fleet/<box>`; split tesote's secret so only `apps/router` mounts `CHAT_UPSTREAM_API_KEY`; add the missing roster rows; notificado key on its own pool/cap like legald and discord.
- **Test:** n/a.

### 13.12 medium — developerz.ai recognises the second router host in one list of five
- **Kind:** bug (consumer)
- **Where:** `DZ/packages/domain/src/value-objects/llm-credential/router-host.ts:16-19` (read: both hosts) vs `flat-rate.ts:37` (read: dev host only), `DZ/packages/agent/src/prompt-cache.ts:55-59` (read: dev host only), `prompt-cache-plan.ts:88-99` (read: `PLATFORM_ROUTER_HOST` = default only), `wire.ts:347-350` (sub).
- **Defect:** a key on `router-ai.miamibeachstart.com` is treated as metered (no concurrency cap, dollar pricing on a pooled subscription), has every `cache_control` mark stripped, and a `custom` key there sends no `x-session-id`.
- **Failure scenario:** tesote-hosted key used from developerz.ai → no sticky session, cache hit rate collapses (the 17.4 % vs 91–96 % incident shape), unbounded fan-out.
- **Fix:** consumer: derive all four from `ROUTER_HOSTS`. Router: `docs/clients.md` should say "send `x-session-id`" (13.1).
- **Test:** consumer unit over both hosts.

### 13.13 medium — wasteful or fragile client patterns the router pays for
- **Kind:** perf (consumer)
- **Where / defect (all sub):**
  - Probes spend real tokens: structured probe `maxOutputTokens: 32_768`, 256 s, from `cron.byok_reverify` every 2 min for up to 10 keys (`DZ/packages/agent/src/providers/structured-probe.ts:210,618`, `DZ/apps/worker/src/cron/byok-reverify.ts:92`); reasoning probe up to 3 calls × every model on a key every 7 days (`reasoning-probe.ts:96-174`) — a 40-model router key = 120 billed calls per pass.
  - Non-streaming long calls: worker planner `generateObject` with a 20 min deadline (`DZ/apps/worker/src/consumers/plan-execute-call.ts:82,284`) — exceeds the router's 10 min `UPSTREAM_TIMEOUT_MS`, and silent POSTs are what edge idle timers cut (dev Traefik defaults; tesote Envoy `stream_idle_timeout: 600s`, `TI/stacks/multi-ai-router/k8s/base/envoy-config.yaml:91`).
  - Drain abandons without abort: `DZ/apps/worker/src/consumers/planner-author.ts:538-556` (read: `raceDrain` races and walks away; fetch carries only the timeout signal) → the router keeps an upstream turn alive up to 20 min for nobody.
  - Unbounded fan-out off flat-rate detection: 25 parallel classifier calls (`DZ/packages/agent/src/screen/screen.ts:125`), review 4×3, scout 12, verifier 16.
  - `key_rate_limited` mis-paced: `router-verdict.ts:95-114` (read: `throttle` false for scope `key`) → 4 requests, 60 s cool, repeat until the window resets.
  - `403 scope_violation` graded as a bad key: `DZ/packages/agent/src/providers/grade.ts:520` (read: 401 and 403 → `provider_auth_invalid`) → re-verify passes, task parks 6 h, repeats.
  - tesote: stream broken before content is re-sent to the same upstream, double-spending subscription quota (`TS/apps/router/src/upstream/openrouter/stream.rs:306-325`).
- **Failure scenario:** each is a multiplier on router load or a wrong operator signal; together they are most of the router's non-2xx volume from these keys (`unverified` against `usage_records` — auditors 10/12).
- **Fix:** consumer-side per bullet (stream the planner, pass the drain signal into the fetch, cap probe tokens, honour `Retry-After` for scope `key`, grade 403 by `error.router` code). Router: 13.1.
- **Test:** consumer units per bullet.

### 13.14 medium — open consumer issue: a fully dark pool idled the fleet 8 h with nothing alerting (dz#3252)
- **Kind:** test-gap / observability · owner: slice 07 (metrics), 09 (banner), `DZI` (alert rules)
- **Where:** developerz-ai/developerz.ai#3252 (open, updated 2026-11-06); router reset reported `(estimated)` and slid 08:55 → 09:01 → 09:58.
- **Defect:** router exposes per-account state but no pool-level "no serving member" or "zero successes while requests arrive" signal; an estimated reset that keeps sliding never concludes.
- **Failure scenario:** as filed — 820+ `quota_exhausted`, zero successes from 02:27Z, found by a human.
- **Fix:** slice 07 — gauges `router_pool_serving_members{pool}` and a success-rate counter suitable for an absent-success alert; slice 03 — an estimated reset that has slid N times should be labelled as such in `error.router` (ties to `DZ/apps/runner/src/backend-cooldown.ts:38-64` clamp workaround). Update `docs/idea/08-observability.md`.
- **Test:** unit — pool snapshot with all members unavailable sets the gauge to 0.

### 13.15 medium — open consumer issue: alias hides the real context window (dz#3251); key composition (dz#8507)
- **Kind:** bug (router contract) · owner: slices 03/04
- **Where:** developerz-ai/developerz.ai#3251 (open): `sonnet` resolves to 512k or 1,048,576 depending on the serving account; the fleet pins raw `MiniMax-M3` (`DZI/scripts/lib/virt/fleet-agent.ts:56`) to stay safe, which forfeits pool failover. dz#8507 (open) consumes `GET /v1/providers` (`apps/api/src/services/dataplane/catalog-listing.ts:122-158`).
- **Defect:** the catalogue states no per-alias minimum context window / output cap across the accounts that can serve it; also related closed dz#3741 (max_tokens vs alias target cap).
- **Failure scenario:** adding an account with a smaller window than the requested name's assumed window silently overflows sessions.
- **Fix:** slice 04 — `/v1/catalog` rows carry `context_window_min` / `max_output_tokens_min` across in-scope accounts for each listed name; document in `docs/idea/06-protocol-translation.md` alias section. Treat `/v1/providers` shape as a public contract.
- **Test:** unit — two accounts aliasing one name with different windows → the minimum is listed.

### 13.16 medium — tesote's ledger probably books the router's notional cost as a measured OpenRouter spend (`unverified` at runtime)
- **Kind:** bug (consumer) + router doc
- **Where:** `TS/apps/router/src/upstream/chat_target.rs:14,150-156` (read: stamp skipped when `usage` already has `cost`), `TS/apps/router/src/pricing.rs:7-8` ("reports tokens and no cost"), `TS/apps/router/src/upstream/openrouter/response.rs:186-190,255`, `TS/apps/backend/src/services/billing/upstream-label.ts:42` (sub); router: `docs/idea/06-protocol-translation.md:734-758` (read: every translated answer carries `cost`, `cost_source: estimated`, `cost_basis`).
- **Defect:** tesote's hop is always translated (chat → Responses), so since 2.48.0 the router's estimate is present; tesote's own price stamp never runs and the row is labelled as OpenRouter-served.
- **Failure scenario:** customer billed at the router operator's price book rather than tesote's `pricing.rs`; the "absent `cost_source` ⇒ OpenRouter account served it" heuristic (`registry.rs:88-91`) inverted. Holds only if the router has a rate for `gpt-6-luna` — confirm on one prod usage frame.
- **Fix:** consumer: read `cost_basis`; treat `notional` as attribution, not spend; label by `x-router-provider`. Router: document the three fields and the header in `docs/clients.md` (13.1). Issue #335 status: nobody audited needs the same-dialect opt-in today — developerz.ai books router keys flat-rate $0 or prices tokens from `/v1/catalog` (`DZ/apps/worker/src/fleet/usage-ingest.ts:403`, `DZ/packages/agent/src/providers/reported-cost.ts:42-44`, sub) and would not break without per-call cost; no audited code sends `x-router-usage: cost`.
- **Test:** consumer — fixture with `cost_basis: notional` books the tesote price.

### 13.17 low — standing consumer workarounds for translation / upstream quirks
- **Kind:** structure · owner: slices 04/06
- **Where (sub):** `DZ/packages/agent/src/providers/tool-choice-refusal.ts:39-76` and `router.ts:27-37` (forced `tool_choice` 400 relayed as-is; CN upstreams reject dotted tool names — dz#4513 took the fleet down); `DZ/apps/runner/src/llm/text-verbosity.ts:15-21` (translators drop `verbosity`); `TS/apps/router/src/upstream/chat_target.rs:91-116` (router reads only `reasoning_effort`, drops OpenRouter's `reasoning` object); `DZ/apps/runner/src/llm/prompt-cache.ts:15-23` (router drops `cache_control` toward a ChatGPT upstream: 97 of 148 review calls re-read a 10,880-token system prompt uncached); `DZ/packages/agent/src/providers/reasoning-options.ts:237-246` (`GO_EFFORT_MODELS`, pre-2.48.1 catalogue — deletion candidate); cluster structured calls on router keys rely on forced `tool_choice` with no `auto` re-ask (`DZ/packages/agent/src/providers/router.ts:78`).
- **Defect:** silent drops rather than typed refusals or documented mappings; each consumer rediscovers them.
- **Failure scenario:** a new consumer sends `reasoning: {effort}` or `verbosity` and gets default behaviour with a 200.
- **Fix:** slice 06 — list every silently dropped field per ingress×egress pair in `docs/idea/06-protocol-translation.md` and link from `docs/clients.md`; consider mapping `cache_control` breakpoints to `prompt_cache_key` toward OpenAI-family upstreams.
- **Test:** unit per dropped field asserting the documented behaviour.

### 13.18 low — cross-dialect by default where same-dialect exists; hard-coded model ids in manifests
- **Kind:** perf / structure (consumer)
- **Where:** tesote sends chat completions to a Responses-native ChatGPT account (`TS/apps/router/src/upstream/chat_target.rs:80-85`; router `apps/api/src/providers/drivers/openai-oauth.ts:245`, sub) and depends on translated `response_format: json_schema`, forced `tool_choice`, `reasoning_effort`; developerz.ai `custom` keys always use `.chat()` for GPT (`DZ/packages/agent/src/providers/reasoning-options.ts:443-447`, sub). Hard-coded ids: `MiniMax-M3` (`DZI/scripts/lib/virt/fleet-agent.ts:56`), `glm-5.3-flash`, `xiaomi/mimo-v2.6-flash`, `gpt-6-luna` / `gpt-6.1-sol` in manifests; tesote relies on the router account's alias `gpt-6-luna → openai/gpt-6-luna` for its OpenRouter leg.
- **Defect:** byte-passthrough (NN 10) is never exercised by tesote; an alias/catalog edit turns into `503` → paid OpenRouter (13.3) with no manifest-side signal.
- **Fix:** consumers: prefer `/v1/responses` for GPT; router `docs/clients.md`: "pick the dialect of the account behind the key" with the lossy list.
- **Test:** n/a.

## Checked, not a bug

- No `mar_live_`-shaped secret committed in any audited repo: only test fixtures (`TS/apps/router/src/config/chat_upstream.rs:115,158`, `TS/apps/router/src/upstream/failover/tests.rs:327`, `TS/apps/router/src/upstream/openrouter/tests/chat_target.rs:32`) and placeholders; infra keys are SealedSecret ciphertext or out-of-band. No router key reaches a browser bundle (`DZ/apps/api/src/routes/key-mask.ts:164-182`).
- developerz.ai never retries `402`, separates a wallet 429 from a rate limit (`DZ/packages/domain/src/value-objects/llm-credential/failure.ts:404-410`), reads the `error.router` envelope before prose, and honours `Retry-After` with jitter on generic 429s (`key-throttle.ts:109-131`).
- tesote: 403 never moves to OpenRouter; 400/422 never retried; no retry after content streamed; client disconnect drops the upstream request (`TS/apps/router/src/routes/chat.rs:290-297`); read timeout 900 s tolerates router failover waits.
- No health probe, CronJob or monitor in either infra repo calls an inference route; tesote's `health-probe.ts` hits its own `apps/router` `/health`. Catalogue polling is ~1 `/v1/catalog` GET per key per day (developerz.ai) and never reaches the router from tesote.
- Both edges are SSE-safe (no buffering, no response deadline); liveness/readiness use `/healthz` / `/readyz`.
- "Success-shaped failure" / HTML-200 handling in developerz.ai is about OpenRouter or a wrong base URL, not this router. No automatic bypass from the router to a direct provider in developerz.ai.
- `x-session-id` for stickiness is honoured by the router (fixed 2.39.12) and sent by both main consumers.

## Doc claims falsified

- `docs/clients.md:8-11` implies base URL + key is the whole integration; the contract in `docs/KEYS.md:125-150` and `docs/idea/05-routing-and-failover.md:904-934` is not linked from it.
- `TS/apps/router/src/pricing.rs:7-8` / `chat_target.rs:14` say the router "reports tokens and no cost"; `docs/idea/06-protocol-translation.md:746-748` says every translated response carries it.
- `DZI/stacks/apps/multi-ai-router/README.md` and `TI/stacks/multi-ai-router/README.md:14` state 2.45.6; manifests pin 2.52.1 / v2.51.0.

## Steps

1. This repo: write the `docs/clients.md` "Errors, retries and timeouts" section (13.1) — the only edit this slice owns.
2. Hand router asks to their slices: 02 (13.2, 13.5, 13.8), 03/04 (13.15), 06 (13.17), 07/09 (13.14), 01/11 (13.6, 13.7).
3. File issues on consumer repos (not edited from here): developerz.ai — 13.2, 13.4, 13.5, 13.9, 13.12, 13.13; tesote.ai — 13.3, 13.5, 13.16, 13.18; developerz-ai/infrastructure — 13.6, 13.7, 13.10, 13.11; tesote/infrastructure — 13.6, 13.7, 13.11.
4. Auditors 10/12: confirm from `usage_records` which key posts the `{}` 400s and its period (13.2), the OpenRouter-failover share on tesote (13.3), and one prod usage frame for `cost_basis` (13.16).

## Tests

- Docs-only in this slice. If a docs-claims test covers `docs/clients.md`, extend it; `bunx biome check docs/clients.md` is not applicable to markdown.

## Done when

- `docs/clients.md` states the status table, `error.router`, `x-router-*`, retry and timeout guidance, the preflight and monitor paths, `x-session-id` and the cost fields.
- Each router-side ask is accepted or declined by its owner slice in `overview.md`.
- Consumer issues exist for every 13.x that names a consumer repo.

## Not covered

- App code of discord-server, legaldiligencemedellin, notificado-co and tesote marketing (not in the named local checkouts' scope read here) — their timeouts, retries, streaming and 402/429 handling are unknown.
- Live state: router `usage_records`, box journals, key scopes, alias maps, price book — the `{}` cadence cause, the OpenRouter-failover volume and 13.16 are code-inferred.
- Lines marked **sub** were read by a delegated pass and not re-read by me; I re-read `preflight.ts`, `probe.yml`, `upstream_error.rs`, `failover.rs`, `transport.rs`, `chat_target.rs`, `router-host.ts`, `flat-rate.ts`, `prompt-cache.ts`, `prompt-cache-plan.ts`, `grade.ts`, `planner-author.ts`, `router-verdict.ts`, `loop.ts:630`.
- `TS/apps/router/src/upstream/adapt.rs`, `token_quota/`, `apps/tcp-router`, `TS/scripts/models/*`; developerz.ai `apps/dashboard`, `apps/api` model calls beyond probes; AI SDK internals (retry/jitter behaviour taken from the delegated read of `ai/dist`).
- Exact router stream-error frame per dialect (13.5) not traced in this repo's code — owner slice 02 to confirm.
- `gh` search limited to title/keyword queries on developerz.ai, tesote.ai, 4fantasia.com and this repo; tesote.ai returned no router issues.
