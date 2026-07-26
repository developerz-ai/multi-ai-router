import { describe, expect, test } from "bun:test"
import {
  CreditsExhaustedError,
  NoHealthyAccountError,
  QuotaExhaustedError,
  TranslationError,
} from "@multi-ai-router/core"
import type { CandidatePlan } from "../../../src/services/dataplane"
import { unservableError } from "../../../src/services/dataplane"
import type {
  FilterReason,
  RejectedCandidate,
  SelectionDecision,
} from "../../../src/services/routing"

/**
 * Which of two answers a request gets when routing found candidates and **none could be planned**.
 *
 * Selection drops an account for its health; planning drops one for its shape. Neither sees the
 * other, so the wrong precedence tells a client that an operation is impossible when the truth is
 * that the one account which could perform it is cooling down for ninety seconds — a `503` where
 * non-negotiable 7 requires a `429` and a `Retry-After`.
 */

const NOW = new Date("2026-07-26T12:00:00.000Z")
const RESET = new Date("2026-07-26T12:01:30.000Z")

function reject(accountId: string, reason: FilterReason, resetsAt?: Date): RejectedCandidate {
  return { accountId, label: accountId, reason, ...(resetsAt === undefined ? {} : { resetsAt }) }
}

function decision(rejected: readonly RejectedCandidate[]): SelectionDecision {
  return {
    scope: {
      scope: { kind: "all" },
      inScopeAccountIds: ["anthropic", "openai"],
      unresolvedTargetIds: [],
    },
    groups: [],
    rejected,
    binding: { state: "none" },
    usedOverflow: false,
  }
}

/** What `planCandidates` returns when every candidate was dropped by the operation gate. */
const CANNOT_COUNT: CandidatePlan = {
  servable: [],
  rejection: {
    mode: "rejected",
    reason: "unsupported-operation",
    message: "this account cannot count tokens: it speaks openai-chat",
  },
  endpointError: null,
}

/** Only the Anthropic account could ever have counted; the OpenAI one never could. */
const capable = (accountId: string): boolean => accountId === "anthropic"

describe("a capable account held back by its health", () => {
  test("answers 429 with a Retry-After, not the operation gap, when it is cooling down", () => {
    const error = unservableError({
      plan: CANNOT_COUNT,
      decision: decision([reject("anthropic", "cooling-down", RESET)]),
      capable,
      now: NOW,
    })

    expect(error).toBeInstanceOf(QuotaExhaustedError)
    expect(error.status).toBe(429)
    expect(error.retryAfterSeconds).toBe(90)
    expect(error.message).toContain("anthropic")
  })

  test("names 402 when it is out of credits, because that one needs a human and not a timer", () => {
    const error = unservableError({
      plan: CANNOT_COUNT,
      decision: decision([reject("anthropic", "exhausted")]),
      capable,
      now: NOW,
    })

    expect(error).toBeInstanceOf(CreditsExhaustedError)
    expect(error.status).toBe(402)
  })

  test("still reports a Retry-After when the account is cooling with no recorded reset", () => {
    const error = unservableError({
      plan: CANNOT_COUNT,
      decision: decision([reject("anthropic", "cooling-down")]),
      capable,
      now: NOW,
    })

    expect(error.status).toBe(429)
    expect(error.retryAfterSeconds).toBeGreaterThan(0)
  })

  test("counts only the accounts that could have served it, never the whole rejected set", () => {
    const error = unservableError({
      plan: CANNOT_COUNT,
      decision: decision([
        reject("anthropic", "cooling-down", RESET),
        reject("openai", "cooling-down", RESET),
      ]),
      capable,
      now: NOW,
    })

    // The OpenAI account is cooling too, but it could not have counted tokens awake either — saying
    // "2 accounts are rate limited" would blame the outage on capacity this request never had.
    expect(error.message).toContain("1 of 1 account")
    expect(error.message).toContain("anthropic")
    expect(error.message).not.toContain("openai")
  })
})

describe("the operation gap stands", () => {
  test("when no account that could have served it was held back at all", () => {
    const error = unservableError({
      plan: CANNOT_COUNT,
      decision: decision([reject("openai", "cooling-down", RESET)]),
      capable,
      now: NOW,
    })

    expect(error).toBeInstanceOf(NoHealthyAccountError)
    expect(error.status).toBe(503)
    expect(error.message).toContain("cannot count tokens")
  })

  test("when the capable account was dropped for something its message explains better", () => {
    // `disabled` and `model-unsupported` are not conditions a clock or a top-up resolves, and the
    // plan's own sentence says more about why this request cannot be served than "1 account is
    // disabled" would.
    for (const reason of ["disabled", "needs-reauth", "model-unsupported"] as const) {
      const error = unservableError({
        plan: CANNOT_COUNT,
        decision: decision([reject("anthropic", reason)]),
        capable,
        now: NOW,
      })

      expect(error.status).toBe(503)
      expect(error.message).toContain("cannot count tokens")
    }
  })

  test("when nothing was rejected by selection at all", () => {
    const error = unservableError({
      plan: CANNOT_COUNT,
      decision: decision([]),
      capable,
      now: NOW,
    })

    expect(error.status).toBe(503)
  })
})

describe("the other two reasons a chain can be empty", () => {
  test("a missing translator is still the 400 it was — a fact about the request", () => {
    const error = unservableError({
      plan: {
        servable: [],
        rejection: {
          mode: "rejected",
          reason: "no-translator",
          message: "this build implements no anthropic to openai-responses translation",
        },
        endpointError: null,
      },
      decision: decision([]),
      capable,
      now: NOW,
    })

    expect(error).toBeInstanceOf(TranslationError)
    expect(error.status).toBe(400)
  })

  test("an unresolvable endpoint surfaces its own error rather than a generic one", () => {
    const endpointError = new NoHealthyAccountError("account acct-1 has no base URL configured")
    const error = unservableError({
      plan: { servable: [], rejection: null, endpointError },
      decision: decision([]),
      capable,
      now: NOW,
    })

    expect(error).toBe(endpointError)
  })

  test("a chain emptied with no reason at all is still never a generic 500", () => {
    const error = unservableError({
      plan: { servable: [], rejection: null, endpointError: null },
      decision: decision([]),
      capable,
      now: NOW,
    })

    expect(error).toBeInstanceOf(NoHealthyAccountError)
    expect(error.status).toBe(503)
  })
})

describe("a held-back capable account outranks a resolvable endpoint failure too", () => {
  test("because the cooling account is the one the operator would wait on", () => {
    const error = unservableError({
      plan: {
        servable: [],
        rejection: null,
        endpointError: new NoHealthyAccountError("account openai has no base URL configured"),
      },
      decision: decision([reject("anthropic", "cooling-down", RESET)]),
      capable,
      now: NOW,
    })

    expect(error.status).toBe(429)
    expect(error.retryAfterSeconds).toBe(90)
  })
})
