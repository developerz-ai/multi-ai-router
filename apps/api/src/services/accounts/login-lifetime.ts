import type { CredentialMetadata } from "../../providers/claude-sdk/credential-metadata"

/**
 * How long a Claude subscription's *login* has left — the deadline an interactive re-login resets
 * and nothing else moves. Pure: the metadata, the last interactive login and the clock are all
 * handed in, so the arithmetic is testable against a fixed instant.
 *
 * Two sources, labelled the way the console labels quota resets:
 * - `reported` — the CLI persisted `refreshTokenExpiresAt` (it does when the token endpoint answers
 *   with `refresh_token_expires_in`; CLI 2.1.289 keeps the previous value across a refresh that
 *   omits it). That instant is the provider's own word and wins outright.
 * - `estimated` — the file carries no such instant, so the deadline is the last interactive login
 *   plus an assumed lifetime (`CLAUDE_LOGIN_ASSUMED_LIFETIME_DAYS`, default 28 — the production
 *   fleet and Meridian's contributors both measured roughly 27.5–29.5 days, the low end chosen so
 *   an estimate warns early rather than late).
 * - `unknown` — neither: no reported instant and no login the audit log remembers.
 *
 * **Timestamps only** (CLAUDE.md non-negotiables 1 and 13): the input type has no field that could
 * hold a token, so neither can anything computed from it.
 */

export type LoginRenewalSource = "reported" | "estimated" | "unknown"

export interface LoginLifetimePolicy {
  /** `CLAUDE_LOGIN_ASSUMED_LIFETIME_DAYS`, in ms: the estimate's lifetime past the last login. */
  readonly assumedLifetimeMs: number
  /** `CLAUDE_LOGIN_RENEWAL_WARN_DAYS`, in ms: inside this, renewal is "required soon". */
  readonly warnWindowMs: number
}

export interface LoginLifetimeInput {
  readonly metadata: Pick<
    CredentialMetadata,
    "refreshTokenExpiresAt" | "accessTokenExpiresAt" | "hasTokens"
  >
  /** The newest interactive login (`account.connected` / `account.reauthorized` via the CLI). */
  readonly lastLoginAt: Date | null
  readonly now: Date
  readonly policy: LoginLifetimePolicy
}

export interface LoginLifetime {
  /** When the CLI's current access token goes stale (~8 h). Null when the file does not say. */
  readonly accessTokenExpiresAt: Date | null
  readonly lastLoginAt: Date | null
  /** When a browser login is due again. Null when `source` is `unknown`. */
  readonly renewsAt: Date | null
  readonly source: LoginRenewalSource
  /** Whole days left, floored, never negative. Null when `renewsAt` is. */
  readonly daysUntilRenewal: number | null
  /** True inside the warn window or past the deadline — while the login still has tokens. */
  readonly renewalRequiredSoon: boolean
}

const DAY_MS = 86_400_000

export function computeLoginLifetime(input: LoginLifetimeInput): LoginLifetime {
  const { metadata, lastLoginAt, now, policy } = input
  const renewal = renewalOf(metadata.refreshTokenExpiresAt, lastLoginAt, policy)
  const remainingMs = renewal.at === null ? null : renewal.at.getTime() - now.getTime()
  return {
    accessTokenExpiresAt: metadata.accessTokenExpiresAt,
    lastLoginAt,
    renewsAt: renewal.at,
    source: renewal.source,
    daysUntilRenewal: remainingMs === null ? null : Math.max(0, Math.floor(remainingMs / DAY_MS)),
    // A blanked login is past "soon": it is the needs-reconnect case, which the console and the
    // park path already name. Warning about it here too would say the same thing twice.
    renewalRequiredSoon:
      metadata.hasTokens && remainingMs !== null && remainingMs <= policy.warnWindowMs,
  }
}

function renewalOf(
  reported: Date | null,
  lastLoginAt: Date | null,
  policy: LoginLifetimePolicy,
): { readonly at: Date | null; readonly source: LoginRenewalSource } {
  if (reported !== null) return { at: reported, source: "reported" }
  if (lastLoginAt === null) return { at: null, source: "unknown" }
  return { at: new Date(lastLoginAt.getTime() + policy.assumedLifetimeMs), source: "estimated" }
}

/** `env.claudeLogin`'s days, as the milliseconds the arithmetic above speaks. */
export function loginLifetimePolicy(config: {
  readonly assumedLifetimeDays: number
  readonly renewalWarnDays: number
}): LoginLifetimePolicy {
  return {
    assumedLifetimeMs: config.assumedLifetimeDays * DAY_MS,
    warnWindowMs: config.renewalWarnDays * DAY_MS,
  }
}
