# @multi-ai-router/core

Shared errors, router-key format, and Zod schemas — the pure leaf every other package imports.

## What it owns

| Owns | Does not belong here |
|---|---|
| The `RouterError` hierarchy: one class → one stable code → one stable HTTP status | HTTP of any kind — no Hono, no `Context`, no routes |
| Router API key format, generation, display-prefix extraction | Persistence — no Drizzle, no SQL, no `postgres.js` |
| Zod schemas + `z.infer` types for the domain's enums and value objects | Provider drivers, routing selection, translation, usage math |
| Contract constants (`DEFAULT_ROUTING_POLICY`, key lengths) | Any I/O: no filesystem, no network, no clock, no `Date.now()` |

`zod` is the only runtime dependency, `crypto.getRandomValues` the only platform API, and **nothing
here imports `packages/db`, `apps/api`, or `apps/web`** — the arrow points in and never out.

Env validation deliberately lives in `apps/api/src/config/env.ts`, not here: the server is its only
consumer, and the browser bundle has no business importing a schema describing `ENCRYPTION_KEY`. It
moves here on the day a second consumer exists, and not before.

## Layout

```
src/
  index.ts            Public API barrel — the only import surface
  errors.ts           RouterError base, the 8 subclasses, isRouterError
  ids.ts              mar_live_ key format: generate, validate, display prefix
  domain/
    account.ts        AccountStatus, quota window kinds + sources, QuotaWindowState
    dialect.ts        Dialect, EgressMode
    key.ts            KeyScope
    provider.ts       ProviderId, AuthKind
    routing.ts        RoutingPolicy, DEFAULT_ROUTING_POLICY
test/unit/            Pure tests — bun:test, no mocks, no I/O
```

## Public API

**Anything not exported from `src/index.ts` is internal.** Import from `@multi-ai-router/core`,
never from a path inside `src/`.

### Errors — each class fixes its `code` and `status` at declaration, not at the call site

| Class | `code` | HTTP | Raised when |
|---|---|---|---|
| `NoHealthyAccountError` | `no_healthy_account` | 503 | Candidates empty for no other named cause (none configured, none supports the model) |
| `QuotaExhaustedError` | `quota_exhausted` | 429 | A rate-limit window is spent. Carries `retryAfterSeconds` / `resetsAt` |
| `CreditsExhaustedError` | `credits_exhausted` | 402 | Balance drained, plan expired, billing dead. No reset, ever |
| `ScopeViolationError` | `scope_violation` | 403 | Key scope ∩ pool members is empty, or names an out-of-scope account |
| `KeyRevokedError` | `key_revoked` | 401 | Presented key is unknown, revoked, or expired |
| `UpstreamTimeoutError` | `upstream_timeout` | 504 | Upstream or SDK subprocess missed its deadline |
| `CredentialDecryptError` | `credential_decrypt_failed` | 500 | Wrong/rotated `ENCRYPTION_KEY`, or a corrupt record |
| `TranslationError` | `translation_failed` | 400 | A cross-dialect conversion would be unfaithful — raised *before* the upstream call |

Plus `RouterError` (abstract base), `ROUTER_ERROR_CODES`, `RouterErrorCode`, `isRouterError`,
`QuotaExhaustedInit`.

### Keys

`mar_live_` + 32 characters over a 64-symbol URL-safe alphabet — 192 bits from
`crypto.getRandomValues`. The first 17 characters (prefix + 8) are the display prefix: stored in
clear and indexed, so verification is one row fetch, not a scan.

`generateRouterKey()` (the only source of key values) · `isRouterKey(value)` (shape only — says
nothing about existence or revocation) · `routerKeyDisplayPrefix(value)` (`null` for a malformed
key, never a partial slice) · `ROUTER_KEY_PREFIX`, `ROUTER_KEY_LENGTH`, `ROUTER_KEY_RANDOM_LENGTH`,
`ROUTER_KEY_DISPLAY_RANDOM_LENGTH`, `ROUTER_KEY_DISPLAY_PREFIX_LENGTH`, `ROUTER_KEY_PATTERN`.

### Domain enums

Each is a Zod schema and its inferred type under one name.

| Export | Members |
|---|---|
| `ProviderId` | `anthropic-oauth`, `anthropic-api`, `openai-oauth`, `openai-api`, `openrouter`, `zai`, `kimi`, `minimax`, `gemini`, `openai-compatible`, `anthropic-compatible` |
| `AuthKind` | `oauth` · `api-key` |
| `AccountStatus` | `active` · `disabled` · `cooling_down` · `exhausted` · `needs_reauth` |
| `RoutingPolicy` | `sticky` · `round-robin` · `weighted` · `least-used` · `priority-failover` · `quota-aware` (+ `DEFAULT_ROUTING_POLICY`) |
| `KeyScope` | `all` · `pools` · `accounts` |
| `Dialect` | `anthropic` · `openai-chat` · `openai-responses` |
| `EgressMode` | `passthrough` · `translate` · `agent-sdk` |
| `QuotaWindowKind` | `five_hour` · `seven_day` · `seven_day_opus` · `seven_day_sonnet` |
| `UtilizationSource` | `continuous` · `threshold-triggered` · `none` |
| `ResetSource` | `provider-reported` · `estimated` · `unknown` |
| `QuotaWindowState` | Value object: window, optional `utilization`, both source fields, optional `resetsAt`, `lastCheckedAt` |

## Usage

```ts
import { isRouterError, QuotaExhaustedError } from "@multi-ai-router/core"

try {
  throw new QuotaExhaustedError("all 4 accounts in pool `default` are rate limited", {
    retryAfterSeconds: 900,
  })
} catch (error) {
  if (!isRouterError(error)) throw error
  // 429 — status and code come from the class, never from the call site.
  respond(error.status, { code: error.code, message: error.message })
}
```

```ts
import { generateRouterKey, routerKeyDisplayPrefix, RoutingPolicy } from "@multi-ai-router/core"

const value = generateRouterKey() // mar_live_xK3f9QpZ…
const prefix = routerKeyDisplayPrefix(value) // mar_live_xK3f9QpZ — indexed, stored in clear

const policy = RoutingPolicy.parse(body.policy) // ZodError on anything but the six
const maybe = RoutingPolicy.safeParse(body.policy) // when you want to answer 400 yourself
```

## Testing

`bun test packages/core` — pure, no mocks, no I/O. Covers every error's code/status/name and the
uniqueness of that mapping, `QuotaExhaustedError` vs `CreditsExhaustedError` distinctness,
`isRouterError` against look-alikes, key shape/entropy/uniqueness and prefix round-trip, and each
enum accepting exactly its members while rejecting near-miss spellings.

## Gotchas

| Gotcha | What it means for you |
|---|---|
| `noUncheckedIndexedAccess` is on | `arr[i]` is `T \| undefined`. `ids.ts` uses `charAt` for exactly this reason — never paper over it with `!`, which Biome rejects anyway |
| **429 and 402 are never collapsed** | `QuotaExhaustedError` (clock-recoverable) and `CreditsExhaustedError` (human-recoverable) stay separate classes with separate statuses. A product rule from `02-domain-model.md`, not an implementation detail — merging them makes the router retry a dead account on a timer |
| Adding an error class is three edits | The class, its code in `ROUTER_ERROR_CODES`, and a row in the `cases` table in `test/unit/errors.test.ts`. The table test fails until the code is claimed exactly once |
| Schema and type share a name | `export const AccountStatus` + `export type AccountStatus`. Derive with `z.infer`; never hand-write a parallel interface |
| `test/` is outside `tsconfig.json` | `rootDir` is `src`, so `tsc --build` does not type-check the tests. `bun test` is what exercises them |

## See also

- [`../../docs/idea/02-domain-model.md`](../../docs/idea/02-domain-model.md) — the entities, statuses, and quota-window fields this package types
- [`../../docs/idea/01-architecture.md`](../../docs/idea/01-architecture.md) — layering and the dependency rules that make this the leaf package
- [`../../docs/idea/04-api-keys-and-access.md`](../../docs/idea/04-api-keys-and-access.md) — key format, scope, and the verification path
