import { describe, expect, test } from "bun:test"
import { resolveAdminAuthConfig } from "../../../src/services/admin-auth/config"
import {
  createLoginThrottle,
  ipThrottleKey,
  usernameThrottleKey,
} from "../../../src/services/admin-auth/throttle"

/** Pure over an injected clock: a fifteen-minute lockout is tested in microseconds. */

const config = resolveAdminAuthConfig({
  maxFailedAttempts: 3,
  attemptWindowSeconds: 60,
  lockoutSeconds: 120,
})

const user = usernameThrottleKey("admin")
const ip = ipThrottleKey("203.0.113.7")

describe("createLoginThrottle", () => {
  test("allows until the attempt limit, then locks with a Retry-After", () => {
    const throttle = createLoginThrottle(config)

    for (let attempt = 1; attempt < config.maxFailedAttempts; attempt += 1) {
      throttle.recordFailure([user, ip], 0)
      expect(throttle.check([user, ip], 0)).toEqual({ allowed: true })
    }

    throttle.recordFailure([user, ip], 0)
    expect(throttle.check([user, ip], 0)).toEqual({ allowed: false, retryAfterSeconds: 120 })
  })

  test("releases when the lockout window elapses", () => {
    const throttle = createLoginThrottle(config)
    for (let attempt = 0; attempt < config.maxFailedAttempts; attempt += 1) {
      throttle.recordFailure([user, ip], 0)
    }

    expect(throttle.check([user, ip], 119_999).allowed).toBe(false)
    expect(throttle.check([user, ip], 120_000)).toEqual({ allowed: true })
  })

  test("counts down the remaining lockout rather than the whole window", () => {
    const throttle = createLoginThrottle(config)
    for (let attempt = 0; attempt < config.maxFailedAttempts; attempt += 1) {
      throttle.recordFailure([user, ip], 1_000)
    }

    expect(throttle.check([user, ip], 61_000)).toEqual({ allowed: false, retryAfterSeconds: 60 })
  })

  test("forgets failures older than the attempt window", () => {
    const throttle = createLoginThrottle(config)
    throttle.recordFailure([user], 0)
    throttle.recordFailure([user], 10_000)

    // The window has rolled over, so this is failure #1 again, not #3.
    throttle.recordFailure([user], 70_000)
    throttle.recordFailure([user], 70_000)
    expect(throttle.check([user], 70_000)).toEqual({ allowed: true })
  })

  test("locks per key — one IP's spree does not lock a different IP", () => {
    const throttle = createLoginThrottle(config)
    const otherIp = ipThrottleKey("198.51.100.4")

    for (let attempt = 0; attempt < config.maxFailedAttempts; attempt += 1) {
      throttle.recordFailure([ip], 0)
    }

    expect(throttle.check([ip], 0).allowed).toBe(false)
    expect(throttle.check([otherIp], 0).allowed).toBe(true)
  })

  test("a locked username locks every IP that presents it, and vice versa", () => {
    const throttle = createLoginThrottle(config)
    // Three different addresses, one username: distributed guessing still trips the user key.
    for (const address of ["10.0.0.1", "10.0.0.2", "10.0.0.3"]) {
      throttle.recordFailure([user, ipThrottleKey(address)], 0)
    }

    expect(throttle.check([user, ipThrottleKey("10.0.0.9")], 0).allowed).toBe(false)
  })

  test("a successful login clears the keys it was charged against", () => {
    const throttle = createLoginThrottle(config)
    for (let attempt = 0; attempt < config.maxFailedAttempts; attempt += 1) {
      throttle.recordFailure([user, ip], 0)
    }

    throttle.reset([user, ip])
    expect(throttle.check([user, ip], 0)).toEqual({ allowed: true })
  })

  test("hashes the username into the key, so the map cannot be grown or read", () => {
    const key = usernameThrottleKey("admin")

    expect(key).not.toContain("admin")
    expect(key).toBe(usernameThrottleKey("admin"))
    expect(key).not.toBe(usernameThrottleKey("Admin"))
    expect(usernameThrottleKey("x".repeat(100_000)).length).toBeLessThan(64)
  })
})
