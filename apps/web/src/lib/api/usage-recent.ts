import type {
  Dialect,
  EgressMode,
  ProviderId,
  UsageFault,
  UsageOutcome,
} from "@multi-ai-router/core"
import { request } from "./client"

// `/api/admin/usage/recent` — individual upstream attempts, newest first.
//
// This is the *"why did my request fail"* surface. Everything else on the usage
// screen aggregates: it can say 3% of attempts failed, but not which request, on
// which account, with which error class. Before this the answer was in the
// process logs, which an operator running a container cannot grep.
//
// Three properties are contract rather than incidental:
//
//   - **A row is an attempt, not a request.** A failover chain of three writes
//     three rows under one `correlationId`, and this feed shows all three — the
//     failover is the thing the operator came to see.
//   - **A label may be null**, with a `note` saying why, exactly as a breakdown
//     row does: `deleted` when the subject is gone (usage rows outlive what they
//     name), `none` when the dimension did not apply.
//   - **Nothing here can carry a credential.** `errorClass` is a class name, not
//     a message, and no request or response body is stored anywhere to leak.
//
// Everything imported from `@multi-ai-router/core` is imported **as a type**, and
// the outcome list below is restated rather than read off `UsageOutcome.options`.
// That is not laziness: core's vocabulary is Zod-backed, so one runtime import of
// it pulls Zod into this route's chunk — measured at 12 kB → 72 kB. The drift
// gates are the same ones `lib/account-status.ts` uses for `AccountStatus`: every
// mapping below is a `Record` over the core union, so a value added upstream is a
// **compile error**, and a unit test (which may import core freely, since tests
// are not bundled) asserts the restated list is exactly core's.

export const RECENT_LIMITS = [25, 50, 100, 200] as const
export const RECENT_LIMIT_DEFAULT = 50
const RECENT_LIMIT_MIN = 1
const RECENT_LIMIT_MAX = 200

/**
 * A guard on what the console may ask for, **not** a clamp — the same rule the
 * audit feed follows. The server answers 400 outside 1..200, and pretending a
 * 500 became a 200 would put a page size on screen that nobody chose.
 */
export function safeRecentLimit(limit: number): number {
  if (!Number.isInteger(limit)) return RECENT_LIMIT_DEFAULT
  return limit >= RECENT_LIMIT_MIN && limit <= RECENT_LIMIT_MAX ? limit : RECENT_LIMIT_DEFAULT
}

/** What the feed is narrowed to. `failed` is the toggle an operator actually clicks. */
export type RecentFilter = "all" | "failed" | UsageOutcome

/**
 * The outcomes the dropdown offers, in the order an operator reads them: served first, then the
 * caller's own faults, then the operator's capacity, then the upstream, then us.
 *
 * `satisfies` rejects any value core does not have, and a unit test asserts this is a permutation
 * of `UsageOutcome.options` — so an outcome added upstream cannot be silently missing from the
 * filter that an operator would use to look for it.
 */
export const RECENT_OUTCOME_FILTERS = [
  "success",
  "client_error",
  "translation_failed",
  "request_too_large",
  "key_revoked",
  "scope_violation",
  "key_rate_limited",
  "no_healthy_account",
  "quota_exhausted",
  "credits_exhausted",
  "upstream_error",
  "upstream_timeout",
  "upstream_auth_failed",
  "credential_decrypt_failed",
  "router_error",
] as const satisfies readonly UsageOutcome[]

export const RECENT_FILTERS: readonly RecentFilter[] = ["all", "failed", ...RECENT_OUTCOME_FILTERS]

export interface RecentQuery {
  readonly limit: number
  readonly filter: RecentFilter
  /** The router's correlation id or the caller's own `x-request-id`. Either works. */
  readonly requestId: string | null
}

/** One named subject on an attempt — the key, the account, the pool. */
export interface RecentSubject {
  readonly id: string | null
  readonly label: string | null
  readonly note: "deleted" | "none" | null
}

export interface RecentAttempt {
  readonly id: string
  readonly correlationId: string
  readonly clientRequestId: string | null
  readonly attempt: number
  readonly key: RecentSubject
  readonly account: RecentSubject
  readonly pool: RecentSubject
  readonly provider: ProviderId | null
  readonly model: string
  readonly upstreamModel: string | null
  readonly ingressDialect: Dialect | null
  readonly egressMode: EgressMode | null
  readonly outcome: UsageOutcome
  /** Whose problem the outcome is. Resolved by the router from `outcome`, never re-derived here. */
  readonly fault: UsageFault
  readonly httpStatus: number | null
  readonly errorClass: string | null
  readonly latencyMs: number
  readonly ttfbMs: number | null
  readonly routerOverheadMs: number
  readonly streamed: boolean
  readonly tokensIn: number
  readonly tokensOut: number
  readonly at: string
}

export interface RecentPage {
  readonly attempts: readonly RecentAttempt[]
  /** The limit the server actually applied, which is what the caption may quote. */
  readonly limit: number
}

/** A semantic token name, resolved through `var(...)` at the call site. Never a hex. */
export type FaultToken = "--ok" | "--warn" | "--danger" | "--text-muted"

/**
 * Colour is never the only carrier — every row prints the outcome in words
 * beside the dot. This only decides which of the four semantic tokens the dot
 * takes, and it is total over `UsageFault` so a fault group added to core fails
 * this build rather than rendering as a default.
 */
const FAULT_TOKEN: Readonly<Record<UsageFault, FaultToken>> = {
  none: "--ok",
  // The caller sent something no account would have accepted. Nothing is broken here.
  client: "--text-muted",
  // The operator has no capacity to give: a window to wait out or a balance to top up.
  capacity: "--warn",
  upstream: "--danger",
  router: "--danger",
}

export function faultToken(fault: UsageFault): FaultToken {
  return FAULT_TOKEN[fault]
}

const FAULT_LABEL: Readonly<Record<UsageFault, string>> = {
  none: "Served",
  client: "Caller",
  capacity: "Capacity",
  upstream: "Upstream",
  router: "Router",
}

/** One word for whose problem it is, printed beside the dot rather than implied by it. */
export function faultLabel(fault: UsageFault): string {
  return FAULT_LABEL[fault]
}

/** `upstream_timeout` → `upstream timeout`. The vocabulary is core's; only the spacing is ours. */
export function outcomeLabel(outcome: UsageOutcome): string {
  return outcome.replace(/_/g, " ")
}

export function recentFilterLabel(filter: RecentFilter): string {
  if (filter === "all") return "Everything"
  if (filter === "failed") return "Failures only"
  return outcomeLabel(filter)
}

/**
 * The filter as query params. `all` sends nothing; `failed` sends the flag the
 * server turns into every non-success outcome; anything else names one outcome.
 *
 * The two are never sent together — the server rejects that pairing with a 400,
 * and this is the one place that could produce it.
 */
export function recentQueryParams(
  query: RecentQuery,
): Readonly<Record<string, string | undefined>> {
  return {
    limit: String(safeRecentLimit(query.limit)),
    failed: query.filter === "failed" ? "true" : undefined,
    outcome: query.filter === "all" || query.filter === "failed" ? undefined : query.filter,
    requestId: query.requestId ?? undefined,
  }
}

export function fetchRecentAttempts(query: RecentQuery): Promise<RecentPage> {
  return request<RecentPage>({
    method: "GET",
    path: "/usage/recent",
    query: recentQueryParams(query),
  })
}
