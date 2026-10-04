import { describe, expect, test } from "bun:test"
import { httpDriver } from "../../../src/providers"
import { classifySdkFailure } from "../../../src/providers/claude-sdk/errors"
import { failoverKind } from "../../../src/services/dataplane/attempt"
import { failureOutcome } from "../../../src/services/dataplane/records"
import {
  type AttemptFailure,
  type BreakerState,
  HEALTHY,
  isRetryable,
  markStreamed,
  NO_ATTEMPTS,
  planNextAttempt,
  recordAttempt,
  recordFailure,
} from "../../../src/services/routing"
import { response } from "../providers/fixtures"
import { account, candidates, NOW } from "./fixtures"

/**
 * An upstream refusing the *model name* is neither a bad request nor a sick account.
 *
 * Prod, 2026-10-04: `k3` on a Claude subscription came back as the CLI's "There's an issue with the
 * selected model" and was read `unknown` — a 502 that struck the breaker, put a healthy account into
 * a recovery probe, and left the conversation's binding waiting on it. `claude-opus-5-5` on the
 * ChatGPT account came back `400 … not supported when using Codex` and was read `invalid-request` —
 * no failover, with the right account in scope. Both are `model-unsupported`: the next account gets
 * its turn (before any byte is on the wire), and the account that answered is never struck.
 */

const MISSING: AttemptFailure = { kind: "model-unsupported", status: 404, message: "m" }

describe("classification", () => {
  test("the claude CLI's unknown-model sentence is model-unsupported, retryable", () => {
    const { classification, clientMessage } = classifySdkFailure(
      new Error(
        "There's an issue with the selected model (k3). It may not exist or you may not have access to it. Run /model to pick a different model.",
      ),
    )
    expect(classification.kind).toBe("model-unsupported")
    expect(classification.retryable).toBe(true)
    expect(classification.status).toBe(404)
    // Router-authored: the CLI's own words, and the name it echoed, never reach a client body.
    expect(clientMessage).not.toContain("k3")
  })

  test("Codex's unsupported-model 400 is model-unsupported, retryable", () => {
    const codex = httpDriver("openai-oauth")
    const result = codex?.classifyFailure(
      response(400, {
        body: {
          detail:
            "The 'claude-opus-5-5' model is not supported when using Codex with a ChatGPT account.",
        },
      }),
    )
    expect(result?.kind).toBe("model-unsupported")
    expect(result?.retryable).toBe(true)
  })

  test("any other Codex 400 stays a bad request", () => {
    const codex = httpDriver("openai-oauth")
    const result = codex?.classifyFailure(response(400, { body: { detail: "malformed input" } }))
    expect(result?.kind).toBe("invalid-request")
  })

  test("it keeps its own name through to the failover vocabulary", () => {
    expect(failoverKind("model-unsupported", 404)).toBe("model-unsupported")
    expect(failoverKind("model-unsupported", 400)).toBe("model-unsupported")
    expect(isRetryable("model-unsupported")).toBe(true)
  })
})

describe("failover", () => {
  const chain = candidates(account("claude"), account("kimi"))

  test("walks to the next candidate before any byte is on the wire", () => {
    const decision = planNextAttempt(chain, recordAttempt(NO_ATTEMPTS, "claude"), MISSING)
    expect(decision.action === "attempt" && decision.candidate.account.id).toBe("kimi")
  })

  test("and never after one is", () => {
    const streamed = markStreamed(recordAttempt(NO_ATTEMPTS, "claude"))
    expect(planNextAttempt(chain, streamed, MISSING)).toMatchObject({
      action: "stop",
      reason: "bytes-streamed",
    })
  })
})

describe("account health", () => {
  test("no breaker strike on a healthy account", () => {
    let state: BreakerState = HEALTHY
    for (let index = 0; index < 10; index += 1) state = recordFailure(state, MISSING, NOW)
    expect(state).toBe(HEALTHY)
  })

  test("no cooldown, so no recovery probe, on an account one strike from tripping", () => {
    const almost: BreakerState = { ...HEALTHY, consecutiveFailures: 2 }
    expect(recordFailure(almost, MISSING, NOW)).toBe(almost)
  })
})

describe("usage record", () => {
  test("a request no account could serve under that name is the caller's choice, not a pool fault", () => {
    expect(failureOutcome("model-unsupported")).toBe("client_error")
  })
})
