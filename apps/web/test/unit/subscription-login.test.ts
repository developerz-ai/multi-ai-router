import { describe, expect, test } from "bun:test"
import type { AccountView } from "../../src/lib/api/types"
import {
  describeLoginExpiry,
  LOGIN_DANGER_MS,
  LOGIN_WARN_MS,
  listNames,
  subscriptionBadge,
  subscriptionBannerTitle,
  summarizeSubscriptions,
} from "../../src/lib/subscription-login"

const NOW = Date.parse("2026-09-05T12:00:00.000Z")
const HOUR = 3_600_000

function sub(overrides: Partial<AccountView>): AccountView {
  return {
    id: "acc",
    label: "claude-max-1",
    provider: "anthropic-oauth",
    status: "active",
    hasCredential: false,
    configDir: "/data/claude/acc",
    baseUrl: null,
    dialect: "anthropic",
    modelAliases: null,
    supportedModels: null,
    windowTokenLimits: null,
    weight: 100,
    priority: 1,
    billing: "subscription",
    tokenExpiresAt: null,
    lastUsedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  }
}

function credential(expiresAt: string | null, present = true) {
  return { expiresAt, subscriptionType: "max", rateLimitTier: "default_claude_max_20x", present }
}

describe("describeLoginExpiry", () => {
  test("a login far out is neutral, with absolute instant and countdown", () => {
    const at = new Date(NOW + 20 * 24 * HOUR).toISOString()
    const display = describeLoginExpiry(sub({ credential: credential(at) }), NOW)
    expect(display.kind).toBe("valid")
    expect(display.tone).toBe("neutral")
    expect(display.expiresAtMs).toBe(Date.parse(at))
    expect(display.countdown).toBe("20d")
  })

  test("warns inside seven days and turns danger inside two", () => {
    const warn = new Date(NOW + LOGIN_WARN_MS - HOUR).toISOString()
    const danger = new Date(NOW + LOGIN_DANGER_MS - HOUR).toISOString()
    expect(describeLoginExpiry(sub({ credential: credential(warn) }), NOW).tone).toBe("warn")
    expect(describeLoginExpiry(sub({ credential: credential(danger) }), NOW).tone).toBe("danger")
  })

  test("an expired instant, absent tokens, or needs_reauth all read expired — never a countdown", () => {
    const past = new Date(NOW - HOUR).toISOString()
    const future = new Date(NOW + 10 * 24 * HOUR).toISOString()
    for (const account of [
      sub({ credential: credential(past) }),
      sub({ credential: credential(future, false) }),
      sub({ status: "needs_reauth", credential: credential(future) }),
      sub({ status: "needs_reauth" }),
    ]) {
      const display = describeLoginExpiry(account, NOW)
      expect(display.kind).toBe("expired")
      expect(display.tone).toBe("danger")
      expect(display.countdown).toBeNull()
      expect(display.text).toContain("reconnect")
    }
  })

  test("no credential on the wire (older API) or a null expiry is unknown, not expired", () => {
    expect(describeLoginExpiry(sub({}), NOW).kind).toBe("unknown")
    expect(describeLoginExpiry(sub({ credential: credential(null) }), NOW).kind).toBe("unknown")
    expect(describeLoginExpiry(sub({ credential: credential("not-a-date") }), NOW).kind).toBe(
      "unknown",
    )
  })
})

describe("subscriptionBadge", () => {
  test("plan and multiplier, in the operator's spelling", () => {
    expect(subscriptionBadge(credential(null))).toBe("Max 20×")
    expect(
      subscriptionBadge({
        expiresAt: null,
        subscriptionType: "pro",
        rateLimitTier: null,
        present: true,
      }),
    ).toBe("Pro")
    expect(
      subscriptionBadge({
        expiresAt: null,
        subscriptionType: "team",
        rateLimitTier: "default_claude_team_5x",
        present: true,
      }),
    ).toBe("Team 5×")
    expect(
      subscriptionBadge({
        expiresAt: null,
        subscriptionType: null,
        rateLimitTier: null,
        present: true,
      }),
    ).toBeNull()
    expect(subscriptionBadge(null)).toBeNull()
  })
})

describe("summarizeSubscriptions", () => {
  test("splits expired from expiring, skips disabled rows and other providers", () => {
    const soon = new Date(NOW + 3 * 24 * HOUR).toISOString()
    const later = new Date(NOW + 25 * 24 * HOUR).toISOString()
    const health = summarizeSubscriptions(
      [
        sub({ id: "dead", status: "needs_reauth" }),
        sub({ id: "soon", credential: credential(soon) }),
        sub({ id: "fine", credential: credential(later) }),
        sub({ id: "off", status: "disabled", credential: credential(soon) }),
        sub({ id: "api", provider: "zai", status: "needs_reauth" }),
      ],
      NOW,
    )
    expect(health.needsReconnect.map((a) => a.id)).toEqual(["dead"])
    expect(health.expiringSoon.map((a) => a.id)).toEqual(["soon"])
    expect(subscriptionBannerTitle(health)).toBe(
      "1 Claude subscription needs a reconnect · 1 more expires within 7 days",
    )
  })

  test("nothing to raise → no title", () => {
    expect(subscriptionBannerTitle({ needsReconnect: [], expiringSoon: [] })).toBeNull()
    expect(subscriptionBannerTitle({ needsReconnect: [], expiringSoon: [sub({}), sub({})] })).toBe(
      "2 Claude subscriptions expire within 7 days",
    )
  })
})

describe("listNames", () => {
  test("spells out up to three, then counts the rest", () => {
    expect(listNames(["a", "b", "c"])).toBe("a, b, c")
    expect(listNames(["a", "b", "c", "d", "e", "f"])).toBe("a, b, c and 3 more")
    expect(listNames([])).toBe("")
  })
})
