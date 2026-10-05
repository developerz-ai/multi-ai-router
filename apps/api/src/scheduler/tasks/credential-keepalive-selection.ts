import type { AccountRow } from "@multi-ai-router/db"
import type { CredentialMetadata } from "../../providers/claude-sdk/credential-metadata"

/**
 * Which subscriptions the credential keepalive spends a turn on this tick — pure, so the decision
 * that costs money is tested against a fixed clock and hand-built metadata, with no subprocess.
 *
 * **Due** means: the `claude` CLI would refresh this account's access token if a process started
 * now — the token is inside the CLI's own lead (`CLI_REFRESH_LEAD_MS`) or already past expiry. A
 * turn earlier than that refreshes nothing (the CLI does not refresh a token it considers fresh),
 * so it would be a turn bought for nothing; "never more often than needed" is this predicate.
 *
 * Never due: an account that is not `active` (`needs_reauth` and `disabled` need a human, a
 * cooling or exhausted one is the breaker's — and the background admission gate would refuse its
 * turn anyway), a credential with no tokens (nothing for the CLI to refresh), and an expiry the
 * file never carried (unknown is not cold; warming on it would bill every account every tick).
 *
 * **Backoff.** An account whose last keepalive ran against the same access-token expiry less than
 * `retryMs` ago is left alone: the turn did not move the expiry, and repeating it every tick would
 * bill a broken account a turn every few minutes. A new expiry — a refresh landed by any process —
 * clears the backoff by construction, because the remembered expiry no longer matches.
 *
 * Metadata only (CLAUDE.md non-negotiables 1 and 13): instants and a presence boolean.
 */

export interface KeepaliveCandidate {
  readonly account: AccountRow
  readonly metadata: CredentialMetadata
}

/** The last keepalive turn this replica spent on an account, keyed to the expiry it saw. */
export interface KeepaliveAttempt {
  readonly atMs: number
  readonly accessTokenExpiresAtMs: number
}

export interface KeepalivePolicy {
  /** The CLI's own refresh lead. A token further out than this is not refreshed by a turn. */
  readonly leadMs: number
  /** `CLAUDE_SDK_CREDENTIAL_KEEPALIVE_RETRY_MINUTES`, in ms. */
  readonly retryMs: number
  /** At most this many turns per tick. Each is a ~245 MB subprocess. */
  readonly batchSize: number
}

export type KeepaliveVerdict =
  | "due"
  | "fresh"
  | "not-active"
  | "no-credential"
  | "unknown-expiry"
  | "backing-off"

export function keepaliveVerdict(
  candidate: KeepaliveCandidate,
  nowMs: number,
  policy: Pick<KeepalivePolicy, "leadMs" | "retryMs">,
  lastAttempt: KeepaliveAttempt | undefined,
): KeepaliveVerdict {
  if (candidate.account.status !== "active") return "not-active"
  if (!candidate.metadata.hasTokens) return "no-credential"
  const expiresAt = candidate.metadata.accessTokenExpiresAt
  if (expiresAt === null) return "unknown-expiry"
  if (expiresAt.getTime() - nowMs > policy.leadMs) return "fresh"
  if (
    lastAttempt !== undefined &&
    lastAttempt.accessTokenExpiresAtMs === expiresAt.getTime() &&
    nowMs - lastAttempt.atMs < policy.retryMs
  )
    return "backing-off"
  return "due"
}

export interface KeepaliveSelection {
  /** Soonest expiry first, at most `batchSize`. */
  readonly due: readonly KeepaliveCandidate[]
  /** Due, but over this tick's batch: the next tick takes them. */
  readonly deferred: number
  readonly backingOff: number
}

export function selectKeepaliveTargets(
  candidates: readonly KeepaliveCandidate[],
  nowMs: number,
  policy: KeepalivePolicy,
  attempts: ReadonlyMap<string, KeepaliveAttempt>,
): KeepaliveSelection {
  const due: KeepaliveCandidate[] = []
  let backingOff = 0
  for (const candidate of candidates) {
    const verdict = keepaliveVerdict(candidate, nowMs, policy, attempts.get(candidate.account.id))
    if (verdict === "due") due.push(candidate)
    else if (verdict === "backing-off") backingOff += 1
  }
  due.sort((a, b) => expiryMs(a) - expiryMs(b) || a.account.id.localeCompare(b.account.id))
  return {
    due: due.slice(0, policy.batchSize),
    deferred: Math.max(0, due.length - policy.batchSize),
    backingOff,
  }
}

function expiryMs(candidate: KeepaliveCandidate): number {
  return candidate.metadata.accessTokenExpiresAt?.getTime() ?? Number.POSITIVE_INFINITY
}

/**
 * What a keepalive turn did to the credential, in timestamps. `refreshed` is the access token's
 * expiry moving forward — the CLI rotated. `loginExpiryMoved` is the open question this line
 * exists to answer: whether a rotation also extends the *login* (`refreshTokenExpiresAt`; Meridian
 * logs the same pair to find out). `null` when either side did not carry the instant, so absence
 * is never read as "no". The field names avoid `token` on purpose: the log redactor masks any
 * field so named, which would hide the very timestamps this line exists to record.
 */
export interface RotationReport {
  readonly refreshed: boolean
  readonly accessExpiresAtBefore: string | null
  readonly accessExpiresAtAfter: string | null
  readonly loginExpiresAtBefore: string | null
  readonly loginExpiresAtAfter: string | null
  readonly loginExpiryMoved: boolean | null
}

export function describeRotation(
  before: Pick<CredentialMetadata, "accessTokenExpiresAt" | "refreshTokenExpiresAt">,
  after: Pick<CredentialMetadata, "accessTokenExpiresAt" | "refreshTokenExpiresAt">,
): RotationReport {
  const accessBefore = before.accessTokenExpiresAt?.getTime() ?? null
  const accessAfter = after.accessTokenExpiresAt?.getTime() ?? null
  const refreshBefore = before.refreshTokenExpiresAt?.getTime() ?? null
  const refreshAfter = after.refreshTokenExpiresAt?.getTime() ?? null
  return {
    refreshed: accessBefore !== null && accessAfter !== null && accessAfter > accessBefore,
    accessExpiresAtBefore: iso(accessBefore),
    accessExpiresAtAfter: iso(accessAfter),
    loginExpiresAtBefore: iso(refreshBefore),
    loginExpiresAtAfter: iso(refreshAfter),
    loginExpiryMoved:
      refreshBefore === null || refreshAfter === null ? null : refreshAfter !== refreshBefore,
  }
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString()
}
