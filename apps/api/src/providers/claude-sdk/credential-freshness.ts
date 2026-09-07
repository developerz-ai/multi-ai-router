import type { Logger } from "../../logging/logger"
import type { AccountConfigDirs } from "./config-dir"
import type { CredentialMetadata, CredentialMetadataReader } from "./credential-metadata"

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
 * each contradicted by the next day's data; docs/idea/11-anthropic-agent-sdk.md §3 keeps the ledger.
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
 * window, so two live subprocesses do not both ask the token endpoint. The first caller is not
 * delayed and refreshes as part of whatever it came to do; the rest wait until the credential file
 * shows the new token, capped by {@link CredentialFreshnessDeps.maxWaitMs} and then let through
 * regardless. It sits *beside* the concurrency semaphore rather than inside it, because that gate
 * bounds memory and only the `query()` paths hold it; every spawn site takes freshness first and a
 * slot second — one fixed order, so the two cannot deadlock.
 *
 * **What it costs.** Outside the window — which is almost always — both calls are one ~500-byte
 * read of a file the page cache already holds. That read is deliberately not cached: a cache here
 * would have to be invalidated by the very event it cannot see (the CLI rewriting the file from
 * another process), and acting on a stale expiry is precisely the mistake this module exists to
 * prevent. It sits on the Agent-SDK path, which CLAUDE.md non-negotiable 8 names as the labelled
 * exception to the overhead budget, and it is followed by spawning a ~245 MB binary.
 *
 * **Fail open, always.** Every failure of `ensureFresh` — an unreadable file, a stalled winner, a
 * refresh that never lands — ends in the caller proceeding. An unreadable file makes `wouldRefresh`
 * answer `false`: a probe cannot rotate a token the CLI cannot read either.
 *
 * **Metadata, never the token** (CLAUDE.md non-negotiables 1 and 13). This module reads two instants
 * and a boolean through {@link CredentialMetadataReader}, whose return type has no field that could
 * hold a token. It does not refresh, forward, or write a credential — the Agent SDK still owns them
 * inside the Account's `CLAUDE_CONFIG_DIR`. All this does is decide who spawns, and who waits.
 */

/**
 * How far ahead of an access token's expiry the `claude` CLI refreshes it on its own.
 *
 * Provenance: CLI 2.1.261 (the binary bundled with Agent SDK 0.3.261), `qO(expiresAt)`:
 * `Date.now() + 300000 >= expiresAt`. Blast radius: if the CLI widens this, an idle query spawned
 * between the two leads would once again be ended mid-refresh — so the configured cold margin is
 * floored at this value at boot, and the floor is what to raise if the CLI moves.
 */
export const CLI_REFRESH_LEAD_MS = 300_000

export interface CredentialFreshness {
  /**
   * Resolves when it is this caller's turn to spawn against `accountId`. Returns immediately when
   * the Account's access token is not near expiry, which is the overwhelmingly common case.
   *
   * Never rejects for a credential reason — a caller that cannot be helped is let through. It
   * rejects only when `signal` aborts, carrying the signal's own reason so the caller classifies
   * the abort exactly as it classifies every other one.
   */
  ensureFresh(accountId: string, signal: AbortSignal): Promise<void>
  /**
   * Whether a `claude` subprocess spawned against `accountId` right now would refresh its access
   * token — and so must not be a turn-free one, which is ended before the rotated refresh token
   * is written. `true` inside {@link CredentialFreshnessDeps.coldMarginMs} of expiry, or past it.
   *
   * `false` for an Account with no tokens (nothing to rotate), an expiry the file never carried
   * (the CLI would not refresh on unknown either), or a file that cannot be read. Never throws.
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
  readonly logger?: Logger
}

/** What one Account's window looks like right now. `null` expiry is "unknown", never "fresh". */
type Freshness = "fresh" | "refreshing" | "no-credential"

export function createCredentialFreshness(deps: CredentialFreshnessDeps): CredentialFreshness {
  const sleep = deps.sleep ?? defaultSleep
  // The Account whose window is open and the caller that owns it. Absent means nobody is refreshing.
  const holders = new Map<string, { readonly since: number }>()

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

    ensureFresh: async (accountId, signal) => {
      throwIfAborted(signal)

      let state: Freshness
      try {
        state = await classify(accountId)
      } catch (error) {
        // Unknown, not blocked. The message names a path or an errno at most, and goes through the
        // redactor like every other field.
        deps.logger?.warn("claude credential freshness unreadable", {
          accountId,
          reason: error instanceof Error ? error.message : String(error),
        })
        return
      }

      if (state !== "refreshing") return

      const startedAt = deps.now().getTime()
      const holder = holders.get(accountId)
      // A holder older than the cap is not a holder: either the winner crashed, or — the ordinary
      // case — it refreshed successfully hours ago and no waiter ever came along to clear the entry.
      // Ownership therefore expires on the same clock a waiter gives up on, so a quiet Account never
      // arrives at its next window already believing someone is inside.
      if (holder === undefined || startedAt - holder.since >= deps.maxWaitMs) {
        // First across the line owns the refresh. It is not delayed at all: it goes on to spawn,
        // and the CLI refreshes inside that spawn exactly as it always has.
        const mine = { since: startedAt }
        holders.set(accountId, mine)
        deps.logger?.info("claude credential refresh window entered", { accountId })
        return
      }

      // Someone is already inside. Wait for the file to say the refresh landed — a stale holder is
      // bounded by the same cap, so a crashed winner cannot wedge the Account.
      for (;;) {
        await sleep(deps.pollMs, signal)
        throwIfAborted(signal)

        const waitedMs = deps.now().getTime() - startedAt
        let next: Freshness
        try {
          next = await classify(accountId)
        } catch {
          break
        }
        if (next !== "refreshing") {
          deps.logger?.info("claude credential refresh observed", { accountId, waitedMs })
          // Only ever retire the holder this caller actually queued behind; a newer window may have
          // opened while it waited, and clearing that one would let a second refresher straight in.
          if (holders.get(accountId) === holder) holders.delete(accountId)
          return
        }
        if (waitedMs >= deps.maxWaitMs) {
          // Fail open, loudly. Either the winner is wedged or the CLI did not refresh when we
          // expected it to; both are worth an operator's attention, neither is worth an outage.
          deps.logger?.warn("claude credential refresh did not land; proceeding anyway", {
            accountId,
            waitedMs,
          })
          if (holders.get(accountId) === holder) holders.delete(accountId)
          return
        }
      }
    },
  }
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal)
}

/** The signal's own reason, so a deadline stays a `TimeoutError` and a disconnect an `AbortError`. */
function abortReason(signal: AbortSignal): unknown {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error("the credential refresh wait was abandoned")
  error.name = "AbortError"
  return error
}

/** A freshness gate for a deployment that wires none: everything is fresh, nothing ever waits. */
export const ALWAYS_FRESH: CredentialFreshness = {
  ensureFresh: async () => {},
  wouldRefresh: async () => false,
}
