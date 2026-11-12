import {
  defaultWallScope,
  isRetryableWall,
  isRouterError,
  QuotaExhaustedError,
  type ReconnectAccount,
  type ResetSource,
  type Wall,
  type WalledAccount,
  type WallScope,
  wallOfError,
} from "@multi-ai-router/core"
import { redactValue } from "../logging/redact"
import {
  RequestAdmissionUnavailableError,
  RouterShutdownError,
} from "../services/dataplane/active-requests"
import { ClientCancelledError } from "../services/dataplane/relay-cancellation"
import { opaqueAccountRef } from "./account-ref"
import { type RouterReconnectEntry, reconnectEntries, reconnectOf } from "./reconnect"

/**
 * `error.router`: the machine-readable verdict on every error the transport renders, in every
 * dialect. Additive — the sentence beside it is unchanged, so a client reading prose keeps working
 * while a client reading this never has to. Pure: the thrown value, the request's own facts, and
 * the `Retry-After` the header carries are all it reads.
 * docs/idea/06-protocol-translation.md#the-router-error-object.
 */
export interface RouterErrorObject {
  readonly wall: Wall
  readonly scope: WallScope
  /** `true` exactly when `wall` is `clock` or `capacity`: the same request may succeed later. */
  readonly retryable: boolean
  readonly reset_at: string | null
  readonly reset_source: ResetSource | null
  /** Equal to the `Retry-After` header, or `null` when none is sent. */
  readonly retry_after_s: number | null
  readonly accounts: readonly RouterErrorAccount[]
  readonly pools: readonly string[]
  readonly signal: string | null
  /** Upstream attempts this request made before the router answered; `0` when none. */
  readonly attempts: number
  readonly request_id: string | null
  /** Accounts a human must reconnect for this to be served (`errors/reconnect.ts`); `[]` when none. */
  readonly reconnect: readonly RouterReconnectEntry[]
}

export interface RouterErrorAccount {
  /** {@link opaqueAccountRef} — the same value `x-router-account` carries. */
  readonly account: string
  readonly state: string
  readonly reset_at: string | null
}

/**
 * What the request itself learned while it ran — the attempts it made and the pools selection
 * drew from. The dispatcher notes them on the thrown value as it leaves; the transport reads them
 * back here. Keyed weakly by the error, so nothing outlives the request that threw it.
 */
export interface RequestFacts {
  readonly attempts: number
  readonly accounts: readonly WalledAccount[]
  readonly pools: readonly string[]
  /** In-scope accounts selection dropped as `needs-reauth` (`errors/reconnect.ts`). */
  readonly reconnect?: readonly ReconnectAccount[] | undefined
}

const REQUEST_FACTS = new WeakMap<object, RequestFacts>()

export function noteRequestFacts(error: unknown, facts: RequestFacts): void {
  if (typeof error === "object" && error !== null) REQUEST_FACTS.set(error, facts)
}

export function requestFactsOf(error: unknown): RequestFacts | undefined {
  return typeof error === "object" && error !== null ? REQUEST_FACTS.get(error) : undefined
}

/** Rendered `Retry-After` seconds: a whole number, at least one, from whatever the error stated. */
export function retryAfterHeaderSeconds(seconds: number): number {
  return Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 1
}

export function routerErrorObject(
  error: unknown,
  retryAfterSeconds: number | null,
  requestId: string | null,
  consoleUrl: string | null = null,
): RouterErrorObject {
  const { wall, scope } = classify(error)
  const detail = isRouterError(error) ? error.detail : {}
  const facts = requestFactsOf(error)
  const resetsAt = error instanceof QuotaExhaustedError ? error.resetsAt : undefined
  // The throw site's own list is the verdict; the attempted accounts are the fallback.
  const accounts = detail.accounts ?? facts?.accounts ?? []
  return {
    wall,
    scope: detail.scope ?? scope,
    retryable: isRetryableWall(wall),
    reset_at: resetsAt?.toISOString() ?? null,
    reset_source: resetsAt === undefined ? null : (detail.resetSource ?? null),
    retry_after_s: retryAfterSeconds === null ? null : retryAfterHeaderSeconds(retryAfterSeconds),
    accounts: accounts.map((entry) => ({
      account: opaqueAccountRef(entry.accountId),
      state: entry.state,
      reset_at: entry.resetsAt?.toISOString() ?? null,
    })),
    // Router-held text, but an operator names pools and an upstream shapes a signal: both pass the
    // same scrub as the sentence (`render.ts`).
    pools: (detail.pools ?? facts?.pools ?? []).map((name) => redactValue(name)),
    signal: detail.signal === undefined ? null : redactValue(detail.signal),
    attempts: facts?.attempts ?? 0,
    request_id: requestId,
    reconnect: reconnectEntries(reconnectOf(error, facts?.reconnect), consoleUrl),
  }
}

/**
 * A router-authored answer no thrown `RouterError` describes — an admin refusal, a missing route,
 * a stream the router ended after its first byte — stated as the same object.
 */
export interface RouterVerdict {
  readonly wall: Wall
  readonly scope: WallScope
  readonly signal?: string
  readonly accounts?: readonly WalledAccount[]
  readonly attempts?: number
  /** The `Retry-After` the answer carries, if any. */
  readonly retryAfterSeconds?: number
}

export function verdictObject(verdict: RouterVerdict, requestId: string | null): RouterErrorObject {
  return {
    wall: verdict.wall,
    scope: verdict.scope,
    retryable: isRetryableWall(verdict.wall),
    reset_at: null,
    reset_source: null,
    retry_after_s:
      verdict.retryAfterSeconds === undefined
        ? null
        : retryAfterHeaderSeconds(verdict.retryAfterSeconds),
    accounts: (verdict.accounts ?? []).map((entry) => ({
      account: opaqueAccountRef(entry.accountId),
      state: entry.state,
      reset_at: entry.resetsAt?.toISOString() ?? null,
    })),
    pools: [],
    signal: verdict.signal === undefined ? null : redactValue(verdict.signal),
    attempts: verdict.attempts ?? 0,
    request_id: requestId,
    reconnect: [],
  }
}

/** The router's own failures that are not `RouterError`s, each with the wall it means. */
function classify(error: unknown): { wall: Wall; scope: WallScope } {
  if (isRouterError(error)) return { wall: wallOfError(error), scope: defaultWallScope(error.code) }
  if (error instanceof ClientCancelledError) return { wall: "request", scope: "request" }
  if (error instanceof RouterShutdownError || error instanceof RequestAdmissionUnavailableError)
    return { wall: "capacity", scope: "router" }
  return { wall: "internal", scope: "router" }
}
