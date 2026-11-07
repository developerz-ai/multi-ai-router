import type { ResetSource } from "./domain/account"
import { NoHealthyAccountError, type RouterError, type RouterErrorCode } from "./errors"

/**
 * The machine-readable half of a router-authored error: what kind of wall the caller hit, how wide
 * it is, and what clears it. Rendered as `error.router` in every dialect (`apps/api/src/errors/`),
 * beside the sentence, which stays as it was until every consumer reads this instead.
 * docs/idea/06-protocol-translation.md#the-router-error-object.
 */

/**
 * What clears the wall — one value per error code, so the status and the wall can never disagree
 * (`429` clock, `402` human, `403` scope, `503` capacity). One exception, typed rather than
 * negotiated: a `NoHealthyAccountError` (`503`) names `capacity`, `human` or `scope`, because an
 * empty pool, a pool of switched-off accounts and a pool serving other models are all `503`s that
 * a retry does not clear alike.
 *
 * - `clock`: a stated wait clears it; the same request succeeds after `retry_after_s`.
 * - `capacity`: nothing in scope can serve right now; retrying later may succeed, with no instant.
 * - `human`: an operator must act — top up, re-authenticate, fix the stored credential, mint a key.
 * - `scope`: this key cannot reach what was asked; a different key or model, not a wait.
 * - `request`: the request itself is wrong; sending it again unchanged fails the same way.
 * - `internal`: the router failed; nothing the caller sent explains it.
 */
export const WALLS = ["clock", "capacity", "human", "scope", "request", "internal"] as const
export type Wall = (typeof WALLS)[number]

/**
 * Who the verdict is about.
 *
 * - `pool`: every account the key reaches, judged together before or after the attempts.
 * - `account`: one upstream account's own answer, the most actionable one the chain held.
 * - `session`: the account a bound session must stay on.
 * - `key`: the presented router key itself; no account was asked.
 * - `request`: the request's own shape.
 * - `router`: the router process.
 */
export const WALL_SCOPES = ["pool", "account", "session", "key", "request", "router"] as const
export type WallScope = (typeof WALL_SCOPES)[number]

/** Total over the code union: a new error class does not compile until its wall is decided. */
const WALL_OF: Readonly<Record<RouterErrorCode, { wall: Wall; scope: WallScope }>> = {
  no_healthy_account: { wall: "capacity", scope: "pool" },
  quota_exhausted: { wall: "clock", scope: "pool" },
  credits_exhausted: { wall: "human", scope: "pool" },
  scope_violation: { wall: "scope", scope: "key" },
  key_revoked: { wall: "human", scope: "key" },
  key_rate_limited: { wall: "clock", scope: "key" },
  key_verification_unavailable: { wall: "capacity", scope: "router" },
  admin_auth_failed: { wall: "request", scope: "request" },
  csrf_token_invalid: { wall: "request", scope: "request" },
  upstream_auth_failed: { wall: "human", scope: "account" },
  upstream_timeout: { wall: "capacity", scope: "account" },
  upstream_overloaded: { wall: "clock", scope: "pool" },
  credential_decrypt_failed: { wall: "human", scope: "account" },
  translation_failed: { wall: "request", scope: "request" },
  model_not_found: { wall: "scope", scope: "key" },
  request_too_large: { wall: "request", scope: "request" },
  invalid_request: { wall: "request", scope: "request" },
  unsupported_content_encoding: { wall: "request", scope: "request" },
}

export function wallOf(code: RouterErrorCode): Wall {
  return WALL_OF[code].wall
}

/** The wall a thrown error names: its code's, or the one its class let the throw site choose. */
export function wallOfError(error: RouterError): Wall {
  return error instanceof NoHealthyAccountError ? error.wall : wallOf(error.code)
}

export function defaultWallScope(code: RouterErrorCode): WallScope {
  return WALL_OF[code].scope
}

/** A wall a retry can clear without anyone changing anything. */
export function isRetryableWall(wall: Wall): boolean {
  return wall === "clock" || wall === "capacity"
}

/** One account the verdict names, by router id — rendered opaque, never by label or credential. */
export interface WalledAccount {
  readonly accountId: string
  /** The routing filter reason (`cooling-down`, `exhausted`, …) or the attempt's usage outcome. */
  readonly state: string
  readonly resetsAt?: Date
}

/** What a throw site knows beyond the class. Every field optional: absent renders as `null`/`[]`. */
export interface RouterErrorDetail {
  /** Overrides the code's default scope, when the throw site knows better. */
  readonly scope?: WallScope
  /** The machine token that decided it: a classifier signal (`http-status:429`) or a filter reason. */
  readonly signal?: string
  /** Provenance of `QuotaExhaustedError.resetsAt`. */
  readonly resetSource?: ResetSource
  readonly accounts?: readonly WalledAccount[]
  /** Pool names the verdict covers. */
  readonly pools?: readonly string[]
}

/** The constructor options every `RouterError` takes. */
export interface RouterErrorInit extends ErrorOptions {
  readonly detail?: RouterErrorDetail
}
