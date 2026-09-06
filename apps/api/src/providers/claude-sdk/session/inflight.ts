/**
 * **One conversation, one turn at a time.** Which turn currently owns a session key, so a second
 * one arriving while it runs is served *detached* instead of colliding with it
 * (docs/idea/11-anthropic-agent-sdk.md §4).
 *
 * The collision is not hypothetical and not rare. Coding-agent clients fire hidden one-shot
 * requests — a conversation title, a summary — carrying the **same** session header as the visible
 * turn, often in parallel with it. opencode does exactly this. Both requests then resolve to the
 * same SDK session, the second asks the CLI to resume a session the first is still running, and the
 * CLI refuses: `Session <id> is running as a background session`. Before this module that refusal
 * arrived as an `exit 1` on stderr, classified as a subprocess crash, answered `502`, and failed
 * over — restarting the user's conversation on a cold account mid-turn (production, 2026-09-06).
 *
 * **Detaching is the fix, and the busy-session fork is not.** Forking would answer the one-shot,
 * but the fork's new session id is what the turn then records against the conversation's key — so
 * a throwaway "write me a title" request would take ownership of the user's durable lineage and the
 * next real turn would resume from it. A hidden one-shot is not the conversation and must not
 * advance it. So a detached turn does two things and no more: it runs on a **fresh** SDK session,
 * and it **remembers nothing**.
 *
 * What it costs is exactly one cold prompt cache on a request the user never sees, which is the
 * cheapest thing in this whole design to spend.
 *
 * Three properties worth stating because each one is a decision:
 *
 * - **Concurrency, not rate limiting.** A claim lives for one turn and is released the moment the
 *   subprocess is finished with. Sequential turns of a conversation — the normal case — never meet
 *   each other here and resume exactly as they always did.
 * - **Never a process singleton.** Per-runtime and per session key, like the quota store and the
 *   health store. A module-level map would let one runtime's turns detach another's inside a single
 *   process, and every test would start dirty.
 * - **Per replica, and that is honest rather than complete.** Two replicas cannot see each other's
 *   claims. This deployment runs one by design (its admin sessions and per-key limits are already
 *   per-process), and the CLI's own refusal — `claude-sdk:session-busy`, recovered as an in-place
 *   fork — remains the backstop for a collision this map cannot see.
 */

/** A held claim on one session key. Releasing twice is a no-op; releasing is never optional. */
export interface SessionClaim {
  /** False when another turn already owns the key — this turn must detach. */
  readonly held: boolean
  release(): void
}

export interface SessionClaims {
  /**
   * Take the key for one turn.
   *
   * @returns a claim whose `held` says whether it was granted. A refused claim still returns a
   * releasable value, so every caller can release unconditionally rather than branch on it.
   */
  acquire(key: string): SessionClaim
  /** How many keys are currently claimed. For tests and, one day, a gauge. */
  readonly size: number
}

const REFUSED: SessionClaim = { held: false, release: () => {} }

export function createSessionClaims(): SessionClaims {
  const claimed = new Set<string>()

  return {
    acquire(key) {
      if (claimed.has(key)) return REFUSED
      claimed.add(key)
      let released = false
      return {
        held: true,
        release: () => {
          // Idempotent because it is called from two places that cannot coordinate: the turn's own
          // end inside the invoker, and the attempt's failure path. A second release must not free
          // a key some *later* turn has since claimed.
          if (released) return
          released = true
          claimed.delete(key)
        },
      }
    },
    get size() {
      return claimed.size
    },
  }
}
