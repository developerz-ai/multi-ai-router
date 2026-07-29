import { createHash } from "node:crypto"
import type { AdminAuthConfig } from "./config"

/**
 * Login attempt throttling, per client IP only. The admin plane is a single
 * identity, gated by an OIDC assertion, so there is no username to count
 * against. The IP throttle is what stops an online guessing attack from
 * cycling through states and codes at the rate the network allows.
 *
 * Counting happens on the *presented* IP, hashed so a hostile 1 KB-`X-Forwarded-For`
 * cannot grow the map, and bounded so a spray from many addresses cannot
 * grow it unboundedly either.
 *
 * Pure over an injected clock and its own map — no timers, no I/O, no Hono.
 * In-memory like the session store, with the same caveat: a restart forgives
 * every attacker mid-attack.
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

/** Hashed so a hostile 1 KB `X-Forwarded-For` cannot grow the map. */
export function ipThrottleKey(ip: string): string {
  return `ip:${createHash("sha256").update(ip, "utf8").digest("base64url")}`
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
