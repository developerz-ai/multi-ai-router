import { createHash } from "node:crypto"
import type { AdminAuthConfig } from "./config"

/**
 * Login attempt throttling, per username **and** per client IP
 * (docs/idea/04-api-keys-and-access.md#csrf-and-throttling). A single-admin surface whose
 * password comes from an env file is the highest-value target in the deployment, so an online
 * guessing attack has to be made expensive in wall-clock time, not just in CPU.
 *
 * Both keys are checked before the password is ever verified and both are charged on failure:
 * per-username stops a distributed attack from one identity, per-IP stops one host from
 * spraying. Counting happens on the *submitted* username whether or not it exists, so the
 * throttle can never be used as a username oracle.
 *
 * Pure over an injected clock and its own map — no timers, no I/O, no Hono. In-memory like the
 * session store, with the same caveat: a restart forgives every attacker mid-attack.
 */

export type ThrottleDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number }

export interface LoginThrottle {
  /** Denies while any of the keys is locked. Never mutates. */
  check(keys: readonly string[], nowMs: number): ThrottleDecision
  recordFailure(keys: readonly string[], nowMs: number): void
  /** A successful login clears the keys it was charged against. */
  reset(keys: readonly string[]): void
}

/** Hashed so a hostile 1 MB username cannot grow the map, and so it stays out of memory dumps. */
export function usernameThrottleKey(username: string): string {
  return `user:${createHash("sha256").update(username, "utf8").digest("base64url")}`
}

export function ipThrottleKey(ip: string): string {
  return `ip:${ip}`
}

interface Bucket {
  failures: number
  windowStartMs: number
  lockedUntilMs: number
}

/** Guards against unbounded growth under a spray from many addresses. */
const MAX_TRACKED_KEYS = 10_000

export function createLoginThrottle(config: AdminAuthConfig): LoginThrottle {
  const buckets = new Map<string, Bucket>()
  const windowMs = config.attemptWindowSeconds * 1000
  const lockoutMs = config.lockoutSeconds * 1000

  function evictStale(nowMs: number): void {
    for (const [key, bucket] of buckets) {
      if (expired(bucket, nowMs, windowMs)) buckets.delete(key)
    }
  }

  return {
    check(keys, nowMs) {
      let lockedUntilMs = 0
      for (const key of keys) {
        const bucket = buckets.get(key)
        if (bucket === undefined) continue
        if (bucket.lockedUntilMs > nowMs) {
          lockedUntilMs = Math.max(lockedUntilMs, bucket.lockedUntilMs)
        }
      }
      if (lockedUntilMs === 0) return { allowed: true }
      return { allowed: false, retryAfterSeconds: Math.ceil((lockedUntilMs - nowMs) / 1000) }
    },

    recordFailure(keys, nowMs) {
      if (buckets.size >= MAX_TRACKED_KEYS) evictStale(nowMs)
      for (const key of keys) {
        const existing = buckets.get(key)
        const bucket =
          existing === undefined || expired(existing, nowMs, windowMs)
            ? { failures: 0, windowStartMs: nowMs, lockedUntilMs: 0 }
            : existing
        bucket.failures += 1
        if (bucket.failures >= config.maxFailedAttempts) {
          bucket.lockedUntilMs = nowMs + lockoutMs
        }
        buckets.set(key, bucket)
      }
    },

    reset(keys) {
      for (const key of keys) buckets.delete(key)
    },
  }
}

/**
 * A bucket stops counting once its lockout has elapsed (the window is served, start clean) or
 * once the attempt window has passed with no lockout (old failures are not evidence).
 */
function expired(bucket: Bucket, nowMs: number, windowMs: number): boolean {
  if (bucket.lockedUntilMs > 0) return nowMs >= bucket.lockedUntilMs
  return nowMs - bucket.windowStartMs >= windowMs
}
