import type { AccountView, SubscriptionCredentialView } from "./api/types"
import { formatDuration } from "./reset-countdown"

// A Claude subscription's *login* lifetime, as distinct from its quota windows.
//
// The refresh token the `claude` CLI holds inside the account's `CLAUDE_CONFIG_DIR` hard-expires
// about thirty days after the login regardless of use; only a fresh login moves it. The router
// never reads that token (CLAUDE.md non-negotiable 1) — the API reports the expiry instant and
// plan facts it observed, and this module turns them into the sentence a row prints and the
// banner the dashboard raises *before* six subscriptions die on the same morning.
//
// Pure: `nowMs` is passed in, so every threshold is testable against a fixed clock.

const DAY_MS = 86_400_000

/** Warn from a week out — long enough to plan six browser logins, short enough to be true. */
export const LOGIN_WARN_MS = 7 * DAY_MS
/** Danger from two days out: the next quiet moment may be after the expiry. */
export const LOGIN_DANGER_MS = 2 * DAY_MS

export type LoginTone = "neutral" | "warn" | "danger"

export interface LoginExpiryDisplay {
  readonly kind: "valid" | "expired" | "unknown"
  readonly tone: LoginTone
  /** The sentence for the cell. Never carries a countdown once the login is gone. */
  readonly text: string
  /** Epoch ms, only for `valid` — the absolute half of the pair the cell prints. */
  readonly expiresAtMs: number | null
  /** `"12d 4h"`, only for `valid`. */
  readonly countdown: string | null
}

/** Absent on an older API — read as `null`, never as "no credential". */
export function credentialOf(account: AccountView): SubscriptionCredentialView | null {
  return account.credential ?? null
}

/** True for the one provider whose login is a browser session the operator has to renew. */
export function isSubscriptionLogin(account: AccountView): boolean {
  return account.provider === "anthropic-oauth"
}

/**
 * "Login expired — reconnect" when the tokens are gone *or* the router has observed the auth
 * failure: `present: false` is the API's reading of the config directory, `needs_reauth` is what
 * a failed request taught the router. Either alone is enough — the second is how an account
 * whose file still exists but no longer refreshes gets named.
 */
export function describeLoginExpiry(account: AccountView, nowMs: number): LoginExpiryDisplay {
  const credential = credentialOf(account)
  if (account.status === "needs_reauth" || credential?.present === false) {
    return {
      kind: "expired",
      tone: "danger",
      text: "Login expired — reconnect",
      expiresAtMs: null,
      countdown: null,
    }
  }

  const expiresAtMs =
    credential?.expiresAt === null || credential === null
      ? Number.NaN
      : Date.parse(credential.expiresAt)
  if (!Number.isFinite(expiresAtMs)) {
    return {
      kind: "unknown",
      tone: "neutral",
      text: "Login expiry unknown",
      expiresAtMs: null,
      countdown: null,
    }
  }

  const remaining = expiresAtMs - nowMs
  if (remaining <= 0) {
    return {
      kind: "expired",
      tone: "danger",
      text: "Login expired — reconnect",
      expiresAtMs: null,
      countdown: null,
    }
  }

  return {
    kind: "valid",
    tone: remaining <= LOGIN_DANGER_MS ? "danger" : remaining <= LOGIN_WARN_MS ? "warn" : "neutral",
    text: "Login valid until",
    expiresAtMs,
    countdown: formatDuration(remaining),
  }
}

/**
 * "Max 20×", "Pro", "Team 5×" — the plan and its multiplier, from the two strings the API relays.
 * The tier is Anthropic's own spelling (`default_claude_max_20x`); the multiplier is read off its
 * tail and nothing else is inferred from it. Null when neither fact is known.
 */
export function subscriptionBadge(credential: SubscriptionCredentialView | null): string | null {
  if (credential === null) return null
  const plan = credential.subscriptionType?.trim() ?? ""
  const multiplier = credential.rateLimitTier?.match(/_(\d+)x$/i)?.[1] ?? null
  const name = plan === "" ? null : `${plan.charAt(0).toUpperCase()}${plan.slice(1)}`
  if (name === null && multiplier === null) return null
  if (name === null) return `${multiplier}×`
  return multiplier === null ? name : `${name} ${multiplier}×`
}

export interface SubscriptionHealth {
  /** Expired or observed dead — each needs one browser login. */
  readonly needsReconnect: readonly AccountView[]
  /** Still valid, but inside the warn threshold. Disjoint from `needsReconnect`. */
  readonly expiringSoon: readonly AccountView[]
}

/**
 * The two lists the dashboard banner is about. Disabled accounts are left out of both: an operator
 * who switched a subscription off is not asked to log it back in.
 */
export function summarizeSubscriptions(
  accounts: readonly AccountView[],
  nowMs: number,
): SubscriptionHealth {
  const needsReconnect: AccountView[] = []
  const expiringSoon: AccountView[] = []
  for (const account of accounts) {
    if (!isSubscriptionLogin(account) || account.status === "disabled") continue
    const login = describeLoginExpiry(account, nowMs)
    if (login.kind === "expired") needsReconnect.push(account)
    else if (login.kind === "valid" && login.tone !== "neutral") expiringSoon.push(account)
  }
  return { needsReconnect, expiringSoon }
}

/** How many labels a banner spells out before "and N more". Three reads; eleven is a wall. */
export const NAMED_LIMIT = 3

/** `"a, b, c and 3 more"` — never a wall of eleven labels in a sentence. */
export function listNames(labels: readonly string[], limit = NAMED_LIMIT): string {
  if (labels.length <= limit) return labels.join(", ")
  const rest = labels.length - limit
  return `${labels.slice(0, limit).join(", ")} and ${rest} more`
}

/** The banner's one-line title, or null when there is nothing to raise. */
export function subscriptionBannerTitle(health: SubscriptionHealth): string | null {
  const parts: string[] = []
  const dead = health.needsReconnect.length
  const soon = health.expiringSoon.length
  if (dead > 0)
    parts.push(
      `${dead} Claude subscription${dead === 1 ? "" : "s"} need${dead === 1 ? "s" : ""} a reconnect`,
    )
  if (soon > 0)
    parts.push(
      dead > 0
        ? `${soon} more expire${soon === 1 ? "s" : ""} within 7 days`
        : `${soon} Claude subscription${soon === 1 ? "" : "s"} expire${soon === 1 ? "s" : ""} within 7 days`,
    )
  return parts.length === 0 ? null : parts.join(" · ")
}
