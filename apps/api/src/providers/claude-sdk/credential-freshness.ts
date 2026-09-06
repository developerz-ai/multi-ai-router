import type { Logger } from "../../logging/logger"
import type { AccountConfigDirs } from "./config-dir"
import type { CredentialMetadataReader } from "./credential-metadata"

/**
 * Lets exactly one `claude` subprocess cross an Account's token-refresh moment.
 *
 * **The incident this exists for.** Anthropic's OAuth refresh token *rotates*: a successful refresh
 * consumes the old value and returns a new one. The access token lives ~8 h, so every Account has a
 * refresh instant roughly three times a day. When two subprocesses share one `CLAUDE_CONFIG_DIR`
 * across that instant they both read the same stored refresh token and both spend it; the server
 * honours the first and rejects the second, and the losing CLI reads that rejection as a dead login
 * and **blanks `.credentials.json`** — destroying the winner's freshly rotated credential along with
 * it. On 2026-09-06 that took out three of six production Accounts within nine hours. Every one of
 * them still had `refreshTokenExpiresAt` a month in the future: the login was alive, the token
 * string was merely spent. Recovery is an interactive re-login; nothing the router does can undo it.
 *
 * `concurrency.ts` had recorded the opposite as an accepted risk — that a lost race "fails one
 * request into the ordinary auth classification rather than corrupting the file" — and named the
 * mitigation to apply if evidence ever arrived. This is that mitigation, and the evidence is in
 * docs/idea/11-anthropic-agent-sdk.md §3.
 *
 * **Why it is not part of the concurrency gate.** `SdkConcurrency` bounds *memory* and only the
 * paths that spawn through `query()` hold it; `claude auth status` (`login/status.ts`) and the login
 * CLI (`login/spawn.ts`) spawn against the same directory with a raw `Bun.spawn` and take no slot at
 * all. A guard living inside the gate would miss the daily probe that walks every Account. So this
 * is its own primitive, taken *before* the gate by everything that spawns — one fixed order, so the
 * two never deadlock against each other.
 *
 * **What it costs.** Outside the refresh window — which is almost always — `ensureFresh` is one
 * ~500-byte read of a file the page cache already holds, and then it returns: no wait, no
 * subprocess. That read is deliberately not cached. A cache here would have to be invalidated by
 * the very event it cannot see (the CLI rewriting the file from another process), and acting on a
 * stale expiry is precisely the mistake this module exists to prevent — so the read is repeated
 * rather than remembered. It sits on the Agent-SDK path, which CLAUDE.md non-negotiable 8 names as
 * the labelled exception to the overhead budget, and it is followed immediately by spawning a
 * ~245 MB binary that takes three orders of magnitude longer.
 *
 * Inside the window, the first caller is let straight through and does the refresh
 * as part of whatever it came to do; everyone else for that Account waits until the credential file
 * says the refresh landed. No extra process is ever spawned to force one, and the caller that pays
 * the latency is the one that was going to pay it anyway.
 *
 * **Fail open, always.** Every failure — an unreadable file, a stalled winner, a refresh that never
 * lands — ends in the caller proceeding after {@link CredentialFreshnessDeps.maxWaitMs}. A narrower
 * race is the goal; an Account wedged behind this gate would be a worse outage than the one it
 * prevents.
 *
 * **Metadata, never the token** (CLAUDE.md non-negotiables 1 and 13). This module reads two instants
 * and a boolean through {@link CredentialMetadataReader}, whose return type has no field that could
 * hold a token. It does not refresh, forward, or write a credential — the Agent SDK still owns them
 * inside the Account's `CLAUDE_CONFIG_DIR`. All this does is decide who waits.
 */

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
}
