/**
 * Per-key rate limiting — the ceiling stored on a router key, finally enforced
 * (docs/idea/04-api-keys-and-access.md#key-fields, docs/idea/07-security.md#threat-model).
 *
 * A stolen key's blast radius is "how much subscription quota can it burn before anyone notices",
 * and this is the bound on it. Which is why the check happens **before the request body is read**:
 * a refusal must cost less than the request it refuses, or the limiter becomes the amplifier.
 *
 * **Sliding window, exact.** One instant per *accepted* request, pruned as the window moves, so a
 * key configured at 60/minute gets 60 in any 60 seconds — never 120 across a boundary, which is
 * what a fixed-window counter would allow and what an operator setting a ceiling does not expect.
 * Memory is one number per accepted request inside the window, so the operator's own ceiling bounds
 * it, and refused requests are not recorded: a client hammering a spent window must not be able to
 * push its own reset further away.
 *
 * Pure over an injected clock and its own map — no timers, no I/O, nothing on the way to Postgres
 * (CLAUDE.md non-negotiable 8). In-memory, and therefore **per replica**: two replicas admit up to
 * twice the ceiling. Stated rather than hidden, because the alternative is a shared counter on the
 * request path, and that trade — a database round trip per request to make a ceiling exact — is the
 * one thing the performance budget forbids.
 */

/** What the limiter needs off the verified key. */
export interface RateLimitedKey {
  readonly id: string
  /** Null means no per-key ceiling: the limiter answers `allowed` without touching its map. */
  readonly rateLimitRequests: number | null
  readonly rateLimitWindowSeconds: number | null
}

export type RateLimitDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false
      /** Whole seconds until the oldest accepted request leaves the window. At least 1. */
      readonly retryAfterSeconds: number
      /** The same instant, absolute — what a log line and an error body can state plainly. */
      readonly resetsAt: Date
    }

export interface RateLimiter {
  /**
   * Charges one request against the key's window and answers whether it may proceed.
   *
   * Charging and checking are one call on purpose: two would leave a gap in which a concurrent
   * request sees the same headroom twice.
   */
  check(key: RateLimitedKey, nowMs: number): RateLimitDecision
  /** Drops a key's window. For revocation — a revoked key should not keep memory alive. */
  forget(keyId: string): void
  /** Keys currently tracked. Tests assert eviction with it; nothing on the request path reads it. */
  readonly size: number
}

export interface RateLimiterOptions {
  /**
   * Ceiling on tracked keys. Not an operator knob: it bounds memory against a spray of keys that
   * verify, and a deployment's key inventory is its own, not a caller's.
   */
  readonly maxKeys?: number
}

export const DEFAULT_RATE_LIMIT_MAX_KEYS = 4_096

/**
 * How much dead slack a window's instant list may carry before it is compacted. Pruning by moving
 * a head index is O(1); rebuilding the array on every request would be O(ceiling).
 */
const COMPACT_SLACK = 64

interface Window {
  /** The ceiling and window this list was collected under. A changed one starts fresh. */
  readonly limit: number
  readonly windowMs: number
  /** Accepted instants, ascending. Live entries start at `head`. */
  instants: number[]
  head: number
}

const ALLOWED: RateLimitDecision = { allowed: true }

export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const maxKeys = options.maxKeys ?? DEFAULT_RATE_LIMIT_MAX_KEYS
  const windows = new Map<string, Window>()

  /**
   * Forgets drained windows, then, if that freed nothing, the oldest tracked one. Eviction only
   * forgets history: the evicted key starts a fresh window, so the ceiling can be exceeded once
   * more than configured — which beats refusing traffic because a map is full.
   */
  const evict = (nowMs: number): void => {
    for (const [keyId, window] of windows) {
      if (drained(window, nowMs)) windows.delete(keyId)
    }
    if (windows.size < maxKeys) return
    const oldest = windows.keys().next()
    if (!oldest.done) windows.delete(oldest.value)
  }

  return {
    check(key, nowMs) {
      const limit = key.rateLimitRequests
      const windowSeconds = key.rateLimitWindowSeconds
      // Both halves or neither: a count with no window is not a rate limit, and a non-positive
      // ceiling is a misconfiguration the request path refuses to read as "deny everything".
      if (limit === null || windowSeconds === null || limit < 1 || windowSeconds < 1) return ALLOWED

      const windowMs = windowSeconds * 1_000
      let window = windows.get(key.id)
      if (window === undefined || window.limit !== limit || window.windowMs !== windowMs) {
        if (window === undefined && windows.size >= maxKeys) evict(nowMs)
        // An edited ceiling starts a fresh window rather than reinterpreting instants collected
        // under the old one: the operator raised or lowered a limit, they did not backdate it.
        window = { limit, windowMs, instants: [], head: 0 }
        windows.set(key.id, window)
      }

      prune(window, nowMs - windowMs)
      const oldest = window.instants[window.head]
      if (live(window) >= limit && oldest !== undefined) {
        const resetsAtMs = oldest + windowMs
        return {
          allowed: false,
          // Never 0: a client told to wait no time at all retries immediately and is refused again.
          retryAfterSeconds: Math.max(1, Math.ceil((resetsAtMs - nowMs) / 1_000)),
          resetsAt: new Date(resetsAtMs),
        }
      }

      window.instants.push(nowMs)
      return ALLOWED
    },

    forget(keyId) {
      windows.delete(keyId)
    },

    get size() {
      return windows.size
    },
  }
}

/** Drops the instants that have left the window, compacting only once the slack is worth it. */
function prune(window: Window, cutoffMs: number): void {
  const { instants } = window
  while (window.head < instants.length) {
    const at = instants[window.head]
    if (at === undefined || at > cutoffMs) break
    window.head += 1
  }
  if (window.head >= COMPACT_SLACK) {
    window.instants = instants.slice(window.head)
    window.head = 0
  }
}

function live(window: Window): number {
  return window.instants.length - window.head
}

/** No accepted request of this key is still inside its window — the entry says nothing anymore. */
function drained(window: Window, nowMs: number): boolean {
  const newest = window.instants[window.instants.length - 1]
  return newest === undefined || newest + window.windowMs <= nowMs
}
