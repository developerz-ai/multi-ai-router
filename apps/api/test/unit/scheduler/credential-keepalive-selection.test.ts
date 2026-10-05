import { describe, expect, test } from "bun:test"
import type { AccountRow } from "@multi-ai-router/db"
import { CLI_REFRESH_LEAD_MS } from "../../../src/providers/claude-sdk/credential-freshness"
import type { CredentialMetadata } from "../../../src/providers/claude-sdk/credential-metadata"
import {
  describeRotation,
  type KeepaliveAttempt,
  type KeepaliveCandidate,
  keepaliveVerdict,
  selectKeepaliveTargets,
} from "../../../src/scheduler/tasks/credential-keepalive-selection"
import { accountRow } from "../../support/account-row"

/**
 * Which subscriptions get a keepalive turn — pure, against a fixed clock. The money rule: a turn is
 * spent only when the CLI would refresh *now* (inside its own lead, or past expiry), never on a
 * token it would leave alone, never on an account a human has to fix, and not again every tick when
 * the last turn did not move the expiry.
 */

const NOW_MS = Date.parse("2026-10-04T12:00:00.000Z")
const MIN = 60_000
const POLICY = { leadMs: CLI_REFRESH_LEAD_MS, retryMs: 60 * MIN, batchSize: 2 }

function candidate(
  id: string,
  expiresInMs: number | null,
  overrides: { account?: Partial<AccountRow>; metadata?: Partial<CredentialMetadata> } = {},
): KeepaliveCandidate {
  return {
    account: accountRow({
      id,
      provider: "anthropic-oauth",
      status: "active",
      ...overrides.account,
    }),
    metadata: {
      accessTokenExpiresAt: expiresInMs === null ? null : new Date(NOW_MS + expiresInMs),
      refreshTokenExpiresAt: null,
      subscriptionType: "max",
      rateLimitTier: null,
      hasTokens: true,
      ...overrides.metadata,
    },
  }
}

const verdict = (c: KeepaliveCandidate, attempt?: KeepaliveAttempt) =>
  keepaliveVerdict(c, NOW_MS, POLICY, attempt)

describe("keepaliveVerdict", () => {
  test("inside the CLI's five-minute lead is due", () => {
    expect(verdict(candidate("a", 4 * MIN))).toBe("due")
    expect(verdict(candidate("a", CLI_REFRESH_LEAD_MS))).toBe("due")
  })

  test("already expired is due — the CLI refreshes on its next start", () => {
    expect(verdict(candidate("a", -3 * 60 * MIN))).toBe("due")
  })

  test("outside the lead is fresh: a turn now would refresh nothing", () => {
    expect(verdict(candidate("a", CLI_REFRESH_LEAD_MS + 1))).toBe("fresh")
    expect(verdict(candidate("a", 8 * 60 * MIN))).toBe("fresh")
  })

  test("needs_reauth, disabled, cooling and exhausted accounts are never due", () => {
    for (const status of ["needs_reauth", "disabled", "cooling_down", "exhausted"] as const) {
      expect(verdict(candidate("a", MIN, { account: { status } }))).toBe("not-active")
    }
  })

  test("a blanked credential has nothing to refresh", () => {
    expect(verdict(candidate("a", MIN, { metadata: { hasTokens: false } }))).toBe("no-credential")
  })

  test("an expiry the file never carried is unknown, never cold", () => {
    expect(verdict(candidate("a", null))).toBe("unknown-expiry")
  })

  test("a turn against the same expiry inside the retry window backs off", () => {
    const c = candidate("a", -MIN)
    const expiresAtMs = NOW_MS - MIN
    expect(verdict(c, { atMs: NOW_MS - 10 * MIN, accessTokenExpiresAtMs: expiresAtMs })).toBe(
      "backing-off",
    )
    expect(verdict(c, { atMs: NOW_MS - 60 * MIN, accessTokenExpiresAtMs: expiresAtMs })).toBe("due")
  })

  test("a new expiry clears the backoff — a refresh landed somewhere", () => {
    const c = candidate("a", 2 * MIN)
    expect(verdict(c, { atMs: NOW_MS - MIN, accessTokenExpiresAtMs: NOW_MS - 8 * 60 * MIN })).toBe(
      "due",
    )
  })
})

describe("selectKeepaliveTargets", () => {
  test("soonest expiry first, bounded by the batch, the rest deferred", () => {
    const selection = selectKeepaliveTargets(
      [
        candidate("late", 4 * MIN),
        candidate("fresh", 3 * 60 * MIN),
        candidate("expired", -MIN),
        candidate("mid", 2 * MIN),
      ],
      NOW_MS,
      POLICY,
      new Map(),
    )
    expect(selection.due.map((c) => c.account.id)).toEqual(["expired", "mid"])
    expect(selection.deferred).toBe(1)
    expect(selection.backingOff).toBe(0)
  })

  test("backed-off accounts are counted, not selected", () => {
    const selection = selectKeepaliveTargets(
      [candidate("a", -MIN)],
      NOW_MS,
      POLICY,
      new Map([["a", { atMs: NOW_MS - MIN, accessTokenExpiresAtMs: NOW_MS - MIN }]]),
    )
    expect(selection.due).toEqual([])
    expect(selection.backingOff).toBe(1)
  })
})

describe("describeRotation", () => {
  const before = {
    accessTokenExpiresAt: new Date("2026-10-04T12:03:00.000Z"),
    refreshTokenExpiresAt: new Date("2026-10-30T00:00:00.000Z"),
  }

  test("a later access-token expiry is a refresh; an unchanged login deadline says so", () => {
    const report = describeRotation(before, {
      accessTokenExpiresAt: new Date("2026-10-04T20:03:00.000Z"),
      refreshTokenExpiresAt: new Date("2026-10-30T00:00:00.000Z"),
    })
    expect(report).toEqual({
      refreshed: true,
      accessExpiresAtBefore: "2026-10-04T12:03:00.000Z",
      accessExpiresAtAfter: "2026-10-04T20:03:00.000Z",
      loginExpiresAtBefore: "2026-10-30T00:00:00.000Z",
      loginExpiresAtAfter: "2026-10-30T00:00:00.000Z",
      loginExpiryMoved: false,
    })
  })

  test("a moved login deadline is reported as moved", () => {
    const report = describeRotation(before, {
      accessTokenExpiresAt: new Date("2026-10-04T20:03:00.000Z"),
      refreshTokenExpiresAt: new Date("2026-11-01T00:00:00.000Z"),
    })
    expect(report.loginExpiryMoved).toBe(true)
  })

  test("an unchanged access expiry is no refresh; a missing deadline is unknown, not 'no'", () => {
    const report = describeRotation(
      { ...before, refreshTokenExpiresAt: null },
      { ...before, refreshTokenExpiresAt: null },
    )
    expect(report.refreshed).toBe(false)
    expect(report.loginExpiryMoved).toBeNull()
  })
})
