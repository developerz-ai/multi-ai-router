import type { CredentialRefreshLock } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import { abortableSleep, throwIfAborted } from "./abort"
import type { AccountConfigDirs } from "./config-dir"
import type { CredentialMetadata, CredentialMetadataReader } from "./credential-metadata"
import { CredentialMetadataOwnershipUnavailable } from "./ownership-errors"
import { createRefreshWindow } from "./refresh-window"

/** The sentence an abort with a non-Error reason carries out of the wait. */
const ABANDONED = "the credential refresh wait was abandoned"

/**
 * Who may spawn a `claude` subprocess against an Account whose access token is about to be
 * refreshed — and, more importantly, who may **not**.
 *
 * **The incident this exists for, third reading (2026-09-07, the one the evidence supports).**
 * Anthropic's OAuth refresh token *rotates*: a successful refresh consumes the stored value and
 * returns a new one. The CLI refreshes at startup whenever the access token is expired or inside
 * its own lead of {@link CLI_REFRESH_LEAD_MS}, and it persists the rotated token only *after* the
 * token endpoint has answered. A turn-free idle query (`idle-query.ts` — the model-catalog sweep,
 * the usage gauge) wants nothing but the `initialize` handshake, so it closed the query the moment
 * the handshake answered, and the SDK ended the subprocess before that write landed. The refresh
 * token on disk was now spent. The next process to refresh — a client's turn, the keepalive, or
 * the next probe — presented it, was told `invalid_grant`, and the CLI's dead-token handler blanked
 * both tokens. Every one of the 2026-09-06/07 deauthentications sits within a minute of exactly
 * that sequence, and the accounts that survived were the ones a *real turn* happened to reach
 * first, because a turn lives long enough for the write. Two earlier readings of the same losses —
 * a double-spend race between two subprocesses, then an upstream invalidating idle tokens — were
 * each contradicted by the next day's data; docs/idea/11-anthropic-agent-sdk.md §3 keeps the ledger
 * and records that the production trigger itself stays unverified.
 *
 * **So the rule is: a subprocess that will be ended early must never be the one that refreshes.**
 * {@link CredentialFreshness.wouldRefresh} is that rule, and every turn-free spawn asks it before
 * taking a slot. Inside {@link CredentialFreshnessDeps.coldMarginMs} of the access token's expiry
 * the answer is `true` and the idle query is refused without spawning; the credential is left for
 * a real turn, which refreshes as part of a process that runs to completion. The margin is floored
 * at the CLI's own lead at the env boundary, because a margin narrower than that is precisely the
 * bug.
 *
 * {@link CredentialFreshness.ensureFresh} is the older half: one real turn at a time across the
 * window, so two live subprocesses do not both ask the token endpoint. It resolves to a **claim**
 * ({@link CredentialRefreshClaim}): the first caller across the line is not delayed at all — it
 * owns the window, and its idempotent `release()` is what the spawning turn calls when it ends, so
 * ownership lives exactly as long as the process that holds it. Everyone else waits until the
 * credential file shows the new token, capped by {@link CredentialFreshnessDeps.maxWaitMs} and
 * then let through with a no-op claim regardless. One unreleased holder admits exactly one owner;
 * takeover is restricted to released or older-than-cap entries — and, when
 * {@link CredentialFreshnessDeps.refreshLock} is wired, only while the cross-replica lease can be
 * won. A holder that was taken over from and never released stays on the record beside the
 * newcomer: it may still be inside its refresh window, so a caller that cannot win the lease waits
 * behind it rather than becoming a second owner of one credential.
 *
 * It sits *beside* the concurrency semaphore rather than inside it, because that gate bounds
 * memory and only the `query()` paths hold it; every spawn site takes freshness first and a slot
 * second, and re-asks the window once the slot is granted — one fixed order, so the two cannot
 * deadlock, and a caller that crossed the expiry boundary while queued re-enters the window
 * instead of spawning an uncoordinated refresher.
 *
 * **What it costs.** Outside the window — which is almost always — both calls are one ~500-byte
 * read of a file the page cache already holds. That read is deliberately not cached: a cache here
 * would have to be invalidated by the very event it cannot see (the CLI rewriting the file from
 * another process), and acting on a stale expiry is precisely the mistake this module exists to
 * prevent. It sits on the Agent-SDK path, which CLAUDE.md non-negotiable 8 names as the labelled
 * exception to the overhead budget, and it is followed by spawning a ~245 MB binary.
 *
 * **Credential reads fail open.** Ordinary credential failures of `ensureFresh` — an unreadable file, a stalled winner, a
 * refresh that never lands — ends in the caller proceeding. An unreadable file makes `wouldRefresh`
 * answer `false`: a probe cannot rotate a token the CLI cannot read either. Lease capacity and
 * lock errors fail open the same way, with a `warn` — the caller proceeds on its local entry alone.
 * Ownership admission failure rejects both methods before any CLI can start.
 *
 * **Metadata, never the token** (CLAUDE.md non-negotiables 1 and 13). This module reads two instants
 * and a boolean through {@link CredentialMetadataReader}, whose return type has no field that could
 * hold a token. It does not refresh, forward, or write a credential — the Agent SDK still owns them
 * inside the Account's `CLAUDE_CONFIG_DIR`. All this does is decide who spawns, and who waits.
 */

/**
 * How far ahead of an access token's expiry the `claude` CLI refreshes it on its own.
 *
 * Provenance: CLI 2.1.261 (the binary bundled with Agent SDK 0.3.261), `qO(expiresAt)`; re-verified
 * unchanged in CLI 2.1.273 (Agent SDK 0.3.273, where it is `cF`), CLI 2.1.286 (Agent SDK 0.3.286,
 * where it is `SN`) and CLI 2.1.289 (Agent SDK 0.3.289, where it is `$$`):
 * `Date.now() + 300000 >= expiresAt`. Blast radius: if the CLI widens this, an idle query spawned
 * between the two leads would once again be ended mid-refresh — so the configured cold margin is
 * floored at this value at boot, and the floor is what to raise if the CLI moves.
 */
export const CLI_REFRESH_LEAD_MS = 300_000

/**
 * One caller's ownership of an Account's refresh window. `release` is idempotent and synchronous,
 * and a claim that never owned anything releases nothing — the window-closed path costs one
 * metadata read and hands back a shared no-op.
 */
export interface CredentialRefreshClaim {
  readonly release: () => void
}

export interface CredentialFreshness {
  /**
   * Resolves to this caller's claim on the Account's refresh window. Returns a no-op claim
   * immediately when the Account's access token is not near expiry, which is the overwhelmingly
   * common case.
   *
   * Never rejects for a credential reason — a caller that cannot be helped is let through. It
   * rejects when filesystem ownership is unavailable or `signal` aborts, carrying the signal's own
   * reason so the caller classifies the abort exactly as it classifies every other one.
   *
   * `held` makes the call re-entrant: a caller re-asking the window with its own earlier claim in
   * hand (the invoker's recheck once its slot is granted) is answered with a no-op claim at once
   * while that claim still owns the window. Without it the caller's own unreleased holder reads as
   * a foreign ACTIVE owner, and it waits the whole cap on a refresh that only it can start.
   */
  ensureFresh(
    accountId: string,
    signal: AbortSignal,
    held?: CredentialRefreshClaim,
  ): Promise<CredentialRefreshClaim>
  /**
   * Whether a `claude` subprocess spawned against `accountId` right now would refresh its access
   * token — and so must not be a turn-free one, which is ended before the rotated refresh token
   * is written. `true` inside {@link CredentialFreshnessDeps.coldMarginMs} of expiry, or past it.
   *
   * `false` for an Account with no tokens (nothing to rotate), an expiry the file never carried
   * (the CLI would not refresh on unknown either), or a file that cannot be read. Rejects if filesystem ownership is unavailable.
   */
  wouldRefresh(accountId: string): Promise<boolean>
}

export interface CredentialFreshnessDeps {
  readonly reader: Pick<CredentialMetadataReader, "read">
  readonly configDirs: Pick<AccountConfigDirs, "pathFor">
  /**
   * How long before the access token expires the window opens. Config, not a constant
   * (`CLAUDE_SDK_CREDENTIAL_REFRESH_SKEW_SECONDS`). Wide enough to cover a spawn that starts just
   * before expiry and refreshes just after.
   */
  readonly skewMs: number
  /**
   * How close to the access token's expiry a credential counts as **cold**: a turn-free spawn is
   * refused against it, and the sweep's keepalive spends a real turn on it instead
   * (`CLAUDE_SDK_CREDENTIAL_COLD_MARGIN_SECONDS`). At least {@link CLI_REFRESH_LEAD_MS}, which the
   * env boundary enforces — the CLI refreshes inside its own lead whether we like it or not.
   */
  readonly coldMarginMs: number
  /** The cap on a waiter's patience (`CLAUDE_SDK_CREDENTIAL_REFRESH_WAIT_MS`). Then it proceeds. */
  readonly maxWaitMs: number
  /** How often a waiter re-reads the credential file (`CLAUDE_SDK_CREDENTIAL_REFRESH_POLL_MS`). */
  readonly pollMs: number
  readonly now: () => Date
  /** Injected so a test never sleeps in real time. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /**
   * The cross-replica half of the window: the per-account credential-refresh advisory lock
   * (`CredentialRefreshLock.tryAcquire`) the OAuth refresher already holds around its own token
   * exchange, so an SDK turn on one replica and a refresher on another cannot hold one credential's
   * window at once. Optional — a deployment that wires none coordinates locally only.
   */
  readonly refreshLock?: Pick<CredentialRefreshLock, "tryAcquire">
  readonly logger?: Logger
}

/** A claim that never owned anything — the window-closed answer, shared because it is stateless. */
const NO_OP: CredentialRefreshClaim = { release: () => {} }

/** What one Account's window looks like right now. `null` expiry is "unknown", never "fresh". */
type Freshness = "fresh" | "refreshing" | "no-credential"

export function createCredentialFreshness(deps: CredentialFreshnessDeps): CredentialFreshness {
  const sleep =
    deps.sleep ?? ((ms: number, signal: AbortSignal) => abortableSleep(ms, signal, ABANDONED))
  const window = createRefreshWindow(deps)

  const classify = async (accountId: string): Promise<Freshness> => {
    const metadata = await deps.reader.read(deps.configDirs.pathFor(accountId))
    // Nothing to race over: no login here, or one the CLI has already blanked. Routing parks these
    // elsewhere; holding them back would only delay the error that tells the operator to reconnect.
    if (!metadata.hasTokens) return "no-credential"
    const expiresAt = metadata.accessTokenExpiresAt
    // Unknown expiry is treated as fresh on purpose. A file that never carried `expiresAt` would
    // otherwise put every one of that Account's requests through the slow path forever.
    if (expiresAt === null) return "fresh"
    return expiresAt.getTime() - deps.now().getTime() > deps.skewMs ? "fresh" : "refreshing"
  }

  return {
    wouldRefresh: async (accountId) => {
      let metadata: CredentialMetadata
      try {
        metadata = await deps.reader.read(deps.configDirs.pathFor(accountId))
      } catch (error) {
        if (error instanceof CredentialMetadataOwnershipUnavailable) throw error
        deps.logger?.warn("claude credential freshness unreadable", {
          accountId,
          reason: error instanceof Error ? error.message : String(error),
        })
        return false
      }
      if (!metadata.hasTokens) return false
      const expiresAt = metadata.accessTokenExpiresAt
      if (expiresAt === null) return false
      return expiresAt.getTime() - deps.now().getTime() <= deps.coldMarginMs
    },

    ensureFresh: async (accountId, signal, held) => {
      throwIfAborted(signal, ABANDONED)
      // Still this caller's window: its own holder is not somebody else's refresh to wait on.
      if (held !== undefined && window.stillOwns(accountId, held)) return NO_OP

      let state: Freshness
      try {
        state = await classify(accountId)
      } catch (error) {
        if (error instanceof CredentialMetadataOwnershipUnavailable) throw error
        // Unknown, not blocked. The message names a path or an errno at most, and goes through the
        // redactor like every other field.
        deps.logger?.warn("claude credential freshness unreadable", {
          accountId,
          reason: error instanceof Error ? error.message : String(error),
        })
        return NO_OP
      }

      if (state !== "refreshing") return NO_OP

      const startedAt = deps.now().getTime()
      for (;;) {
        const claim = await window.tryOwn(accountId, signal)
        if (claim !== null) return claim

        // Someone is already inside. Wait for their release or for the file to say the refresh
        // landed — whichever first; a holder that never releases is bounded by the same cap, so a
        // crashed winner cannot wedge the Account. Every holder still on the record is raced
        // against: a takeover leaves the displaced owner recorded, and its release is a wake-up
        // this waiter must not miss.
        await Promise.race([...window.anyRelease(accountId), sleep(deps.pollMs, signal)])
        throwIfAborted(signal, ABANDONED)

        const waitedMs = deps.now().getTime() - startedAt
        if (waitedMs >= deps.maxWaitMs) {
          // Fail open, loudly. Either the winner is wedged or the CLI did not refresh when we
          // expected it to; both are worth an operator's attention, neither is worth an outage.
          // The entry is left exactly as it stands: erasing one we do not own is the takeover race
          // — a second refresher straight in while the first may still be mid-refresh.
          deps.logger?.warn("claude credential refresh did not land; proceeding anyway", {
            accountId,
            waitedMs,
          })
          return NO_OP
        }
        let next: Freshness
        try {
          next = await classify(accountId)
        } catch (error) {
          if (error instanceof CredentialMetadataOwnershipUnavailable) throw error
          return NO_OP
        }
        if (next !== "refreshing") {
          deps.logger?.info("claude credential refresh observed", { accountId, waitedMs })
          return NO_OP
        }
      }
    },
  }
}

/** A freshness gate for a deployment that wires none: everything is fresh, nothing ever waits. */
export const ALWAYS_FRESH: CredentialFreshness = {
  ensureFresh: async () => NO_OP,
  wouldRefresh: async () => false,
}
