import { describe, expect, test } from "bun:test"
import { classifySdkFailure } from "../../../src/providers"
import { SdkResultError } from "../../../src/providers/claude-sdk/result-error"
import { failoverKind } from "../../../src/services/dataplane/attempt"
import { HEALTHY, recordFailure } from "../../../src/services/routing"

/**
 * The rows added after production showed a dead subscription pool answering `502` "for a reason
 * this router does not recognize" (2026-09-05), plus the credits-era and context-window wordings
 * Meridian's classifier learned the hard way (#890, #908, #919, #929, 3ce6a57). Each test names the
 * phrase verbatim, because the phrase is the whole provenance.
 */

const NOW = new Date("2026-09-05T12:00:00.000Z")

function resultError(
  text: string,
  apiErrorStatus: number | null = null,
  terminalReason = "api_error",
) {
  return new SdkResultError({ text, apiErrorStatus, terminalReason })
}

describe("an expired subscription, in every spelling the CLI has for it", () => {
  /** The exact production shape: `is_error: true`, `api_error_status: null`, `terminal_reason: "api_error"`. */
  test("the 30-day refresh-token cliff is an auth failure that parks the account needs_reauth", () => {
    const error = resultError(
      "Failed to authenticate: OAuth session expired and could not be refreshed",
    )

    const { classification, clientMessage } = classifySdkFailure(error)

    expect(classification.kind).toBe("auth")
    expect(classification.status).toBe(401)
    // Retryable: the account is parked and the chain walks on to the next candidate with zero
    // bytes on the wire — the client's request is not the dead credential's problem.
    expect(classification.retryable).toBe(true)
    expect(classification.signal).toBe("claude-sdk:credential-expired")
    expect(clientMessage).toBe("the account's Claude subscription needs re-authenticating")
    // Through the breaker, the account leaves routing until a human reconnects it — parked as
    // `needs_reauth`, never a 502 that reads as "server error" and hides the real remedy.
    const kind = failoverKind(classification.kind, classification.status)
    const state = recordFailure(HEALTHY, { kind, message: clientMessage, status: 401 }, NOW, {
      authKind: "oauth",
    })
    expect(state.status).toBe("needs_reauth")
  })

  test("each phrase the 2.1.261 string table uses for a dead credential is auth", () => {
    for (const message of [
      "Claude Code returned an error result: Failed to authenticate. ",
      "Not logged in. Run claude auth login to authenticate.",
      "API Error: 401 Invalid API key · Please run /login",
      "Session expired. Please run /login to sign in again.",
      "OAuth token has expired",
      "Failed to authenticate: OAuth session expired and could not be refreshed",
      'API Error: {"type":"authentication_error","message":"invalid x-api-key"}',
      "Invalid authentication credentials",
    ]) {
      const { classification } = classifySdkFailure(new Error(message))
      expect(classification.kind).toBe("auth")
    }
  })

  test("'authentication failed' is read from the message, never from stderr", () => {
    const withStderr = Object.assign(new Error("Claude Code process exited with code 1"), {
      stderr: "[mcp] authentication failed for server foo",
    })
    expect(classifySdkFailure(withStderr).classification.kind).toBe("subprocess-crash")
    expect(
      classifySdkFailure(new Error("Authentication failed. Please check your API credentials."))
        .classification.kind,
    ).toBe("auth")
  })
})

describe("the credits-era and plan-window wordings", () => {
  test("a per-tier or weekly 'reached your … limit' is a cooldown", () => {
    for (const message of [
      "You've reached your Fable limit. Run /usage-credits to continue",
      "you have reached your weekly usage limit",
      "You've hit your monthly spend limit. /model to switch models.",
      "You've hit your fast limit",
    ]) {
      const { classification } = classifySdkFailure(new Error(message))
      expect(classification.kind).toBe("rate-limited")
      expect(classification.status).toBe(429)
    }
  })

  test("a 'reached your' sentence about some other configured limit is not quota", () => {
    const { classification } = classifySdkFailure(
      new Error("You've reached your configured tool call depth limit for this run"),
    )
    expect(classification.kind).not.toBe("rate-limited")
  })

  test("a member's spent usage credits cool down; an org's or a $0 cap need a human", () => {
    expect(
      classifySdkFailure(new Error("You're out of usage credits. /model to switch models."))
        .classification,
    ).toMatchObject({ kind: "rate-limited", status: 429 })

    for (const message of [
      "Your organization is out of usage credits. Contact your admin to add more.",
      "Your group's usage limit is set to $0 · run /usage-credits to ask your admin for a higher limit",
    ]) {
      const { classification } = classifySdkFailure(new Error(message))
      expect(classification.kind).toBe("credits-exhausted")
      expect(classification.status).toBe(402)
      expect(recordFailure(HEALTHY, { kind: "credits-exhausted", message }, NOW).status).toBe(
        "exhausted",
      )
    }
  })
})

describe("requests no account can serve, and upstreams no account can reach", () => {
  test("an oversized prompt is the client's 400, on every account, with no breaker strike", () => {
    for (const error of [
      new Error("API Error: 400 prompt is too long: 213000 tokens > 200000 maximum"),
      new Error('{"type":"error","error":{"code":"context_length_exceeded"}}'),
      resultError("Prompt is too long", null, "prompt_too_long"),
      // The structured reason alone, with wording nobody has recorded.
      resultError("the turn could not start", null, "prompt_too_long"),
    ]) {
      const { classification } = classifySdkFailure(error)
      expect(classification.kind).toBe("invalid-request")
      expect(classification.status).toBe(400)
      expect(classification.signal).toBe("claude-sdk:prompt-too-long")
      expect(failoverKind(classification.kind, classification.status)).toBe("client-error")
    }
  })

  test("a CLI older than the requested model is named as the router's problem, not the account's", () => {
    const { classification, clientMessage } = classifySdkFailure(
      new Error(
        "API Error: 400 Claude Code 2.1.198 does not support this model; version 2.1.251 or newer is required. Run 'claude update'",
      ),
    )

    expect(classification.kind).toBe("invalid-request")
    expect(classification.signal).toBe("claude-sdk:cli-too-old-for-model")
    expect(clientMessage).toContain("router image needs upgrading")
    // A healthy account is not struck for a fact about the image it runs in.
    const state = recordFailure(HEALTHY, { kind: "client-error", message: "x", status: 400 }, NOW)
    expect(state).toBe(HEALTHY)
  })

  test("an overloaded upstream fails over with Anthropic's own 529, instead of failing the request", () => {
    for (const error of [
      new Error("API Error: 529 overloaded_error"),
      resultError("upstream overloaded, retries exhausted", 529),
      resultError("service unavailable", 503),
    ]) {
      const { classification } = classifySdkFailure(error)
      expect(classification.kind).toBe("server-error")
      expect(classification.status).toBe(529)
      expect(classification.retryable).toBe(true)
      expect(classification.signal).toBe("claude-sdk:overloaded")
    }
  })

  test("a fork whose rewind point is gone is a stale session: evict and replay, never a dead end", () => {
    const { classification } = classifySdkFailure(
      new Error("No message found with message.uuid of: 0f3c…"),
    )
    expect(classification.kind).toBe("stale-session")
    expect(classification.signal).toBe("claude-sdk:session-not-found")
  })
})

describe("the SDK's structured status, read after every phrase", () => {
  test("a status nobody has words for still classifies", () => {
    expect(classifySdkFailure(resultError("nope", 401)).classification.kind).toBe("auth")
    expect(classifySdkFailure(resultError("nope", 402)).classification.kind).toBe(
      "credits-exhausted",
    )
    expect(classifySdkFailure(resultError("nope", 429)).classification.kind).toBe("rate-limited")
    expect(classifySdkFailure(resultError("nope", 400)).classification.kind).toBe("invalid-request")
    expect(classifySdkFailure(resultError("nope", 500)).classification).toMatchObject({
      kind: "server-error",
      signal: "claude-sdk:api-status-5xx",
    })
  })

  test("a phrase outranks the status: a dead balance arrives as a 400 and stays a 402", () => {
    const { classification } = classifySdkFailure(
      resultError("Your credit balance is too low to access the Anthropic API", 400),
    )
    expect(classification.kind).toBe("credits-exhausted")
    expect(classification.status).toBe(402)
  })

  test("a foreign error's own `status` property is not the SDK's word", () => {
    const foreign = Object.assign(new Error("fetch failed"), { status: 401 })
    expect(classifySdkFailure(foreign).classification.kind).toBe("unknown")
  })

  test("a stack frame's column is not a status token", () => {
    expect(
      classifySdkFailure(new Error("TypeError at handler.js:401:15")).classification.kind,
    ).toBe("unknown")
  })
})

/**
 * The 2026-09-05 outage: every agent-sized request through opencode came back `400` and the client
 * was told its request was malformed. The request was fine — Anthropic had metered it against Extra
 * Usage because the system prompt carried a second harness's fingerprints (`scrub.ts`), and the
 * account had none left. Read as `invalid-request` the chain stopped dead with five healthy
 * subscriptions unasked; read as what it is, it rotates and the account cools down.
 */
describe("a request Anthropic metered against Extra Usage", () => {
  /** Verbatim from the pod log, 2026-09-05. The sentence is the whole provenance. */
  const EXTRA_USAGE =
    "Claude Code returned an error result: API Error: 400 Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."

  test("it is never `invalid-request`, however the SDK reports the 400 beside it", () => {
    for (const error of [
      new Error(EXTRA_USAGE),
      resultError(EXTRA_USAGE, 400),
      resultError("Third-party apps now draw from your extra usage, not your plan limits.", null),
    ]) {
      const { classification } = classifySdkFailure(error)
      expect(classification.kind).not.toBe("invalid-request")
      expect(classification.signal).toBe("claude-sdk:extra-usage-gated")
    }
  })

  test("the named phrase beats the bare 400: the account is cooling down, not the request bad", () => {
    const { classification, clientMessage } = classifySdkFailure(resultError(EXTRA_USAGE, 400))

    expect(classification.kind).toBe("rate-limited")
    expect(classification.status).toBe(429)
    // Retryable is the whole point: the planner walks to the next account in the pool.
    expect(classification.retryable).toBe(true)
    expect(failoverKind(classification.kind, classification.status)).toBe("rate-limited")

    // And the account it just failed on is parked on a clock, so the pool is not burned on it
    // again on the very next request — `cooling_down`, never `exhausted` (non-negotiable 7).
    const state = recordFailure(
      HEALTHY,
      { kind: "rate-limited", message: clientMessage, status: 429 },
      NOW,
    )
    expect(state.status).toBe("cooling_down")
    expect(state.cooldownUntil).toBeInstanceOf(Date)
  })

  test("the client hears one honest sentence: no capacity, and where to add more", () => {
    const { clientMessage } = classifySdkFailure(resultError(EXTRA_USAGE, 400))

    expect(clientMessage).toContain("no Claude subscription capacity is available right now")
    expect(clientMessage).toContain("claude.ai/settings/usage")
    expect(clientMessage).not.toContain("malformed")
    // Router-authored: the rotation is the router's business, so nothing about which account was
    // tried, how many there were, or how long any of them is cooling down reaches a caller.
    expect(clientMessage).not.toContain("account ")
    expect(clientMessage).not.toContain("cooling")
  })

  test("the SDK's own words stay on the log side of the split", () => {
    const { classification, clientMessage } = classifySdkFailure(resultError(EXTRA_USAGE, 400))

    expect(classification.message).toContain("Third-party apps now draw from your extra usage")
    expect(clientMessage).not.toContain("Claude Code returned an error result")
  })

  test("a spent plan window is still the plain window message, not this one", () => {
    const { classification, clientMessage } = classifySdkFailure(
      new Error("You've hit your weekly limit · resets Sep 8, 11pm (UTC)"),
    )

    expect(classification.signal).toBe("claude-sdk:plan-window-spent")
    expect(clientMessage).not.toContain("claude.ai/settings/usage")
  })
})
