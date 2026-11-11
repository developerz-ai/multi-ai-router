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
  | {
      readonly allowed: false
      readonly retryAfterSeconds: number
      /**
       * True on the first refusal of a lockout (or of a saturated table) and false on every repeat
       * until it clears. The caller audits only this one: a denied request is unauthenticated, and
       * one audit row per denial is an unbounded write an attacker controls.
       */
      readonly firstDenial: boolean
    }

export interface LoginThrottleOptions {
  /**
   * The full-table sweep runs at most once per this many milliseconds. Without the bound a
   * saturated table cost an O(n) scan on every request — 10 000 buckets per unauthenticated hit.
   */
  readonly evictionIntervalMs?: number
}

const DEFAULT_EVICTION_INTERVAL_MS = 1_000

export interface LoginThrottle {
  /** Denies locked keys and new keys beyond capacity; evicts expired buckets. */
  check(keys: readonly string[], nowMs: number): ThrottleDecision
  recordFailure(keys: readonly string[], nowMs: number): void
  /** A successful login clears the keys it was charged against. */
  reset(keys: readonly string[]): void
}

/**
 * Hashed so a hostile 1 KB `X-Forwarded-For` cannot grow the map. An IPv6 address counts by its
 * /64: a single subscriber is routinely handed a whole /64, so per-/128 buckets would give one
 * attacker 2^64 fresh ones.
 */
export function ipThrottleKey(ip: string): string {
  const subject = ipv6Prefix64(ip) ?? ip
  return `ip:${createHash("sha256").update(subject, "utf8").digest("base64url")}`
}

/**
 * The first four hextets of an IPv6 address, normalized, or null for anything else. An
 * IPv4-mapped address (`::ffff:192.0.2.1`) is the IPv4 client and stays per-address.
 */
export function ipv6Prefix64(ip: string): string | null {
  const address = (ip.split("%", 1)[0] ?? "").toLowerCase()
  if (!address.includes(":")) return null
  if (/^(::ffff:)\d+\.\d+\.\d+\.\d+$/u.test(address)) return null
  // An embedded dotted quad fills the last 32 bits, which a /64 never reaches.
  const hexOnly = address.replace(/:\d+\.\d+\.\d+\.\d+$/u, ":0:0")
  const halves = hexOnly.split("::")
  if (halves.length > 2) return null
  const head = halves[0] === "" || halves[0] === undefined ? [] : halves[0].split(":")
  const tail = halves.length === 2 && halves[1] !== "" ? (halves[1]?.split(":") ?? []) : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail]
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/u.test(group))) return null
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/u, ""))
    .join(":")}::/64`
}

interface Bucket {
  failures: number
  windowStartMs: number
  lockedUntilMs: number
  /** Whether this lockout's first refusal has been reported. Cleared with the bucket. */
  denialReported: boolean
}

export function createLoginThrottle(
  config: AdminAuthConfig,
  options: LoginThrottleOptions = {},
): LoginThrottle {
  const buckets = new Map<string, Bucket>()
  const windowMs = config.attemptWindowSeconds * 1000
  const lockoutMs = config.lockoutSeconds * 1000
  const evictionIntervalMs = options.evictionIntervalMs ?? DEFAULT_EVICTION_INTERVAL_MS
  let lastEvictionMs = Number.NEGATIVE_INFINITY
  // A saturated table refuses every new address with no bucket to remember the report on.
  let saturationReportedUntilMs = Number.NEGATIVE_INFINITY

  function evictStale(nowMs: number): void {
    if (nowMs - lastEvictionMs < evictionIntervalMs) return
    lastEvictionMs = nowMs
    for (const [key, bucket] of buckets) {
      if (expired(bucket, nowMs, windowMs)) buckets.delete(key)
    }
  }

  return {
    check(keys, nowMs) {
      if (buckets.size >= config.maxTrackedIps) {
        evictStale(nowMs)
        if (keys.some((key) => !buckets.has(key)) && buckets.size >= config.maxTrackedIps) {
          // Retain even unlocked attempts until expiry: evicting them lets an address spray
          // erase its own failures repeatedly before reaching the lockout threshold.
          const retryAfterSeconds = Math.max(1, config.lockoutSeconds)
          const firstDenial = nowMs >= saturationReportedUntilMs
          if (firstDenial) saturationReportedUntilMs = nowMs + retryAfterSeconds * 1000
          return { allowed: false, retryAfterSeconds, firstDenial }
        }
      }
      let lockedUntilMs = 0
      let firstDenial = false
      for (const key of keys) {
        const bucket = buckets.get(key)
        if (bucket === undefined) continue
        if (bucket.lockedUntilMs > nowMs) {
          lockedUntilMs = Math.max(lockedUntilMs, bucket.lockedUntilMs)
          if (!bucket.denialReported) firstDenial = true
          bucket.denialReported = true
        }
      }
      if (lockedUntilMs === 0) return { allowed: true }
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((lockedUntilMs - nowMs) / 1000),
        firstDenial,
      }
    },

    recordFailure(keys, nowMs) {
      if (buckets.size >= config.maxTrackedIps) evictStale(nowMs)
      for (const key of keys) {
        const existing = buckets.get(key)
        const bucket =
          existing === undefined || expired(existing, nowMs, windowMs)
            ? { failures: 0, windowStartMs: nowMs, lockedUntilMs: 0, denialReported: false }
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
