# 11 — Claude subscriptions via the Claude Agent SDK

Status: **built and served end to end.** `anthropic-oauth` has a driver
(`providers/claude-sdk/driver.ts`) — a *separate* interface from `ProviderDriver`, because three of
that interface's five members would be lies here (§9). A request routed to such an Account is
**served**, not refused: `resolveEgress` returns an `agent-sdk` decision,
`planCandidates` resolves the Account's `CLAUDE_CONFIG_DIR` instead of a URL, and `chain.ts`
dispatches through `runSdkAttempt`, which answers with the same `AttemptOutcome` an HTTP attempt does
— so the failover loop, the health store, the relay, and the `UsageRecord` are written once for both
transports.

The **launch** half: `providers/claude-sdk/options.ts` builds the `Options` for one
`query()` — `settingSources: []`, `strictMcpConfig: true`, `skills: []`, `tools: []`, a bounded
`maxTurns`, `includePartialMessages: true`, a server-controlled `cwd`, and one `AbortController` per
request bridged to the attempt deadline (with a `detach()` so a finished query stops retaining the
signal). `allowlist.ts` is the reviewed constant naming the tools permitted to execute on this host
— empty, because passthrough is the only supported mode — applied both as `allowedTools` and as a
deny-by-default `canUseTool` gate under `permissionMode: "dontAsk"`. `env.ts` strips the
`ANTHROPIC_*` family (by prefix, so a new variable cannot slip through), `CLAUDE_CODE_OAUTH_TOKEN`,
and the router's own secrets before the spawn, then sets `CLAUDE_CONFIG_DIR` last.
`concurrency.ts` is the semaphore pair — per-Account acquired **before** global, so a bursting
Account queues on its own budget instead of parking global capacity and starving the Pool.

The **transport** half: `providers/claude-sdk/invoker.ts` implements the `SdkInvoker` seam that
`invoke.ts` declares, and it is where every piece above is finally held at once — one body read
(`request.ts`), one prompt built from the lineage plan (`prompt.ts`), one concurrency slot, one
launch, one render. `composition/index.ts` builds it, so a subscription Account selected by routing
is dispatched rather than refused. Together with the renderer in §6 it turns SDK messages back into
Anthropic Messages — streaming and non-streaming alike. §4 (sessions), §5 (quota), §6
(re-synthesis), §7 (tools), and login/reconnect are all implemented and covered by integration tests
(`test/integration/claude-sdk.test.ts`) that drive the **real** invoker with `query()` and the
executable ladder injected, asserting the streaming byte shape, `UsageRecord.egressMode:
"agent-sdk"`, and a `rate_limit_event` driving `cooling_down` — with no HTTP call, no subprocess,
and no credential ever touching the wire. This page remains the contract that implementation must
continue to satisfy.

Two decisions the seam already commits to, both taken from §6:

- **There is no passthrough mode on this path.** `resolveEgress` never reports one for a
  subscription, even for `POST /v1/messages`, because the SDK yields message objects and the answer
  is re-synthesized rather than relayed.
- **One renderer, not one per dialect.** The SDK is rendered into the driver's own dialect
  (`anthropic`) and any other ingress dialect is then served by the *ordinary* translation pair — the
  same one an `anthropic-api` Account would have used. An Account that pins a different surface does
  not move that target.

How `anthropic-oauth` Accounts (Claude Max/Pro subscriptions) are served. Extracted from
[Meridian](https://github.com/rynfar/meridian), a working single-user proxy on this exact path;
files are cited as `tmp/meridian/src/proxy/x.ts` so every claim is checkable. Meridian's vocabulary
is *profile*; ours is **Account** — close, not identical (§10).

See also [03-providers.md](03-providers.md), [05-routing-and-failover.md](05-routing-and-failover.md),
[06-protocol-translation.md](06-protocol-translation.md).

---

## 1. Why the SDK path

Requests to a Claude subscription Account go through `@anthropic-ai/claude-agent-sdk`'s `query()` —
the documented, first-party programmatic entry point. **No OAuth token is extracted, no request is
forged against `api.anthropic.com` with a borrowed subscription token, no binary is patched.**
Anthropic keeps control of authentication, prompt caching, context management, compaction, and rate
limiting because we depend on their mechanisms rather than routing around them.

The reason is account survival: the product only works if a team's subscriptions keep working, and
injecting subscription OAuth tokens into raw HTTP is the fast path to a banned account.

**The decision is closed. The costs are listed so nobody re-opens it.**

| Cost | What it means | Evidence |
|---|---|---|
| Subprocess per request | Every `query()` spawns `node` running the `claude` CLI (a ~245 MB native binary, measured — see [09-deployment.md](09-deployment.md#sizing) and [10-roadmap.md](10-roadmap.md#open-questions)). A process, not a socket | `query.ts:252` |
| Concurrency is memory-bound | A semaphore, not a connection pool. Meridian defaults to 10 in flight, queues the rest | `server.ts:599-623` |
| The `claude` CLI ships in the image | Plus a libc-matching native binary and a PATH shim (§9) | `Dockerfile` |
| Protocol re-synthesis | The SDK yields its own message objects; responses are **rebuilt**, not relayed — even same-dialect | §6 |
| Tool handling dominates | ~40–45 % of request-path code is tool-related, most of it forcing an autonomous agent loop to behave as a single-turn endpoint | §7 |
| No passthrough fast path | The zero-loss "same dialect → forward bytes" shortcut in [06](06-protocol-translation.md) does not exist here | §6 |
| Sampling knobs are inert | `temperature`, `top_p`, `max_tokens`, `stop`, `seed`, `n`, `logprobs` have no `query()` equivalent — accepted and ignored | §6 |

Anthropic **API-key** Accounts are unaffected: plain HTTP with an API key is ordinary sanctioned
usage and keeps the normal driver. Only *subscription* Accounts take this path.

---

## 2. How a request flows

```
client (Claude Code / OpenCode / Cline / …) ─ POST /v1/messages + mar_live_… ─┐
                                                                             ▼
 ingress: key auth → key scope ∩ Pool → policy → Account       (doc 05)
                                            │  provider == anthropic-oauth
                                            ▼
 1 client detect · 2 Session resolve (header | fingerprint)
 3 lineage verify (continuation|compaction|undo|diverged) · 4 prompt · 5 tools
                                            │  concurrency semaphore
                                            ▼
 query({ prompt, options })
   env: CLAUDE_CONFIG_DIR = <this Account's dir>        ← the whole trick
   spawn node → claude CLI subprocess → Anthropic
                                            │  async-iterable of SDK messages
                                            ▼
 re-synthesis → Anthropic SSE (or OpenAI chunks)
   + block-index remap · tool-name un-prefixing · block filtering
   + rate_limit_event → Account quota state (never forwarded)
   + result.usage → UsageRecord
                                            ▼
 SSE to client · Session mapping persisted · circuit breaker updated
```

Walkthrough, grounded in `server.ts` (`handleMessages`, from :625):

1. **Admission** — request id, then a FIFO semaphore (`server.ts:602`); queue wait measured.
2. **Abort wiring** — one `AbortController` per request, linked to the HTTP signal, passed as `options.abortController` (`query.ts:259`).
3. **Validation** — non-empty messages; Anthropic *server* tools rejected `400`, the SDK cannot produce them (`tools.ts:63-98`).
4. **Account selection** — ours: Pool ∩ key scope → policy. Meridian's: profile resolution (`profiles.ts:181`) + optional priority failover (`server.ts:543`).
5. **Env assembly** — inherited `ANTHROPIC_*` credentials stripped (`server.ts:767-782`).
6. **Session + lineage** (§4) → `resume` / `forkSession` / `resumeSessionAt`, or nothing.
7. **Prompt** — verified resume sends only the *delta*; divergence sends a framed flat replay.
8. **Tool plan** (§7) — blocklists, in-process MCP registration, `PreToolUse` hook.
9. **`query()`** — `includePartialMessages: true` when streaming.
10. **Stream** — discriminate on `message.type`, re-synthesize (§6). The retry ladder applies **only before any byte reaches the client** (`server.ts:2333`).
11. **Finalize** — persist the Session mapping, write the `UsageRecord`, emit terminal frames.

### As built

`createSdkInvoker` (`providers/claude-sdk/invoker.ts`) is steps 5 through 11 in one function, and
the order above is the order it runs in. Decisions taken while building it, each narrower than the
walkthrough:

| Decision | Why |
|---|---|
| The body is decoded **once**, into the four things a launch needs — prompt, tools, system prompt, response shape (`request.ts`) | This path is the labeled exception to "never parse a passthrough body" (CLAUDE.md non-negotiable 8), and an exception that costs four parses of the same megabyte is a different exception than the one that was granted |
| The prompt is one **user** message, sent as streaming input rather than a string | A string prompt cannot carry an image, and degrading a client's images to a text note is a fidelity loss nothing forces on us. The SDK closes the subprocess's stdin once the iterable is exhausted, which is what makes a single-turn endpoint out of a bidirectional protocol |
| A conversation the SDK has never held is replayed **framed**, and a single user turn is not (`prompt.ts`) | The framing is the anti-imitation guard §4 and §10 both name; applying it to a turn that needs no replay would put a transcript preamble in front of every first message |
| The executable ladder is walked **once** per process, and only a *successful* resolution is cached | A binary does not move under a live container, so re-walking it per request is a filesystem walk on every subscription turn. A failed resolution is not cached, so an operator who fixes a mount recovers without a restart |
| The concurrency slot, the abort bridge, and the session report are all tied to the end of the **message stream**, not to `query()` returning | `query()` returns immediately; the answer arrives over the following seconds. Releasing on return would make the semaphore count calls rather than subprocesses, leak an abort listener per request, and write a session binding before the SDK had named one |
| The session is reported **once**, at the end, carrying the assistant uuid | The id arrives in `system`/`init` and the uuid only once the turn produced one, so reporting on arrival would write the row twice and the first write would have no rollback point (§4) |
| The subprocess's stderr tail is attached to a throw that carries none, never replacing one that does | It is what `errors.ts` reads to tell a crash from an auth failure, and a crash misread as an auth failure marks a working Account `needs_reauth` until a human logs in (§9) |
| A router with no usable `claude` binary fails the attempt as `unknown` → `502` + failover, before taking a slot | It is a router misconfiguration, not this Account's fault, and another transport in the same Pool may still serve the request |

---

## 3. Multi-account via config directories — the crux

`CLAUDE_CONFIG_DIR` tells the `claude` CLI where *its own state and credentials* live. Point two
subprocesses at two directories and you have two accounts in one container with no shared state.
**That is the entire mechanism.** The router never reads, decrypts, refreshes, or attaches a
subscription token; it sets one environment variable.

| Lives in an Account's config dir | Notes |
|---|---|
| `.credentials.json` | OAuth access + refresh token, `expiresAt`, scopes, `subscriptionType`. **Linux/container only.** Must be **compact** JSON — the CLI's parser reads pretty-printed JSON as "logged out" (`tokenRefresh.ts:89`) |
| CLI settings | per-account `settings.json` and friends |
| Session transcripts | what `resume: <sdkSessionId>` reads |

### Where the directory comes from

`<CLAUDE_CONFIG_ROOT>/<accountId>`, minted and created by the router when the Account row is
created — `apps/api/src/providers/claude-sdk/config-dir.ts`. The operator never types a path and
neither write body has a field for one; `CLAUDE_CONFIG_ROOT` is the only knob, and it defaults to
`/data/claude` on the persistent volume.

| Decision | Why |
|---|---|
| Keyed on Account **id**, never `label` | A label is the operator's disambiguator between five near-identical subscriptions and is renameable. Keying on it would mean a rename orphans a logged-in directory and hands the Account a fresh, logged-out one. The id is the row's identity for its whole life |
| Router-assigned, not operator-supplied | Every path an operator could type is either this one or a mistake, and one mistake is unrecoverable — see the `$HOME/.claude` trap below. A root at or under the CLI's own config directory is refused at boot for the same reason |
| Created `0700` | The contents are cleartext OAuth credentials the CLI owns. `mkdir` applies its mode only to what it creates and the umask can clear bits from it, so the mode is re-asserted on every provision — a directory left behind with looser permissions is tightened, not trusted |
| Created **before** the row, removed **before** the row | A row naming a directory that does not exist is a login that cannot happen, so provisioning comes first and an insert that never lands takes its directory back. Deletion is the mirror: credentials outliving their Account is the worse half of the failure, while a row whose subscription is logged out is visible and fixable by re-login |
| Removal names `<root>/<id>`, not the stored path | Bounded by construction. A path this router did not mint is not this router's to `rm -rf` |
| A directory no Account claims is reaped | The ordinary delete takes the directory with the row, but a crash between provisioning and the insert cannot. What is left is cleartext OAuth credentials nothing will ever rotate, revoke, or notice — so `config_dir_reap` sweeps them. See below |
| Unique index on `accounts.config_dir` | Two Accounts sharing a directory is exactly the cross-contamination isolation exists to prevent, so it is a write the database refuses rather than an invariant code has to remember |

### Traps, all load-bearing

| Trap | Rule |
|---|---|
| **macOS Keychain** | On macOS credentials live in the Keychain, not on disk; service name is `Claude Code-credentials` for the default `~/.claude` and `Claude Code-credentials-<sha256(abspath)[0:8]>` otherwise (`tokenRefresh.ts:42-47`). Mounting a dir from a macOS host carries **no credentials**. Our container is Linux, but host tooling must know |
| **Never set `CLAUDE_CONFIG_DIR=$HOME/.claude`** | Setting it *even to the default value* changes the Keychain lookup key and breaks OAuth (Meridian #453 / claude-code#20553). To use the default, **unset** it (`query.ts:27-33`) |
| **Token-based Accounts still need a pinned dir** | With `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) an isolated dir is still required, or the SDK's 401-recovery silently falls back to host credentials and masks the failure (`profiles.ts:217-227`). That dir holds SDK state only, never the credential |
| **`settingSources` must be explicitly `[]`** | Omitting it makes the CLI load user + project + local settings and slurp the **router host's** `CLAUDE.md` into the system prompt (`query.ts:296-302`) — a **cross-tenant context leak** for us |
| **Env leakage** | Strip `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` before spawning, or the subprocess can loop back through our own router |
| **claude.ai org connectors are a separate door from `strictMcpConfig`** | The CLI fetches the subscription's claude.ai-hosted MCP connectors over HTTP whenever the OAuth token carries `user:mcp_servers` — its eligibility check (CLI 0.3.220) reads env, safe mode, auth precedence, and scopes, **not** `strictMcpConfig`, which only governs filesystem config. Every `query()` launch forces `ENABLE_CLAUDEAI_MCP_SERVERS=false` (`env.ts` `QUERY_ENV_OVERRIDES`), or one Account's connector catalog is injected into another key holder's request |
| **The CLI's scratchpad block advertises a router-host path** | The injected "# Scratchpad Directory" context block names the subprocess cwd — the Account's `CLAUDE_CONFIG_DIR`, a **router** path — to a model whose tools execute on the *client*. `CLAUDE_CODE_SESSION_KIND=bg` (forced with the override above) suppresses it; the CLI's other `bg` effects are TUI rendering or `CLAUDE_JOB_DIR`-gated (Meridian #627/#628, audited against the bundled CLI). Known cost: a `bg` session registers as a running background agent, so a concurrent resume is refused — recovered by the busy-session fork retry (§9) |
| **Root** | The SDK refuses permission-skipping as root unless `IS_SANDBOX=1` (`query.ts:335`). Prefer a real UID |

### Credential lifecycle per Account

| Operation | How |
|---|---|
| Provision | `<CLAUDE_CONFIG_ROOT>/<accountId>` at `0700`, created with the Account row — see above. Idempotent, so re-provisioning is never a way to lose a login |
| Connect | Drive the `claude` CLI's own login against the Account's dir — see [§3.1](#31-connect-driving-the-clis-login). The CLI mints the PKCE verifier and `state`, exchanges the pasted code, and writes `.credentials.json` itself; the router scrapes the authorize URL out of its output and writes the pasted `code#state` back to its stdin |
| Health probe | `claude auth status --json` with the dir set returns `{loggedIn, email, subscriptionType}` — cheap, first-party, no token handling. Implemented in `providers/claude-sdk/login/status.ts`; it rides on **Re-check now** rather than getting a button of its own — see [§3.2](#32-the-credential-probe) |
| Completion probe | **Test now** (`services/accounts/test-now.ts`) is the other end of the spectrum from the health probe above: a real, opt-in `query()` turn that actually spends a turn and a subprocess. Never fires without `confirmed: true` on the request, and its own cooldown, longer than Re-check now's — see [05-routing-and-failover.md](05-routing-and-failover.md#test-now) |
| Refresh | **Not ours.** The SDK / `claude` CLI refreshes inside the config directory. The router does **not** schedule, mint, or write subscription tokens — see the box below |
| Refresh-token expiry | **A Claude subscription hard-expires ~30 days after login, however much it is used.** Verified in production (2026-09-05): every account's `refreshTokenExpiresAt` sat at exactly login + ~30 d — on accounts that had served traffic daily for weeks. Use refreshes the *access* token; nothing slides the refresh token, and when it expires the CLI blanks the tokens in `.credentials.json` (the file stays, `claude auth status` says `loggedIn: false`, a turn answers `Failed to authenticate: OAuth session expired and could not be refreshed`). No keepalive, probe, or traffic can prevent it — **only a re-login can**, so plan on reconnecting every subscription monthly. What the router does: the daily `idle_account_probe` tick runs the free `claude auth status` check over **every** subscription account, idle or not, so an expired one flips to `needs_reauth` within a day (`scheduler/tasks/idle-account-probe.ts`); the request path classifies that sentence `auth` → `needs_reauth`, never a `502`; and every admin account read carries the expiry itself — see the row below |
| Expiry visibility | The router reads **metadata, never the token**, out of `.credentials.json`: `refreshTokenExpiresAt`, `subscriptionType`, `rateLimitTier`, and whether the two token fields are non-empty (`providers/claude-sdk/credential-metadata.ts`). The Zod schema names exactly those fields, the tokens are consulted for presence only and dropped before the parsed value leaves the function, and nothing returned, thrown, or logged can carry one — non-negotiables 1 and 13 still hold: we do not touch, refresh, or use the tokens; we read when the login expires so the console can warn before it does. `withCredentialMetadata` (`services/accounts/credential.ts`) overlays it on every admin account read as `credential: { expiresAt, subscriptionType, rateLimitTier, present }` ([04-api-keys-and-access.md](04-api-keys-and-access.md#admin-api-route-groups)), cached per account for `ADMIN_CREDENTIAL_METADATA_TTL_SECONDS`, admin plane only. A read that finds blank tokens against an `active` row parks it `needs_reauth` through the same conditional write the auth probe uses; a read that *fails* reports `null` and parks nothing |
| Reconnect | Re-run login against the **same** directory: Account id, Pool membership, and usage history survive |
| Delete | Remove the directory with the Account row |
| Reap | A scheduled task (`scheduler/tasks/config-dir-reap.ts`) removes what a crash left on the volume: a directory named after an account id that no row claims, once it is older than `RETENTION_ORPHAN_CONFIG_DIR_HOURS`. It surveys the directories *before* it reads the accounts — a directory minted after the survey cannot be in it, while a row inserted after it is still read — and it never touches a name that is not an account id. Both rules exist because the failure it prevents (a stale credential nobody will rotate) is milder than the failure a careless sweep would cause (a working subscription logged out for good) |

**Concurrent subprocesses on one directory — a considered deferral.** Up to
`CLAUDE_SDK_MAX_CONCURRENCY_PER_ACCOUNT` subprocesses share one `CLAUDE_CONFIG_DIR`, each capable of
an OAuth refresh inside it, and a login or probe can touch the same directory beside them. The
router deliberately does **not** serialize them (`concurrency.ts` records the same decision beside
the gate): the CLI writes `.credentials.json` atomically and carries its own cross-process locking;
a refresh that loses a race with a concurrent rotation fails one request into the ordinary auth
classification rather than corrupting the file; and a login almost always runs against an Account
that is `needs_reauth` — a status routing already excludes — so login-vs-traffic overlap is the
reconnect edge case. The mitigation, if field evidence ever demands one, is an exclusive drain of
the per-Account gate (`acquireAll`) wired through the login path — never a quiet reduction of the
per-Account ceiling, which is throughput the pool is sized on.

> **Credential refresh for subscription Accounts is not ours to do.** Meridian implements its own
> refresh loop — proactive expiry timers, a background scheduler, direct `.credentials.json` writes
> (`tokenRefresh.ts`). **We do not.** The SDK owns those credentials inside the per-Account
> `CLAUDE_CONFIG_DIR`; our only job is to notice an auth failure from the SDK and move the Account
> to `needs_reauth`, dropping it from routing until an operator reconnects. `tokenRefresh.ts`
> remains useful only as *background on how the credential files are shaped* (compact JSON, the
> Keychain naming rule) — never as an implementation to port. This is a **skip**, not a copy;
> anyone reimplementing it has misread the design.

### 3.1 Connect — driving the CLI's login

Implemented in `providers/claude-sdk/login/` (the CLI half) and
`services/accounts/connect/claude.ts` (the checks). Two admin calls with a live subprocess between
them:

1. **`begin`** provisions `<CLAUDE_CONFIG_ROOT>/<accountId>`, spawns the CLI's login against it with
   the isolated environment from `env.ts`, and reads the authorization URL out of the child's
   output. That URL goes to the operator.
2. **`complete`** takes the pasted `code#state`, checks it against this Account's pending login, and
   writes it to the child's stdin. The CLI exchanges the code and writes `.credentials.json`.

| Rule | Why |
|---|---|
| The **CLI** mints the PKCE `code_verifier` and the `state` | The verifier never crosses back to the router — there is no field on this side that could hold it, which is a stronger guarantee than "kept server-side" ([07-security.md](07-security.md)). The router never builds an authorize URL, never calls a token endpoint, and never holds a subscription token (CLAUDE.md non-negotiable 1) |
| The **router** owns the `state`, read out of the URL | One-shot, TTL-bounded, and bound to one Account row are checks nobody downstream performs. A mismatched paste *burns* the pending login rather than allowing a retry |
| Pending logins live in memory | A pending login *is* a running subprocess. A restart kills it, so persisting the `state` would preserve a value no CLI is waiting for |
| `begin`, `complete`, and `cancel` are **serialized per Account** (`connect/turns.ts`) | Each reads this Account's one pending login and then replaces it, with a directory provision, a subprocess handshake, or a stdin write in between. Overlapping calls interleaved through that window: two CLIs against one `CLAUDE_CONFIG_DIR`, the first **orphaned** — nothing held its handle, so no cancel, no shutdown and no TTL could reach it — and its expiry timer still armed, firing later against the login that replaced it. A queue, not a single-flight: a second `begin` *supersedes* the first, which is only well defined if it runs after it. Per Account, because five subscriptions side by side must still connect at once |
| A `begin` still starting when the router stops is refused (`409 shutting_down`) | `stop()` is synchronous and cannot reach a CLI that has not printed its URL yet, so that login reads the flag when its handle appears and terminates itself. Otherwise the one subprocess shutdown cannot see is the one that outlives the router |
| TTL is `RETENTION_OAUTH_STATE_MINUTES` | The same 10-minute window as the reverse-engineered flows, and config rather than a constant (non-negotiable 11). Its timer terminates the subprocess, so an abandoned login is not a leaked process |
| Manual paste is the **only** mode here | The CLI owns its redirect URI; a router callback would mean intercepting a code meant for the CLI. The mode that needs no reachable `PUBLIC_URL` is the mode that gets the checks |
| `.credentials.json` is settled afterwards | Absent means the login did not land. Pretty-printed is re-minified in place, because the CLI's parser reads indentation as *logged out* — the worst shape a bug can take here, since the tokens are valid and every request still fails |
| Only `needs_reauth` is cleared | A connect is not a way around a `disabled` Account. Reconnect is this same call against the existing row: id, directory, Pool membership, and usage history all survive |

The admin surface is four calls (`04-api-keys-and-access.md`): `POST /:id/connect`,
`POST /:id/connect/complete`, `DELETE /:id/connect` to abandon a pending login early, and
`POST /:id/reconnect` — the same start against the same row, distinguished only so the audit log can
tell a first login (`account.connected`) from a repair (`account.reauthorized`). Which of the two it
was is *declared*, not detected: "does this directory already hold a credential" is a question only
the CLI can answer, and spawning it to label an audit row would double the cost of every connect.

### 3.2 The credential probe

`claude auth status --json` against an Account's directory answers the one question the breaker
cannot: not "is the window back" but "is this Account logged in at all". Implemented in
`providers/claude-sdk/login/status.ts` (the subprocess) and `services/health/claudeAuthProbe.ts` (the
one status transition it may drive).

| Rule | Why |
|---|---|
| It rides on **Re-check now**, not a button of its own | `services/accounts/recheck.ts` refuses to send a synthetic request because a provider would bill it and a second recovery path could disagree with the first. Neither objection applies to reading a local file, so this joins that call instead of adding a path beside it — one code path, as the half-open transition already is |
| Silence is reported as silence | A missing binary, a timeout, or unrecognised output returns *nothing*. `loggedIn: false` is only ever the CLI's own word, because the alternative is a bad mount marking healthy Accounts `needs_reauth` |
| `needs_reauth` is the only status it writes, in either direction | Logged out moves an `active` Account to `needs_reauth`; logged in clears `needs_reauth` back to `active` and audits `account.reauthorized`. A `disabled` Account is never touched, and a cooldown is left alone — being rate limited says nothing about being logged in |
| The re-check cooldown bounds it | One subprocess per Account per cooldown window, server-side. A held-down button cannot fork the container |
| It runs on the admin plane only | Per-Account, it spawns a process; on `/readyz`, which is unauthenticated by design, that would be a way to fork the container to death. `services/health/accountProbe.ts` stays a warm-memory read |

This is the answer to [§12.7](#12-open-questions) for the operator-driven case: because the router
never refreshes subscription tokens, a revoked credential is otherwise invisible until every request
to the Account has already failed. It also runs *periodically*, daily, over every subscription
(`scheduler/tasks/idle-account-probe.ts`) — one process per Account per day, which is cheap enough
to pay without asking.

**Checking whether a subscription is alive never spends usage.** Three things follow, all built:
the sweep's billed keepalive turn is opt-in (`IDLE_ACCOUNT_PROBE_PAID_TURN`, default `false`) — a
turn refreshes only the *access* token and cannot move the refresh-token cliff, so it was cost with
no benefit for a subscription; the sweep's usage-gauge read and the model listing use a turn-free
query (`idle-query.ts`: the initialize handshake, no prompt, closed right after); and a completed
login triggers no probe and no test — only the turn-free model listing (`onConnected`). The one thing
that does spend is the operator's own **Test now**, by name and with a confirmation.

A completed login also lifts the **whole** `needs_reauth` verdict: the request path parks a dead
subscription in the row *and* in the health store's breaker, and the accounts read overlays the
latter — so clearing only the row left reconnected accounts reading `needs_reauth` until Re-check.
`connect/claude.ts` now calls the same `HealthStore.reset` Re-check does and refreshes the warm
catalog, and logs `claude login started` / `completed` / `rejected` / `cancelled` per account.

### Container layout

The `claude` CLI, its config directories, and the router share one container; PostgreSQL is a
separate service ([09-deployment.md](09-deployment.md)). One directory per Account, keyed by
Account id (stable; a label is not):

```
/data/accounts/           ← named volume, mounted into the router container
  acc_01H…/               ← CLAUDE_CONFIG_DIR for "claude-max-seb"
  acc_01J…/               ← CLAUDE_CONFIG_DIR for "claude-max-team-2"
```

- **N subscriptions, one container.** No per-account container. Meridian confirms the shape with
  `MERIDIAN_PROFILES` plus one mount per profile (`docs/deployment.md:126-140`).
- Those directories are **live credential material** — same handling rules as encrypted
  `authMaterial` in [07-security.md](07-security.md), though the CLI owns their format. They are
  the one piece of Account state that does *not* live in Postgres, which makes the volume a backup
  and restore concern in its own right.
- They grow (transcripts). The `claude` CLI writes `projects/<cwd-slug>/<session>.jsonl` (and a
  `<session>/` directory of tool results and subagent transcripts) per SDK session and never removes
  them — production measured a quarter of a gigabyte per Account. The `sdk_transcript_sweep` task
  (`scheduler/tasks/sdk-transcript-sweep.ts`, `providers/claude-sdk/transcripts.ts`) removes those
  two artifact shapes, and only those, once older than `RETENTION_SDK_TRANSCRIPT_HOURS` (default
  24 h, the same window as the `sessions` row that could resume them). It never looks at anything
  else in the directory — credentials, settings, `memory/`, the CLI's own state — never follows a
  symlink, and rebuilds every path it removes from validated parts. A resume that lands on a swept
  transcript is the `stale-session` class below: binding evicted, one replay in place, never a
  failed request. Listed beside the other sweeps in [09-deployment.md](09-deployment.md).
- Adding an Account must not need a restart; Accounts resolve from Postgres per request anyway.

---

## 4. Session management

**Why a naive proxy breaks.** The Messages API is stateless — the client resends everything each
turn. The SDK is *stateful* — it owns the conversation, and you either `resume` the right SDK
session id or re-send the whole history as flat text. Getting it wrong means a cold prompt cache
every turn (Meridian measured ~3× TTFB and ~3× tokens for one analogous cache-invalidating change,
`betas.ts:11-14`), and flattened tool history teaches the model to fabricate tool syntax and
self-play transcripts (`messages.ts:97-113`).

| Cache | Key | Used for |
|---|---|---|
| Session cache | client session header, **scoped by Account** | Clients that send one |
| Fingerprint cache | `sha256(clientCwd + "\n" + firstUserText[0:2000])[0:16]`, **scoped by Account** | Headerless clients |

Both are LRU with **coordinated eviction** — evicting from one removes every entry in the other
pointing at the same SDK session id (`session/cache.ts:43-69`); otherwise a half-evicted pair
resurrects a session the other cache abandoned. The fingerprint seed includes the working directory
(unrelated projects routinely open with the same first message) and excludes the system prompt (it
carries per-request file trees that change every turn). Meridian scopes by profile; **we must scope
by Account id** — resuming against the wrong Account is both a cache miss and a leak of one
subscription's conversation into another's.

### Lineage classification

Every request re-verifies the incoming messages are a legal descendant of what we stored: fast path
is one aggregate prefix hash, slow path is per-message hashes with prefix/suffix overlap
(`session/lineage.ts:214`).

| Class | Condition | Action | Why it exists |
|---|---|---|---|
| **continuation** | prefix hash matches and the conversation grew | `resume`, send delta only | The common case. Without it every turn is a full replay |
| **modified continuation** | partial prefix overlap **and** growth | `resume`, restate hashes | Clients mutate earlier messages harmlessly (`cache_control`). Without it these read as divergence |
| **compaction** | contiguous stored **suffix** found after position 0, minimum length | `resume` | The client summarized its own history. Without it a compaction abandons a warm session |
| **undo** | prefix preserved, suffix gone, conversation **shrank** | `forkSession` + `resumeSessionAt: <uuid>` | User edited/retried a turn. Without it the model answers a question that no longer exists |
| **diverged** | no meaningful overlap | drop mapping, start fresh | Correctness backstop |
| **replay / retry** | prefix matches but no growth | treat as diverged | An identical resend would otherwise resume and re-send the last user message, accumulating ghost context (`lineage.ts:232`) |

Undo needs per-message SDK assistant UUIDs stored beside the hashes to name the rollback point.
Compaction needs *positional* overlap, not set membership — Meridian regressed twice on duplicate
messages matching at unrelated positions (`lineage.ts:110-174`).

**Never resume** (`server.ts:940-980`): a headerless request whose last message is a `tool_result`
(a client running its own tool loop — concurrent loops share a fingerprint and would resume each
other); requests marked as a fork or subagent child; anything after the SDK reports the session gone.

### For us

- `Session → (Account, sdkSessionId, lineage state)` is a new obligation on an entity
  [02-domain-model.md](02-domain-model.md) already has.
- **Sticky routing becomes correctness, not optimization.** An SDK session id is only resumable on
  the Account that created it; a policy that moves a Session must invalidate the mapping, not carry it.
- Meridian persists mappings in a JSON file guarded by advisory **lock files** — a scheme that exists
  only because a JSON file has no cross-process coordination. We have **PostgreSQL**: the mapping is
  a real table with real transactions, the in-memory LRU pair sits in front of it, and any sweep that
  touches it takes a `pg_try_advisory_lock` so exactly one replica runs it
  ([09-deployment.md](09-deployment.md)). Their hardest storage problem is a primitive we get for free.
- Meridian applies **no time-based expiry** to the mapping (SDK sessions live for weeks upstream;
  dropping it forces a destructive replay). The 24 h idle-session sweep in
  [09-deployment.md](09-deployment.md) needs re-examination for *this* table specifically (§11).
- Coordinated LRU eviction is **per process and in-memory** — it is a cache invariant, not a job.
  Nothing about it is scheduled or brokered; the durable mapping in Postgres is the shared truth,
  and a cold replica simply re-reads it.

### As built

`apps/api/src/providers/claude-sdk/session/`: `conversation.ts` (request → one hashable string per
message), `fingerprint.ts`, `lineage.ts` (the six classes and the never-resume rules), `cache.ts`
(the pair, with coordinated eviction), `store.ts` (Postgres behind both). The binding reaches
routing through `services/dataplane/session-binding.ts`, which populates the `SelectionRequest.binding`
`services/routing/` already consumed.

Decisions taken while building it, each narrower than the spec text above:

| Decision | Why |
|---|---|
| The row is keyed by `(apiKeyId, sessionKey)`; the fingerprint is an **alias** into it, not a second row | One truth to invalidate. The header key names the row, the Account-scoped fingerprint finds it again when a headerless client's byte-level key shifts underneath it |
| The binding lookup is **gated on the catalog holding a subscription Account** | Only this path ever writes one. Without the gate a router serving plain HTTP would pay an indexed query per request for a table that is empty for it |
| Misses are cached, with their own shorter TTL (`SESSION_CACHE_NEGATIVE_TTL_SECONDS`) | A subscription-serving router still carries HTTP traffic whose sessions will never have a row. The short clock is what still lets a binding minted on another replica appear |
| A binding is written only once the SDK **names a session id** | An Account with no session id to resume is a pin with no payoff, and pinning one costs the next turn a failover that a cooling-down Account would otherwise still have |
| `assistantUuids[i]` is written one **past** the end of the hashes it accompanies | That is the index the client will send this answer back at next turn — the position an undo has to be able to name. Absent, an undo starts fresh rather than forking at a guessed point |
| A read or write failure degrades to "no binding" and is logged, never thrown | A slow session table costs a cold prompt cache. Turning it into a `500` would fail requests over a cache |
| `resolve()` runs **per attempt**, not per request | A failover to a second subscription Account is a different set of SDK sessions; the first Account's plan would resume one the second has never heard of |

---

## 5. Quota and rate-limit signals

The SDK emits `rate_limit_event` messages in the query stream. They are **never forwarded to the
client** — they are Account state (`rateLimitStore.ts`).

| Field | Meaning | Feeds |
|---|---|---|
| `status` | `allowed` \| `allowed_warning` \| `rejected` | circuit breaker |
| `rateLimitType` | which window | bucket key |
| `resetsAt` | epoch ms, when the window refills | `cooling_down` until |
| `utilization` | 0..1 spent | `quota-aware` |
| `overageStatus` / `overageResetsAt` / `isUsingOverage` | paid-overage state | policy + admin UI |
| `surpassedThreshold` | threshold that triggered the event | diagnostics |

Windows: `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `overage`. Events without a
`rateLimitType` land in an internal `default` bucket that must never be rendered as a real window —
and a `rateLimitType` this build does not know gets its own unrendered bucket under the SDK's word
for it, because naming a window we cannot name is the one way to report a limit that does not exist.
Either way a `rejected` still cools the Account down: the refusal is the fact, the window is detail.

Two readings are dropped rather than passed on, both because the alternative is a fabricated fact.
A **reset instant already in the past** — late delivery, clock skew, or a value reported in seconds —
would set a cooldown that has already elapsed, so the breaker's own backoff takes over, labelled
`estimated`. And the **`overage` window never blocks by itself**: it carries its reset and the
`isUsingOverage` flag for the console, while whichever included window actually refused decides
whether the Account can serve. Implementation: `apps/api/src/providers/claude-sdk/quota.ts`, whose
store is created per runtime and keyed by Account — never a module-level singleton.

**The critical caveat: `utilization` is only populated near the limit** (`oauthUsage.ts:5-8`). It is
an *alarm*, not a gauge — a `quota-aware` policy built only on SDK events sees `null` headroom for
most of every window and degrades to round-robin. **This is why the console and `status.ts` show
`—` for an actively used subscription's `five_hour` / `seven_day` / `overage` windows**: the windows
themselves are reported, persisted, and reloaded (their names and resets are what prove the events
arrive), but a percentage is only ever a threshold-triggered reading. Verified against the 0.3.261
CLI: it reads `anthropic-ratelimit-unified-<claim>-utilization` off the API response, which the API
sends only past a threshold. `—` means "no reading", by design, not a dropped event.

**The continuous source, as built: the SDK's own usage gauge** (`providers/claude-sdk/usage-gauge.ts`).
SDK 0.3.261's query object exposes `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` —
the structured answer behind the CLI's `/usage`: `rate_limits_available`, `subscription_type`, and
per-window `{ utilization: 0–100, resets_at: ISO }` for `five_hour`, `seven_day`, `seven_day_opus`,
`seven_day_sonnet` (plus `seven_day_oauth_apps` and `model_scoped`, which have no window kind here and
are ignored). Calling it is sanctioned under non-negotiable 1: it is the SDK asking, inside the
Account's own `CLAUDE_CONFIG_DIR`, with a credential this router never sees. How it is wired:

- **Off the response path, on the turn already being served.** `turn-lifecycle.ts` fires the gauge
  only after the turn's first content message has been handed to the renderer (TTFT is untouched by
  construction), keeps the one-message prompt open past `result` so the CLI stays alive for exactly
  one bounded control request (the SDK closes stdin — and the CLI exits — when the prompt ends), and
  ends the *consumer's* stream at `result` so the client's last frame never waits on the reading. The
  subprocess slot is held until the reading settles: a live process is a process the memory bound
  counts. Bounded by `CLAUDE_SDK_USAGE_GAUGE_TIMEOUT_MS`; every failure costs the reading and nothing
  else.
- **Turn-free for idle accounts.** The daily `idle_account_probe` reads the gauge for every
  logged-in subscription through `idle-query.ts` — the SDK's initialize handshake and *no prompt* —
  so an account nothing routed to today still shows real percentages. Nothing is billed; the test
  asserts zero user messages reach the SDK. The same shape serves `supportedModels()` (§3).
- **Coalesced** to one reading per account per `CLAUDE_SDK_USAGE_GAUGE_MIN_INTERVAL_SECONDS`,
  counted from the start of a reading, so parallel coding agents on one subscription ask once.
- **Validated tolerantly** (`quota-reading.ts`, Zod `looseObject`, every field degrading to null):
  the API's own name says it may change, so a shape surprise is a `debug` line and a dropped
  reading, never a failed turn. `rate_limits_available: false` (API key, or a login without the
  `user:profile` scope) is logged once per account at `info`.
- **Folded as a reading, never a verdict.** `SdkQuotaStore.ingestGauge` writes the same per-window
  buckets a `rate_limit_event` fills, labelled `utilizationSource: "continuous"` (the domain's
  existing value for exactly this source); the snapshot it returns is never `limited`, so applying
  it to the health store records windows and touches no breaker. Merge rule per window: an alarm
  that carried no utilization leaves the gauge's number standing; an alarm that carried one wins
  (fresher, nearer the limit); a gauge never lifts or sets `rejected`. The reading reaches the
  console and `quota_windows` through the one existing channel — `HealthStore.applyRateLimit` →
  `onQuotaWindows` → the quota writer — so `quota-window-spent` and `quota-aware` ranking see it
  with no new path. `CLAUDE_SDK_USAGE_GAUGE=false` turns all of it off.

**The dispatch-level wire.** `SdkInvocation.onRateLimit` (`invoke.ts`) is the seam a launcher calls
for every `rate_limit_event`, the `onSession` of quota. `runSdkAttempt` (`sdk-attempt.ts`) folds each
call through the injected `SdkQuotaStore` and carries the account's whole reading afterwards as this
attempt's `AttemptOutcome.rateLimit` — on **both** the success and the failure branch, since the
event may arrive on a turn that otherwise completed fine. `runChain` (`chain.ts`) then applies that
reading **after** `recordSuccess`/`recordFailure`, never before: applying it first would have
`recordSuccess`'s unconditional reset to `active` erase the very cooldown a `rejected` reading on an
otherwise-200 turn just recorded. This is the same property an HTTP driver's rate-limit headers need
and get from the identical ordering — the Agent-SDK transport is not a special case here, only a
different source for the same `RateLimitSignal`.

**Where the named windows go.** The reading carries its windows on the same `RateLimitSignal`
(`RateLimitSignal.quotaWindows`), which is the *only* channel by which an Account's `quotaWindows`
are ever written. The health store folds them per kind — a turn that reported `five_hour` says
nothing about `seven_day`, so what it did not name is left standing — and `overlayHealth` merges the
result over the rows the catalog hydrated. Everything quota-driven reads what lands there:
`quota-window-spent` in the pure filter, `quota-aware`'s ranking, `router_quota_utilization`, and the
console's per-window gauges and countdowns. An HTTP driver leaves the field **absent**, not empty:
`requests` and `input-tokens` have no `QuotaWindowKind`, so they travel as limiter readings under the
provider's own names, and an empty array would be the different claim that the Account holds no
windows at all.

**And where they are persisted.** `HealthStore` is this replica's memory, so a fold also hands the
reading to `createQuotaWindowWriter` (`services/dataplane/quota-writer.ts`), which coalesces per
Account and upserts on a `QUOTA_WRITE_INTERVAL_MS` timer — off the request path, never awaited by
one. Not a scheduled task: those hold an advisory lock so exactly one replica sweeps, and a reading
lives in the memory of the replica that *observed* it. Deliberately no history and no queue either —
a quota window is state, so the newest reading supersedes the older one and there is nothing to shed.

The optional secondary source closes that gap: `GET https://api.anthropic.com/api/oauth/usage` with
`anthropic-beta: oauth-2025-04-20` returns **continuous** percentages for every active window
(0..100 → normalize to 0..1), an `extra_usage` block (`isEnabled`, `monthlyLimit`, `usedCredits`,
`currency`), and model-scoped weekly limits. It reads the access token from the Account's config dir.
Merge rule worth copying verbatim: **OAuth values win for `utilization` / `resetsAt`; SDK events
fill in overage detail and any window the endpoint omits; a `rejected` SDK status is never
downgraded** (`server.ts:4096-4114`). Hygiene for both: 30 s TTL cache per Account, concurrent
readers share one in-flight request, and a transient failure serves the last-good snapshot within a
bound (15 min) rather than blanking the routing view.

| Signal | Consumer |
|---|---|
| `status: rejected`, or a 429-classified error | Circuit breaker → Account `cooling_down` until `resetsAt` (capped); exponential backoff when no reset is reported. The half-open probe is **scheduled per Account for when its reset passes**, never a fixed-interval sweep ([09-deployment.md](09-deployment.md)) |
| `utilization` per window | `quota-aware`: prefer the Account with the most headroom |
| `extra_usage` exhausted | Distinguish "out of subscription" from "out of paid overage" — separate error classes (`errors.ts:198`) |
| Per-Account snapshot | Admin UI headroom, `/metrics` |

Note the scheduling shape: because `rate_limit_event` rides responses we are already making, an
actively used Account needs **no polling at all**. Only idle Accounts need the slow background floor
that reads the OAuth usage endpoint — an in-process jittered timer holding a Postgres advisory lock,
not a queue or a worker.

---

## 6. Protocol re-synthesis

There is nothing to proxy. **Even `POST /v1/messages` against a Claude subscription is a
re-synthesis, not a passthrough.**

| SDK `message.type` | Contains | What we do |
|---|---|---|
| `system` (`subtype: "init"`) | `session_id` | Capture for the Session mapping |
| `stream_event` | a raw Anthropic wire event in `.event` | The **only** type whose payload reaches the client — after field stripping, index remapping, block filtering |
| `assistant` | full message + `uuid` + `usage` | Non-stream: the content source. Stream: UUID capture for undo, early-stop arming. Its `usage` covers only the last internal iteration — **not authoritative** |
| `user` | tool results the SDK produced internally | Early-stop bookkeeping (§7) |
| `result` | aggregate `usage`, structured output | **Authoritative** usage for the `UsageRecord` |
| `rate_limit_event` | `rate_limit_info` | Account quota state (§5) |

### SSE out — Anthropic dialect

| Client-visible frame | Source | Also synthesized for |
|---|---|---|
| `message_start` | first forwarded `stream_event`, **once** | structured output, tool-only turns |
| `content_block_start` / `_delta` / `_stop` | forwarded `stream_event`s | passthrough tool_use blocks, error recovery |
| `message_delta` (`stop_reason`, `usage` — `output_tokens` always, input/cache counts when the stream stated them) | forwarded or synthesized | early stop, tool_use termination, error close |
| `message_stop` | exactly one, after the loop | always terminal |
| `error` | classified failure | — |
| `: ping` | every 15 s | keep-alive |

- **Block indices are ours** — the SDK restarts them per internal turn; a monotonic
  SDK→client index map is required (`server.ts:2516`).
- **The index map is keyed on `(parent_tool_use_id, index)`, not on the index alone.** A subagent
  numbers its blocks from zero exactly as the main turn does and the two interleave, so an
  index-only map lets a dropped subagent block evict the mapping of the answer's own block 0 —
  after which the rest of the real answer is silently discarded.
- **Intermediate `message_stop`s are dropped** — the SDK emits one per internal turn; the contract is one.
  So are intermediate `message_delta`s: their stop reason is remembered and stated once, at the end.
- **Block filtering must skip the whole start/delta/stop triple**, not just the start.
- **Heartbeats hide upstream stalls.** Our `: ping` resets the client's idle timer, so a separate
  **upstream** idle guard (90 s in Meridian, `streamIdleGuard.ts`) must race each `next()` → `504`.
- **The status is decided before the first byte.** The response is not constructed until the first
  client frame exists, so a stall or a death on the way to it is a real `504`. After it, a failure
  is a terminal SSE `error` frame inside the `200` — a response in flight cannot retract its status.
- **A stop reason nobody stated is `null`.** Absence is reported as absence, exactly as a token
  count nobody measured is; claiming `end_turn` for a turn that never said so is the same class of
  invention as the canned fallback sentence.
- **The terminal usage fallback merges every count the stream stated, field-wise.** The SDK splits
  one turn's counts across events — `message_start` carries input and cache, each `message_delta`
  the output so far — and the authoritative `result` usage is deliberately absent on an
  early-stopped tool-call turn (§7). Falling back to the last `message_delta` alone therefore lost
  input+cache on the dominant agent-traffic shape and systematically under-reported every such
  `UsageRecord`. The envelope now keeps the newest non-null value per field; a count no event
  stated stays absent, never a zero (`render/envelope.ts` `mergeUsage`).
- **`context_management` is stripped from every forwarded frame**, at the event level and inside
  `delta`. The SDK/CLI attaches it; the real Anthropic API never emits it on a plain request, and
  stock clients crash treating it as a typed field (observed against langchain-anthropic —
  Meridian #525). A narrow named deletion in the envelope, same spirit as tool-name un-prefixing;
  everything else in the frame stays byte-identical.
- **A force-closed block is an alarm, not only a repair.** `finish` closes any block the upstream
  left open so the client's parser stays sound — and counts it, reporting through the render
  observer (`onForcedBlockClose`) so a regression that eats a `content_block_stop` lands in our
  logs instead of only in user transcripts.
- **Unknown `content_block_delta` kinds fold like they stream.** The streaming path forwards a
  delta kind this build has never seen; the non-streaming fold used to drop it, so the two response
  shapes diverged for every future block type. The fold now carries the delta's own fields onto the
  block verbatim, newest value winning (`render/message.ts`).
- **A `tool_result`'s nested images are hoisted to sibling image blocks** when a conversation is
  rendered into the prompt (`prompt.ts`): the SDK's user message has no `tool_result` block to
  carry them in place, and folding them into the bracketed transcript line erased them — a
  screenshot/PDF/chart tool's output, every turn. The transcript line names how many images follow;
  the `image/jpg` misspelling is normalized to `image/jpeg`, and an image that still fails the
  source schema is omitted **by name** (`[image omitted: unsupported source type …]`), never as a
  bare `[image block]`.
- **Message ids are CSPRNG-backed** (`crypto.randomUUID`), never clock-derived — see the fidelity
  table below.
- **One renderer, both response shapes.** `includePartialMessages: true` is unconditional, so
  `stream: false` folds the identical frame sequence into one body rather than reading the SDK a
  second, differently-shaped way. Two readers would eventually disagree about where a block began.

### OpenAI dialect out

Meridian translates OpenAI requests into the Anthropic shape and re-enters `/v1/messages`
**in-process** (`server.ts:3789`, `:3930`) — one re-synthesis engine, two front doors. Right call
for us: **render SDK → Anthropic Messages once, then reuse the Anthropic → OpenAI translator from
[06](06-protocol-translation.md).** Do not write a second SDK → OpenAI renderer. Two boundaries stay
distinct: OpenAI ⇄ Anthropic is ordinary translation; Anthropic ⇄ `query()` is where the loss is.

Costs of the internal hop, and three things not to copy:

- Account selection must happen **once at ingress and be carried structurally**, never re-derived
  from forwarded headers — Meridian's two front doors already forward different header sets.
- Its chat-completions path deliberately **bypasses session resumption**, flattening prior turns
  into a `<conversation_history>` system block (`openai.ts:7-17`): fresh SDK session per request,
  cold cache every turn, earlier images degraded to the literal text `[Image attached]`. Its
  Responses path does the opposite and is the pattern — session keyed on the client's
  `prompt_cache_key`, so signed thinking and cache survive *by session identity*.
- Its Responses output reports `status: "completed"` unconditionally, so `max_tokens` truncation is
  invisible.

Worth stealing verbatim: a Responses SSE payload must carry its own `type` **inside the JSON data
object**, not only on the `event:` line, or Codex's tagged deserializer reports "stream closed
before response.completed" though every event was sent (`openaiResponses.ts:343-352`).

### Where fidelity is lost

| Loss | Why |
|---|---|
| **Sampling parameters** (`temperature`, `top_p`, `max_tokens`, `stop`, `top_k`, penalties, `seed`, `n`, `logprobs`) | `query()` has no equivalents. Accepted and **ignored** — document per field. `reasoning_effort` is the exception, mapped to the SDK effort scale (`low`…`max`; OpenAI's `minimal` has no target) |
| `n > 1`, `system_fingerprint`, determinism guarantees | Never surfaced |
| Ids, event boundaries, byte parity | Constructed by us. Avoid Meridian's `msg_${Date.now()}` — it collides under concurrency |
| Fields the SDK does not surface | Cannot be re-synthesized; "new upstream features survive" does not hold here |
| Client `cache_control` hints | Caching is the SDK's, not the client's |
| `usage` decomposition | SDK `input_tokens` **excludes** cache reads, so naive `prompt_tokens` under-reports context. `cache_creation` sub-breakdown, `prompt_tokens_details.cached_tokens`, and reasoning-token counts are unavailable. **This is the cost basis of a `UsageRecord`** |
| Thinking signatures | A block reconstructed from client text is unsigned; continuity must come from session identity |
| `pause_turn`, `refusal` | No OpenAI target — collapse to `stop`; no `content_filter` path |
| `tool_result.is_error` | OpenAI's `tool` role has no error channel; failures read as successes |
| Anthropic **server** tools, citations, code execution, computer use | The SDK cannot emit `server_tool_use`. Reject `400` naming the field — and do **not** advertise these in `GET /v1/models` |
| Beta opt-ins | The SDK owns the request; only a filtered subset passes as `betas` (§7) |
| `POST /v1/messages/count_tokens` | The SDK exposes no token-count call, and the one way to get one — forging an `api.anthropic.com` request out of the subscription's own credentials — is the thing this whole document exists to refuse. A subscription account is therefore **not planned** for that route: a mixed pool answers off an Anthropic-dialect account, and a subscription-only pool gets a `503` naming this row. Never an estimate — see [06-protocol-translation.md](06-protocol-translation.md#counting-tokens) |

Meridian injects a canned fallback sentence when the SDK returns no content (`server.ts:2068-2074`).
**A router must never fabricate model output** — return an empty completion with an honest stop reason.

---

## 7. Tool handling — the genuinely hard part

Roughly **40–45 % of Meridian's request-path code (~3,300 of ~8,000 LOC) is tool-related**, split
about 40/60 between "which toolkit wins" and "stop the agent loop from running autonomously."

**The root problem.** The SDK subprocess is a full agent with its own built-ins (Read, Write, Edit,
Bash, Glob, Grep, Task, WebFetch, TodoWrite, …). The client *also* sends `tools[]` and expects
`tool_use` blocks matching *its* names and schemas. Two toolkits, one model: if both are live the
model calls `Read(file_path=…)` and the client — which knows `read(filePath=…)` — cannot execute it.

| Category | Contents | Why |
|---|---|---|
| Blocked built-ins | SDK tools the client has an equivalent for | Force the model onto the client's version (`tools.ts:13`) |
| Client-only SDK tools | no client equivalent, or a colliding schema | Prevent calls the client cannot answer (`tools.ts:27`) |
| Anthropic server tools | dated `web_search_*` / `web_fetch_*` | Unsupportable — reject `400` |
| Deliberately **not** blocked | `ToolSearch` | The SDK needs it for deferred tool loading |

Two execution modes exist. **Internal MCP** — the SDK calls an in-process server that really runs
`bash`/`read`/`write` **on the router host** — is a non-starter for a multi-tenant router: arbitrary
command execution on behalf of any key holder. Meridian ships it because it is a single-user local
proxy. **We support passthrough only, and say so.**

In passthrough the client's tools are registered on an in-process MCP server whose handlers are
**no-ops** — they exist only so the model emits well-formed `tool_use` (`passthroughTools.ts:75-137`).
A `PreToolUse` hook then denies and captures every call, and the captures are emitted to the client
as synthetic blocks with `stop_reason: "tool_use"`.

| Mechanism | Why it exists |
|---|---|
| `tools: []` in the options | `disallowedTools` blocks *invocation* but leaves the ~25 k-token built-in catalog in the upstream payload; only `tools: []` elides it (`query.ts:274`). For us it is the **second** lock: the first is the named allowlist in `allowlist.ts`, enforced by `canUseTool` under `permissionMode: "dontAsk"`, because "we did not offer it" is an argument about what the model is shown, not about what the harness will run ([07-security.md](07-security.md)) |
| Deterministic (alphabetical) registration | Registration order changes the SDK system prompt, which blows the prompt cache |
| `maxTurns` ≈ 3–4 (vs 200 internal) | After each deny the SDK still runs a "digest" turn; the budget bounds it (`query.ts:154`) |
| Early stop | That digest turn is fully billed, and on always-thinking models costs a thinking pass per tool step. Abort once every denied call is observed (`passthroughEarlyStop.ts`) |
| Deny-hold | A deny landing while later parallel blocks still generate makes the CLI cancel the in-flight request and truncate them — hold denies until `message_delta` |
| Turn-2 suppression | Drop everything after the second `message_start`; force `stop_reason: tool_use` |
| `max_turns` → `tool_use` recovery | Budget exhaustion becomes a clean tool-use stop, not a 500 |
| Name un-prefixing | The SDK is **inconsistent** about whether a stream event carries `mcp__<server>__`; handle both |
| Param-name repair | Claude Code's prompt teaches `snake_case`, clients often use `camelCase` — repair only when a *required* param is missing |
| Deferred tool loading | Above ~15 tools, non-core ones are deferred behind `ToolSearch` — costs one extra turn |
| Envelope-integrity assertions | Assert per response that no captured tool call was dropped and no tool input is empty; these bugs are otherwise silent |

Subagents: a client's `Task`-style tool is opaque to the SDK, so agent definitions are synthesized
from its description text and registered as SDK `agents` with `model: "inherit"` (subagent traffic
returns through the router). The SDK validates `subagent_type` **before** hooks can rewrite it, so
name variants must be pre-registered and invented names need fuzzy repair (`agentDefs.ts`).

Beta headers are filtered, not forwarded blindly: on a subscription Account billable betas (extended
cache TTL) are stripped while prompt caching, 1 M context, and fine-grained tool streaming pass
through. An earlier unconditional strip cost a cache miss every turn (`betas.ts:11-14`). For us this
is **per-Account billing safety**.

### As built

`apps/api/src/providers/claude-sdk/tools/`: `schema.ts` (the client's JSON Schema → the Zod raw
shape MCP registration demands), `passthrough.ts` (the in-process server, handlers that refuse),
`register.ts` (deduplication, alphabetical order, the deferral decision, and the one seam a launch
consumes), `names.ts` (the `mcp__client__` prefix, on and off), `repair.ts` (the case-only rename),
`rewrite.ts` (the two edits a `tool_use` block needs on the wire), `early-stop.ts` (the hook, the
deny-hold, the stop). `createQueryLaunch` takes the result as one optional `passthrough` field and
turns it into `mcpServers` + `hooks`; it changes nothing else about a launch.

Decisions taken while building it, each narrower than the spec text above:

| Decision | Why |
|---|---|
| The client's declared tools stream through as real `content_block_start`/`_delta`/`_stop` triples; the hook's captures are **not** re-emitted as synthetic blocks | The model already emitted the blocks. Synthesizing a second copy would either duplicate them or require suppressing the first, and "never fabricate model output" (§6) is easier to keep when nothing is fabricated |
| A `tool_use` block's `input_json_delta`s are **buffered** and re-emitted as one repaired fragment | Argument JSON splits mid-key, so no per-chunk rewrite is possible: the input is not a document until `content_block_stop`. Text and thinking are untouched, so time-to-first-token is unaffected — and this path is already the labeled exception to "never buffer a stream" (non-negotiable 8) |
| Unparseable or oversized argument JSON is forwarded **verbatim**, unrepaired | A client that can make sense of it still can. Swallowing it would turn a fidelity gap into a lost tool call |
| Early stop terminates the subprocess and yields a synthesized `result` with `stop_reason: "tool_use"` and **no usage** | The stop reason is a fact — the calls were emitted and the turn is over. The counts are not ours to invent, so they fall back to the last `message_delta`'s: the tokens for the turn the client actually received |
| Turn-2 suppression is conditioned on the turn having emitted a tool call | Without one, a second `message_start` is the SDK doing something we have no reason to truncate |
| Deferred loading is implemented but **gated on `allowlist.ts` naming `ToolSearch`**, which it does not | Deferring the tail behind a search the model is not permitted to run hides it entirely, which is worse than a long prompt. The threshold is honoured the day that grant is reviewed in ([07-security.md](07-security.md)) |
| A client's own `defer_loading` on a tool wins over our threshold | It knows which of its tools this conversation is about; we do not |
| Registration is sorted by **code point**, and duplicates keep the first declaration | `localeCompare` would make the system prompt depend on which replica served the turn, and a prompt that differs by a line is a cache miss on the whole prefix |
| A client that sent no tools gets no MCP server, no hook, and no stream wrapper | A plain chat request must not pay for machinery that exists to bound a tool loop |
| Nothing registered here reaches `allowedTools` | The MCP server is a *declaration* surface. Execution is still the reviewed allowlist's decision alone, and the handler refuses if both gates are somehow passed |

Not built here, and deliberately: **subagent `agents` synthesis**. A client's `Task`-style tool is
registered as an ordinary passthrough tool, so the model asks for it and the client runs it, which
is the correct answer for a router — synthesizing SDK agent definitions would put subagent traffic
back on this host's loop.

---

## 8. Per-client adapters

Meridian carries ten adapters (`adapters/`) plus a parallel transform registry (`transforms/`). The
intended split: an **adapter** is identity (detect the client, find its session id and working
directory, name its MCP server, normalize content for hashing); a **transform** is behavior, a
`{ onRequest, onResponse, onTelemetry }` chain over a `RequestContext`, which doubles as the plugin API.

**The split did not hold, and that is the most useful finding.** The behavioral half of
`AgentAdapter` was never removed after the transform migration — the server reads the pipeline
context instead. A 232-line parity suite exists solely to keep the two mirrors in sync, and it still
missed the obvious failure: the `claude-code` adapter has **no registry entry**, so its
`usesPassthrough`, `supportsThinking`, and tool lists appear never to take effect, silently, with no
failing test. Six near-identical copies of file-change extraction differ only in `filePath` vs
`file_path`; three adapter names map to the same transform set.

Adapter surface (`adapter.ts`) — read as a *catalogue of axes that vary*, not an interface to implement:

| Method | Controls |
|---|---|
| `getSessionId(c, body)` | Which header carries the Session key |
| `extractWorkingDirectory` / `extractClientWorkingDirectory` | SDK subprocess `cwd` (**must exist on our host**) vs. the client's own path, used for fingerprinting and a prompt note |
| `normalizeContent` | Stable string for lineage hashing |
| `getMcpServerName` | Tool prefix `mcp__<name>__` |
| `getBlockedBuiltinTools` / `getAgentIncompatibleTools` / `getAllowedMcpTools` / `getCoreToolNames` | Tool policy (§7) |
| `usesPassthrough` / `prefersStreaming` / `supportsThinking` | Execution mode, SSE, thinking blocks |
| `getSettingSources` | Whether the SDK loads `CLAUDE.md` / user settings |
| `buildSdkAgents` / `buildSdkHooks` / `buildSystemContextAddendum` | Subagents, hooks, prompt addenda |
| `leaksCwdViaSystemReminder` / `extractFileChangesFromToolUse` | `<system-reminder>` stripping; cosmetic file-change summaries |

**Detection is header sniffing only** — explicit override header, then a `User-Agent` prefix table
(`opencode/`, `factory-cli/`, `Charm-Crush/`, `claude-cli/`, `litellm/`), then a default. Never body
shape. Several clients have **no reliable signal** (Cherry Studio, ForgeCode, Pi — which impersonates
`claude-cli/`), and **Cline and Cursor have no adapter at all**; they fall through to the default.
That caps how much per-client behavior is even reachable.

**Our recommendation: one generic path parameterized by request-derived flags, not N adapters.** The
real axis of variation is a handful of orthogonal booleans, most derivable from the request itself.

| # | Genuinely mandatory | Failure mode |
|---|---|---|
| 1 | **Passthrough mode** | The most load-bearing bit: a tool-executing client in internal mode waits forever; a chat client in passthrough loops on blocks it cannot execute. Derivable from whether the client sent `tools` |
| 2 | **`settingSources: []`** | Cross-tenant leak of the router host's `CLAUDE.md` (§3) |
| 3 | **Server-controlled subprocess `cwd`** | A client path that does not exist here fails the spawn with a misleading error. Every client is remote for us, so treat the client cwd as advisory only — *simpler* than Meridian's four cwd-parsing regexes, which exist because it is a local proxy |
| 4 | **Tool-name collision blocking** | Generic rule: if the client sent tools, block colliding SDK built-ins plus all client-only SDK tools. No per-client config |
| 5 | **Env stripping** | Subprocess loops back through our own router (§3) |
| 6 | **Session keying** | Cache-miss storm. One router-defined header plus fingerprint fallback covers most clients |
| 7 | **No silent model substitution** | Meridian collapses every model string onto seven tier aliases (`gpt-4o` → Sonnet, silently). Our invariant is the client picks the model — pass it through or fail clearly |

Polish, safe to default: thinking forwarding (default *strip*), file-change summaries (default *off*
— Meridian's sanitizer has to strip its own summary back out next turn), deferred tool loading,
subagent name repair, and the Claude Code system-prompt preset (a real ~28 KB decision, but a
per-Account **setting**, not a detected client behavior).

Keep one seam — a small `ClientProfile` resolved by detection with defaults for everything, plus one
request hook for genuine one-offs. The three per-client parsers worth porting encode facts about
clients we cannot change: Claude Code's session id buried as JSON in `metadata.user_id`, Droid's
working directory hidden in `<system-reminder>` blocks, and LiteLLM's `x-litellm-*` headers.

### The one edit a client's system prompt receives — harness fingerprints

**As built** (`apps/api/src/providers/claude-sdk/scrub.ts`, applied in `options.ts` where the prompt
crosses into `query()`). The client's system prompt is otherwise passed through verbatim, and the
Claude Code preset is still never substituted for one. What is removed is a small, named set of
*fingerprints*: the lines by which a competing harness announces itself inside a request the Agent
SDK is making as Claude Code.

The reason is billing, not tidiness. Anthropic meters a subscription request partly by who appears
to be asking, and a prompt that names another harness is read as a third-party app wearing Claude
Code's credential: the account is gated behind Extra Usage rather than its plan, and the request is
refused with `400 Third-party apps now draw from your extra usage, not your plan limits. Add more at
claude.ai/settings/usage and keep going.` The strongest tell is a **duplicate** — Claude Code's own
preset already injects `Here is some useful information about the environment you are running in:`
followed by an `<env>` block, so a harness that appends its own copy makes the preamble appear twice.

Measured 2026-09-05 against this router: the same 56 KB opencode system prompt fails with that
section present and succeeds with it removed, on `default`, `opus`, `sonnet`, `haiku` and
`claude-opus-5` alike, and on every account in the pool — so it is neither model- nor
account-specific, and no amount of failover routes around it. Meridian's
`@rynfar/meridian-plugin-opencode-scrub` bisected the same block independently (its issue #516).

Three properties, each pinned by a test: the rules are **independent** (a missing pattern is a
no-op), **idempotent** (scrubbing twice equals scrubbing once), and **conservative** — tool policy,
tone rules, task guidance and any user `CLAUDE.md` content the harness appended all survive verbatim.
A prompt that was *only* a fingerprint scrubs to nothing, and nothing means the option is omitted,
exactly as for a client that sent no system prompt at all.

**Agent-SDK egress only.** An API-key account is plain HTTP under the caller's own credential with no
impersonation to detect, and every other provider is a passthrough where rewriting the caller's
prompt would be the router substituting words the client never wrote.

---

## 9. Operational notes

**The glibc/musl trap.** The `claude` CLI is a *platform-native* binary. Build on Debian/glibc, run
on Alpine/musl, and the file is present but cannot exec — `ENOENT` despite existing, because the
dynamic loader path differs. `@anthropic-ai/claude-code` acquires it in a postinstall
(`install.cjs`), so a build that wants that package must pass `--ignore-scripts` in the build stage
and run `install.cjs` **in the runtime stage** so the binary matches the runtime libc; a separate
musl platform package exists (`@anthropic-ai/claude-code-linux-<arch>-musl`). Either way the binary
belongs on `PATH` as `claude` — a *symlink* or the real executable, never a shell wrapper, which the
SDK's launcher rejects on some paths — so `claude auth status` and the SDK resolve the same file.

**How our image actually does it, and why it differs.** `@anthropic-ai/claude-agent-sdk` (0.3.220+; pinned `^0.3.261`, whose bundled CLI is 2.1.261 — the resolution ladder, the security gates, and the `auth login` / `auth status` shapes were re-verified against it)
ships the same binary as its *own* prebuilt optional dependency
(`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`, glibc and musl variants), and its internal
resolution says so: it fails with "Reinstall `@anthropic-ai/claude-agent-sdk` without
`--omit=optional`, or set `options.pathToClaudeCodeExecutable`". So we install **no** second CLI
package: `bun install` already puts a lockfile-pinned binary in the tree, at a version that cannot
skew from the SDK calling it, with no network fetch or postinstall at image-build time. The builder
stage stages that exact file (found by running our own resolver — never a hard-coded store path,
which would drift the moment bun changes its layout) and the runtime stage copies it to
`/usr/local/bin/claude` and runs `claude --version`, so the libc trap fails the **build** instead of
the first subscription request. `--ignore-scripts` stays on both builder installs as a security
floor. This makes the builder and runtime bases share a libc — the invariant the `RUN` enforces.

**Executable resolution is a ladder and must be observable**: env override (`CLAUDE_CLI_PATH`, and a
set-but-unusable pin *fails* rather than falling through to a binary nobody named) → bundled binary
(`@anthropic-ai/claude-code`'s `bin/claude.exe` — that one filename on every platform, skipping the
~500-byte stub a skipped postinstall leaves) → SDK platform package (same candidate order the SDK
walks, resolved from the SDK's own directory because bun installs a package's deps beside it) →
`PATH` lookup → legacy native-installer paths. `/readyz` reports **which rung won**; "the wrong
`claude` got picked" is otherwise indistinguishable from any other SDK error. The path is logged,
not returned: `/readyz` is unauthenticated. Implementation:
`apps/api/src/providers/claude-sdk/resolve-cli.ts` (pure ladder) + `cli-probe.ts` (host facts).
The **runtime** that would launch a JS-file rung is pinned the same way: `Options.executable` is
set to `bun` explicitly (`options.ts`) rather than left to the SDK's autodetection, which spawns
`bun cli.js` whenever `process.versions.bun` exists — wherever `bun` may or may not be on the
child's PATH (Meridian pins `node` after embedded-Bun hosts broke on exactly that). Our image
ships Bun as the runtime, so `bun` is the decision; the point is that it is written, not detected.

| Concern | Design |
|---|---|
| Concurrency | A semaphore over `query()`, sized to memory not CPU. Ours is **global and per-Account** (`CLAUDE_SDK_MAX_CONCURRENCY`, `…_PER_ACCOUNT`) — `concurrency.ts`. The per-Account gate is taken **first**: reversed, a bursting Account would hold global capacity while it waited and starve the Pool, which is the failure the per-Account limit exists to prevent. Excess callers queue FIFO; a caller aborted while queued throws the signal's own reason, so a deadline stays a `TimeoutError` and a disconnect stays an `AbortError`. **One instance per replica, shared by every path that spawns** — the dispatcher's invoker and the console's "Test now" probe (`test-probe.ts`) both take slots from it, because the ceiling bounds this container's memory and a bound only one caller honours is not a bound. "Test now" has its own cooldown but that cooldown is per Account, so it would not stop ten Accounts being tested at once. Occupancy and queue depth are exported — `router_sdk_subprocesses`, `router_sdk_subprocess_queue_depth` ([08-observability.md](08-observability.md#metrics)) |
| Cancellation | One `AbortController` per request, wired to the HTTP signal and the SDK; aborting terminates the subprocess. No separate `interrupt()`/`kill()` in Meridian. Ours is bridged in `options.ts`: the data plane's composed signal (deadline ∪ client) drives a controller the SDK owns |
| Client disconnect | Detect closed-stream writes, stop the loop, abort, detach. Never orphan a subprocess — and never retain the signal either, which is why `QueryLaunch` exposes `detach()` alongside `abort()` |
| Orphan reaping | A subprocess per request makes PID 1's other job load-bearing: anything the `claude` process spawns is re-parented to PID 1 when it outlives its parent, and a PID 1 that never calls `wait()` leaves a zombie entry behind each one. `bun` is not an init, so the image's `ENTRYPOINT` runs it under `tini -s`, which reaps and still forwards `SIGTERM` to the router's own drain ([09-deployment.md](09-deployment.md#pid-1-and-the-claude-subprocess)) |
| Timeouts | Client keep-alive ≈ 15 s; **upstream** idle guard ≈ 90 s → 504. Independent, both needed |
| Retries | Bounded, and **forbidden once bytes are on the wire** — the same rule as [05-routing-and-failover.md](05-routing-and-failover.md) |

**Error classification.** SDK failures arrive as strings — a throw out of `query()`, or a `result`
message with `is_error: true`, which the renderer raises as `SdkResultError` (`result-error.ts`)
carrying the SDK's structured `api_error_status` and `terminal_reason` beside the sentence — so
classification is substring matching on the message plus the subprocess stderr tail, with the
structured status read **after** every phrase (`failure-rules.ts`). Classes worth naming as our own
error types:

| Class | Signal | Response |
|---|---|---|
| Expired credential | `oauth token has expired`, `oauth session expired`, `could not be refreshed`, `failed to authenticate`, `not logged in`, `please run /login`, `invalid api key`, `authentication_error`, `authentication failed` (message only), or `api_error_status` 401/403, or a bare `401` in the message | Account → `needs_reauth`, drop from routing, fail over to the next Account in the Pool. The status is **written through to the row** off the request path, because the router never refreshes this token: noticing the failure and parking the Account *is* the whole mechanism, so a verdict that died with the process would be nobody ever being told to log back in ([05-routing-and-failover.md](05-routing-and-failover.md#circuit-breaker)). **We do not refresh-and-retry** the way Meridian does — the SDK owns the token (§3) |
| Rate limited | `429`, `rate limit`, `usage limit reached`, `hit your … limit` (session, weekly, monthly spend, fast), `you've reached your <tier> limit` (one to three qualifier words — the credits-era per-tier banner), `you're out of usage credits` (a member's spent top-up; the included window still refills) | 429 + circuit breaker; fail over to the next Account |
| Credits exhausted | `credit balance is too low` (the CLI's own error constant, 0.3.220 and 2.1.261), `organization is out of usage credits`, `usage limit is set to $N` (an admin-provisioned cap) or `api_error_status` 402 | `402`, Account → `exhausted` — permanent until a human tops up, **never** timer-retried (CLAUDE.md non-negotiable 7). Fail over: the next Account may be funded |
| Stale SDK session | `No conversation found with session ID`, `No message found with message.uuid` (a fork whose rewind point is gone — same recovery, and before it was named here it fell to `unknown`, which does not retry, so the binding survived to fail the next turn too) | Evict the Session mapping, replay once |
| Busy session | `is currently running as a background agent` | **One in-place retry as a fork** (`invoker.ts`): same Account, `forkSession: true` at the tip — the fork inherits the full transcript warm, where a failover would replay it cold. Legal because the refusal is thrown before any stream output and the renderer never throws after the first byte. A fork that comes back busy is a real `503` for the chain |
| Extra Usage gated | `third-party apps now draw from your extra usage`, or `extra usage` together with `claude.ai/settings/usage` — Anthropic's answer to a request it metered as a third-party app (production, 2026-09-05) | **429**, `rate-limited`: cool this Account down and fail over to the next. Ordered **before** the bare `api_error_status` 400, which had it reading as `invalid-request` — not retryable, so the chain stopped with five healthy subscriptions unasked and the client was told its request was malformed. The client-facing sentence names Extra Usage and `claude.ai/settings/usage`, because that is the remedy; the fix that stops it arising is the fingerprint scrub (§8) |
| Overage required | `extra usage` + `1m`, or the CLI's verbatim long-context sentences (`Extra usage is required for long context`, `Usage credits are required for long context`, `out of extra usage`) | Drop the extended-context variant, cool down — the included window still refills on a clock, so this is never `exhausted` |
| Subprocess crash | `exited with code N` + stderr | 502. Meridian maps a generic exit-1 to 401 on a heuristic — **do not copy that**; classify honestly and log the stderr tail |
| Oversized prompt | `prompt is too long`, `context_length_exceeded`, `exceed context limit`, or `terminal_reason: prompt_too_long` | **400**, `invalid-request`: waiting does not fix it, and an identical retry would burn a full turn on every account in the pool and strike every breaker to fail identically (Meridian #919). No failover, no breaker strike |
| CLI too old for the model | `Claude Code <v> does not support this model` | **400**, `invalid-request`, naming the *router image* as the thing to upgrade. Every account shares the binary, so a failover would spend the whole pool on a fact about the image (Meridian 3ce6a57) |
| Overloaded | `overloaded`, `529`, or `api_error_status` 503/529 | **529** (Anthropic's own code), `server-error`, retryable: an overload is about the upstream, not this credential. Before this row it fell to `unknown`, which does not retry — one overloaded answer failed the request with healthy accounts unasked |
| Structured status | `api_error_status` 400/413/422 → 400; any 5xx → 502 | The fallback for a sentence nobody has recorded yet; strictly better than `unknown`, never better than a phrase |
| Upstream idle | Guard expiry | 504 |

The table is matched in order, most specific phrase first, and two rules keep it from lying
(`apps/api/src/providers/claude-sdk/errors.ts`). A **bare status number is read from the message
only, never from the stderr tail** — that is the mechanical form of "do not copy that": a `401` in a
megabyte of a crashed subprocess's output is not evidence about *this* failure, and acting on it
marks a working Account `needs_reauth` until a human logs in again. And **the SDK's own words never
become a client-facing error**; every class carries a router-authored sentence, with the raw text
kept only for the log line. Nothing matched is `unknown` — a `502` and a failover, never a guess.

The classes are values of the shared `UpstreamFailureKind` vocabulary rather than a private enum, so
one failover chain reads both transports; `stale-session`, `busy-session`, and `subprocess-crash`
were added there for this path. Only `stale-session` reaches the failover planner by name, because
its recovery is a replay on that same Account. The other two have spent their own recovery — the
bounded waits, the fork — by the time the chain sees them, so what is left is one Account that could
not serve, which is what `server-error` already means.

---

## 10. Copy · skip · do differently

| Copy | Skip | Must do differently |
|---|---|---|
| The `CLAUDE_CONFIG_DIR`-per-Account isolation model, wholesale | Internal MCP tool execution — arbitrary bash on the router host disqualifies it for us | **Per-Account rate-limit state.** Meridian's `rateLimitStore` is a process singleton *cleared on profile switch* (`rateLimitStore.ts:87`). Unusable for us: we need `Map<accountId, windows>` with no cross-Account clearing |
| Two-cache session resolution + the full lineage table, incl. replay-guard and modified-continuation | The plugin system — out of scope for v1 | **Sticky routing is correctness.** An `sdkSessionId` is resumable only on its own Account; a policy that moves a Session must invalidate the mapping |
| Coordinated LRU eviction across both caches | The 4.5 k-line handler — our SRP rules cap files at 300 LOC | **Per-key scoping and accounting.** Meridian has one user and no keys. Every request carries `(ApiKey, Account, Session)` into a `UsageRecord`; the candidate set is always Pool ∩ key scope |
| `rate_limit_event` → circuit breaker, plus the OAuth usage endpoint as continuous secondary source with Meridian's exact merge rule | Ten per-client adapters on day one (§8) | **Concurrency accounting.** A single global semaphore is fine for one user; we need global **and** per-Account limits |
| Passthrough in full: `tools: []`, deterministic registration, deny hook, deny-hold, early stop, turn-2 suppression, envelope-integrity assertions | **`tokenRefresh.ts` in its entirety** — expiry timers, background scheduler, direct credential writes. The SDK owns subscription tokens; we only observe auth failure and set `needs_reauth` (§3). Keep it as reference for the *file format*, never as an implementation | **Credential handling.** Drive the `claude` CLI for login and let it own the credential format; the router never mints, schedules, or writes a subscription token |
| `settingSources: []` and env stripping, verbatim — both are isolation guarantees | Anthropic *server* tool support (impossible) | **Storage.** Their JSON file + advisory *lock files* → a **PostgreSQL** table with the LRU pair in front. Their lock-file scheme exists only because a JSON file has no cross-process coordination; `pg_try_advisory_lock` gives us the same guarantee for free, and it is also how any sweep over that table elects a single replica |
| Executable-resolution ladder + `/health` source reporting; the Dockerfile build-vs-runtime libc split | Meridian's OpenAI chat path, which bypasses session resumption and pays a cold cache every turn | **Model naming.** No collapsing onto tier aliases; the client picks the model unless the Account defines an alias map |
| Beta-header filtering as billing safety; the anti-imitation framing for unavoidable flat replays | Time-based expiry decisions inherited from a local tool | **Never fabricate model output**, and document the ignored sampling parameters per field in [06](06-protocol-translation.md) rather than letting users discover them |

Meridian's *profile* is close to our **Account**: a named auth context resolved per request with
header > sticky > active > default precedence. The differences that bite — a profile has no
lifecycle, health state, weight, or usage history; there is one globally *active* profile, which has
no meaning for us; and profile switching clears global state we must keep per Account. Take the
mechanism, not the model.

---

## 11. Open questions and risks

1. **Subprocess cost at team scale.** What are the real memory and startup costs of one `claude` CLI
   subprocess, and how many can one container sustain? Does that make a per-Account concurrency cap
   a routing *input* rather than a safety valve?
2. **Can a subprocess be reused** across several HTTP requests, and would that break the per-request
   abort contract?
3. **Session-mapping retention.** Meridian applies no time-based expiry because SDK sessions live
   for weeks upstream. Does the 24 h idle sweep in [09-deployment.md](09-deployment.md) apply to
   this table at all, and what bound is right?
4. **Config-directory growth.** Transcripts accumulate per Account. Who prunes them, on what signal,
   and can pruning break `resume`?
5. **Does `quota-aware` work without the OAuth usage endpoint?** SDK `utilization` is only populated
   near the limit. If the endpoint stays strictly optional, does the policy degrade to round-robin
   in practice — and is the endpoint therefore effectively mandatory?
6. **Concurrent `query()` calls against one config directory** share a credential store and a
   session directory, and the CLI may rewrite credentials underneath them. Is that safe, or does an
   Account need a serialization point of its own?
7. **Auth-failure detection.** Since we never refresh subscription tokens ourselves, `needs_reauth`
   depends entirely on recognizing the SDK's auth failures — which arrive as substrings (§9).
   *Partly answered:* `claude auth status` is the probe, and it runs on the operator's **Re-check
   now** ([§3.2](#32-the-credential-probe)). Still open: whether to run it on a *timer* as well, and
   at what interval — each run is a process per Account, so a sweep across five subscriptions every
   few minutes is not free.
8. **Detection without adapters.** Can one generic path plus a session-header list actually serve
   Claude Code, OpenCode, Codex, Cline, and Cursor, or does the first integration force a per-client record?
9. **Tool-loop fidelity.** *Partly answered (developerz-ai/multi-ai-router#85):* `tool_choice` is
   now honoured on the subscription path. `"none"` launches with no passthrough at all — the same
   hard guarantee a client with no tools gets — which **diverges from Anthropic's own semantics**:
   the API keeps the tool catalog visible-but-uncallable, while this path withholds it entirely,
   because registering the tools and denying the calls would forward captures to a client that
   forbade them; withholding is the only hard enforcement this SDK's paradigm offers. `"tool"`
   narrows registration to the named tool only (`tools/register.ts`), throwing if the client never
   declared it, so the model has nothing else to call. A recognized variant carrying a payload the
   schema refuses (`{"type":"tool"}` with no `name`) is the client's `400`, never a silent
   `"auto"` — Anthropic's own API rejects the shape; a genuinely foreign shape still costs only the
   field (`request.ts`). `"any"` and `"tool"` both mark the turn `required`; for a
   **non-streaming** turn, the invoker refuses (rather than silently returning free-form text) if
   the drained turn produced no captured call — and only if the turn actually completed: one that
   ended in an upstream `error` frame is that error, never a mislabelled refusal. A non-streaming
   turn is fully drained before a byte is on the wire, so a throw there is still a real status
   (`request.ts`, `tools/register.ts`, `invoker.ts`).
   Still open, and named rather than silently dropped: the refusal is **not attempted on a streaming
   turn** — a chosen v1 scope decision, not a technical impossibility (a terminal SSE error frame
   after `message_stop` would be implementable; this issue does not build it) — so a forced call a
   streaming turn never produces goes undetected. `disable_parallel_tool_use` on an
   otherwise-valid choice is silently stripped by the strict parse (`request.ts`): the force
   survives, only the parallel hint is dropped, and the SDK could not enforce the hint anyway.
   Parallel tool calls and interleaved thinking remain undocumented gaps, unchanged by this issue.
10. **Cost attribution.** The SDK `result` message is authoritative, but a stream closed early never
    delivers it to the client. Do we bill from `result` regardless, and how do we reconcile that in the UI?
11. **Multi-arch.** Does the `claude` CLI ship a working `linux/arm64` (and musl-arm64) binary for
    every version we might pin? A missing platform package degrades silently to a `PATH` lookup.
