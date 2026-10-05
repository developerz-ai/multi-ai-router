import { describe, expect, test } from "bun:test"
import {
  computeLoginLifetime,
  type LoginLifetimeInput,
  loginLifetimePolicy,
} from "../../../src/services/accounts/login-lifetime"

/**
 * The login-lifetime arithmetic: pure, a fixed clock, hand-built metadata. Reported beats estimated,
 * an estimate needs a remembered login, and "renewal soon" is the warn window — never a blank file.
 */

const DAY_MS = 86_400_000
const NOW = new Date("2026-10-04T12:00:00.000Z")
const POLICY = loginLifetimePolicy({ assumedLifetimeDays: 28, renewalWarnDays: 5 })

function input(overrides: Partial<LoginLifetimeInput> = {}): LoginLifetimeInput {
  return {
    metadata: {
      refreshTokenExpiresAt: null,
      accessTokenExpiresAt: new Date("2026-10-04T18:00:00.000Z"),
      hasTokens: true,
    },
    lastLoginAt: null,
    now: NOW,
    policy: POLICY,
    ...overrides,
  }
}

describe("computeLoginLifetime", () => {
  test("the policy speaks milliseconds", () => {
    expect(POLICY).toEqual({ assumedLifetimeMs: 28 * DAY_MS, warnWindowMs: 5 * DAY_MS })
  })

  test("a reported refresh-token expiry is the deadline, labelled reported", () => {
    const reported = new Date(NOW.getTime() + 20 * DAY_MS + 3_600_000)
    const lifetime = computeLoginLifetime(
      input({
        metadata: { ...input().metadata, refreshTokenExpiresAt: reported },
        lastLoginAt: new Date(NOW.getTime() - 27 * DAY_MS),
      }),
    )
    expect(lifetime.renewsAt).toEqual(reported)
    expect(lifetime.source).toBe("reported")
    expect(lifetime.daysUntilRenewal).toBe(20)
    expect(lifetime.renewalRequiredSoon).toBe(false)
  })

  test("no reported expiry: last interactive login plus the assumed lifetime, labelled estimated", () => {
    // The prod account: logged in 2026-09-07, tokens blanked 2026-10-04 — 27 days.
    const loggedIn = new Date("2026-09-07T10:00:00.000Z")
    const lifetime = computeLoginLifetime(input({ lastLoginAt: loggedIn }))
    expect(lifetime.renewsAt).toEqual(new Date("2026-10-05T10:00:00.000Z"))
    expect(lifetime.source).toBe("estimated")
    expect(lifetime.daysUntilRenewal).toBe(0)
    expect(lifetime.renewalRequiredSoon).toBe(true)
    expect(lifetime.lastLoginAt).toEqual(loggedIn)
  })

  test("neither: unknown, with no days and no warning", () => {
    const lifetime = computeLoginLifetime(input())
    expect(lifetime).toMatchObject({
      renewsAt: null,
      source: "unknown",
      daysUntilRenewal: null,
      renewalRequiredSoon: false,
    })
  })

  test("the warn window is inclusive at its edge and false one millisecond outside", () => {
    const at = (ms: number) =>
      computeLoginLifetime(
        input({
          metadata: { ...input().metadata, refreshTokenExpiresAt: new Date(NOW.getTime() + ms) },
        }),
      ).renewalRequiredSoon
    expect(at(5 * DAY_MS)).toBe(true)
    expect(at(5 * DAY_MS + 1)).toBe(false)
  })

  test("past due floors to zero days and still warns while tokens are present", () => {
    const lifetime = computeLoginLifetime(
      input({
        metadata: { ...input().metadata, refreshTokenExpiresAt: new Date(NOW.getTime() - DAY_MS) },
      }),
    )
    expect(lifetime.daysUntilRenewal).toBe(0)
    expect(lifetime.renewalRequiredSoon).toBe(true)
  })

  test("a blanked login is the reconnect case, not 'renewal soon'", () => {
    const lifetime = computeLoginLifetime(
      input({
        metadata: {
          refreshTokenExpiresAt: new Date(NOW.getTime() + DAY_MS),
          accessTokenExpiresAt: null,
          hasTokens: false,
        },
      }),
    )
    expect(lifetime.renewalRequiredSoon).toBe(false)
    expect(lifetime.daysUntilRenewal).toBe(1)
  })

  test("the access token's expiry is passed through untouched", () => {
    const lifetime = computeLoginLifetime(input())
    expect(lifetime.accessTokenExpiresAt).toEqual(new Date("2026-10-04T18:00:00.000Z"))
  })
})
