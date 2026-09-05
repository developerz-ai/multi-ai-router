/**
 * The message an empty candidate set produces — every rejected member accounted for, by what fixes
 * it (docs/idea/05-routing-and-failover.md#when-every-candidate-is-unavailable).
 *
 * Pure: a rejection list in, an error out. No snapshot, no clock beyond the injected `now`.
 */

import { describe, expect, test } from "bun:test"
import {
  CreditsExhaustedError,
  NoHealthyAccountError,
  QuotaExhaustedError,
} from "@multi-ai-router/core"
import type { RejectedCandidate } from "../../../src/services/routing"
import { noCandidatesError } from "../../../src/services/routing"
import { at, NOW } from "./fixtures"

function rejected(
  label: string,
  reason: RejectedCandidate["reason"],
  extra: Partial<RejectedCandidate> = {},
): RejectedCandidate {
  return { accountId: `id-${label}`, label, reason, ...extra }
}

function error(entries: readonly RejectedCandidate[]) {
  return noCandidatesError({
    scope: {
      scope: { kind: "pools", poolIds: ["cn"] },
      inScopeAccountIds: entries.map((entry) => entry.accountId),
      unresolvedTargetIds: [],
    },
    groups: [
      {
        poolId: "cn",
        poolName: "cn-models-team",
        policy: "priority-failover",
        ordered: [],
        notes: [],
      },
    ],
    rejected: entries,
    binding: { state: "none" },
    now: NOW,
  })
}

describe("the count in the message equals the rejections it accounts for (#88)", () => {
  test("two spent windows and one needs-reauth: the third is named, not implied healthy", () => {
    // The production message this pins: "2 of 3 accounts ... are rate limited or out of quota
    // (zai, minimax)" with kimi silently `needs_reauth` — read as though one account were fine.
    const result = error([
      rejected("zai", "quota-window-spent", { resetsAt: at(60_000), resetSource: "estimated" }),
      rejected("minimax", "quota-window-spent", { resetsAt: at(30_000), resetSource: "estimated" }),
      rejected("kimi", "needs-reauth"),
    ])

    expect(result).toBeInstanceOf(QuotaExhaustedError)
    expect(result.status).toBe(429)
    expect(result.message).toContain("2 of 3 accounts in pool cn-models-team")
    expect(result.message).toContain("rate limited or out of quota (zai, minimax)")
    expect(result.message).toContain("1 more needs a human (kimi needs re-auth)")
    expect(result.message).toContain(`earliest reset ${at(30_000).toISOString()} (estimated)`)
  })

  test("the all-recoverable case renders exactly as before", () => {
    const result = error([
      rejected("a", "cooling-down", { resetsAt: at(10_000) }),
      rejected("b", "cooling-down", { resetsAt: at(20_000) }),
    ])

    expect(result.message).toBe(
      `2 of 2 accounts in pool cn-models-team are rate limited or out of quota (a, b), earliest reset ${at(10_000).toISOString()}`,
    )
  })

  test("recoverable, exhausted, disabled, and model-unsupported each get their own clause", () => {
    const result = error([
      rejected("a", "cooling-down", { resetsAt: at(10_000) }),
      rejected("b", "exhausted"),
      rejected("c", "disabled"),
      rejected("d", "model-unsupported"),
    ])

    expect(result.status).toBe(429)
    expect(result.message).toContain("1 of 4 accounts")
    expect(result.message).toContain("1 more account out of credits and needs a top-up (b)")
    expect(result.message).toContain("1 more needs a human (c disabled)")
    expect(result.message).toContain("1 more does not serve this model — a client change (d)")
  })

  test("exhausted plus disabled is a 402 that still names the disabled one", () => {
    const result = error([
      rejected("a", "exhausted"),
      rejected("b", "exhausted"),
      rejected("c", "disabled"),
    ])

    expect(result).toBeInstanceOf(CreditsExhaustedError)
    expect(result.message).toContain("2 of 3 accounts in pool cn-models-team are out of credits")
    expect(result.message).toContain("(a, b)")
    expect(result.message).toContain("1 more needs a human (c disabled)")
  })

  test("everything exhausted still says `all`", () => {
    const result = error([rejected("a", "exhausted"), rejected("b", "exhausted")])

    expect(result.message).toContain("all 2 accounts in pool cn-models-team are out of credits")
  })

  test("nothing recoverable and nothing exhausted is the 503 that lists every reason", () => {
    const result = error([rejected("a", "disabled"), rejected("b", "needs-reauth")])

    expect(result).toBeInstanceOf(NoHealthyAccountError)
    expect(result.message).toBe(
      "no eligible account in pool cn-models-team: a disabled, b needs re-auth",
    )
  })

  test("which class wins is unchanged: recoverable over exhausted over the rest", () => {
    expect(error([rejected("a", "disabled"), rejected("b", "exhausted")]).status).toBe(402)
    expect(
      error([rejected("a", "exhausted"), rejected("b", "probe-in-flight", { resetsAt: at(500) })])
        .status,
    ).toBe(429)
  })
})
