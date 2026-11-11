import { expect, test } from "bun:test"
import { clientIp } from "../../../src/services/admin-auth/clientIp"
import { resolveAdminAuthConfig } from "../../../src/services/admin-auth/config"
import {
  createLoginThrottle,
  ipThrottleKey,
  ipv6Prefix64,
} from "../../../src/services/admin-auth/throttle"

test("a lockout reports its first refusal once, then again only after it re-arms", () => {
  const throttle = createLoginThrottle(
    resolveAdminAuthConfig({ maxFailedAttempts: 1, lockoutSeconds: 10 }),
  )
  throttle.recordFailure(["a"], 0)
  const denials = Array.from({ length: 1000 }, () => throttle.check(["a"], 1))
  expect(denials.filter((d) => !d.allowed && d.firstDenial)).toHaveLength(1)
  expect(denials.every((d) => !d.allowed)).toBe(true)

  // Lockout served; the next lockout is a new transition and is reported again.
  expect(throttle.check(["a"], 10_000).allowed).toBe(true)
  throttle.recordFailure(["a"], 10_000)
  const next = throttle.check(["a"], 10_001)
  expect(next.allowed === false && next.firstDenial).toBe(true)
})

test("a saturated table reports one refusal per lockout period, not one per address", () => {
  const throttle = createLoginThrottle(
    resolveAdminAuthConfig({ maxTrackedIps: 1, lockoutSeconds: 5, attemptWindowSeconds: 60 }),
  )
  throttle.recordFailure(["held"], 0)
  const denials = Array.from({ length: 50 }, (_, i) => throttle.check([`new-${i}`], 1))
  expect(denials.filter((d) => !d.allowed && d.firstDenial)).toHaveLength(1)
})

test("a full table is swept at most once per eviction interval", () => {
  const throttle = createLoginThrottle(
    resolveAdminAuthConfig({ maxTrackedIps: 1, attemptWindowSeconds: 1, maxFailedAttempts: 9 }),
    { evictionIntervalMs: 5_000 },
  )
  throttle.recordFailure(["old"], 0)
  // Swept at t=0 (nothing stale yet); the next sweep is not due until t=5000, so the stale bucket
  // still holds the only slot at t=2000.
  expect(throttle.check(["new"], 0).allowed).toBe(false)
  expect(throttle.check(["new"], 2_000).allowed).toBe(false)
  expect(throttle.check(["new"], 5_000).allowed).toBe(true)
})

test("IPv6 addresses share a bucket per /64; IPv4 and mapped IPv4 stay per address", () => {
  expect(ipv6Prefix64("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64")
  expect(ipv6Prefix64("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64")
  expect(ipv6Prefix64("2001:db8::1")).toBe("2001:db8:0:0::/64")
  expect(ipv6Prefix64("fe80::1%eth0")).toBe("fe80:0:0:0::/64")
  expect(ipv6Prefix64("::1")).toBe("0:0:0:0::/64")
  expect(ipv6Prefix64("::ffff:192.0.2.1")).toBeNull()
  expect(ipv6Prefix64("192.0.2.1")).toBeNull()
  expect(ipv6Prefix64("not:an:address::zz")).toBeNull()
  expect(ipv6Prefix64("1::2::3")).toBeNull()

  expect(ipThrottleKey("2001:db8:1:2::1")).toBe(ipThrottleKey("2001:db8:1:2:ffff::9"))
  expect(ipThrottleKey("2001:db8:1:2::1")).not.toBe(ipThrottleKey("2001:db8:1:3::1"))
  expect(ipThrottleKey("192.0.2.1")).not.toBe(ipThrottleKey("192.0.2.2"))
})

test("an IPv6 /64 spray lands in one bucket and locks out", () => {
  const throttle = createLoginThrottle(resolveAdminAuthConfig({ maxFailedAttempts: 3 }))
  for (let i = 1; i <= 3; i++) {
    const key = ipThrottleKey(`2001:db8:1:2::${i.toString(16)}`)
    expect(throttle.check([key], 0).allowed).toBe(true)
    throttle.recordFailure([key], 0)
  }
  expect(throttle.check([ipThrottleKey("2001:db8:1:2::ffff")], 0).allowed).toBe(false)
})

test("clientIp takes the entry our proxies appended, never the client-chosen leftmost", () => {
  expect(clientIp("evil, 203.0.113.9", "10.0.0.2", 1)).toBe("203.0.113.9")
  expect(clientIp("evil, 203.0.113.9, 10.0.0.5", "10.0.0.2", 2)).toBe("203.0.113.9")
  expect(clientIp(" 203.0.113.9 ", "10.0.0.2", 1)).toBe("203.0.113.9")
  // Fewer entries than hops: the header did not come through our chain.
  expect(clientIp("203.0.113.9", "10.0.0.2", 2)).toBe("10.0.0.2")
  expect(clientIp("", "10.0.0.2", 1)).toBe("10.0.0.2")
  // TRUST_PROXY off: the header is ignored outright.
  expect(clientIp("203.0.113.9", "10.0.0.2", 0)).toBe("10.0.0.2")
  expect(clientIp(undefined, undefined, 1)).toBe("unknown")
})
