import { describe, expect, test } from "bun:test"
import { classifySdkFailure, readSdkFailure, STDERR_TAIL_LIMIT } from "../../../src/providers"

/**
 * SDK failures arrive as prose, so these tests pin the substring table itself
 * (docs/idea/11-anthropic-agent-sdk.md §9) — and, more importantly, the two rules that keep the
 * table from lying: a crash is never re-read as an auth failure off its stderr, and the SDK's own
 * words never become the sentence a client reads.
 */

function crash(message: string, stderr: string): Error {
  return Object.assign(new Error(message), { stderr })
}

describe("classifying an Agent-SDK failure", () => {
  test("an expired credential is an auth failure, and never a retry onto the next account", () => {
    for (const message of [
      "OAuth token has expired. Please run /login",
      "Not logged in. Run `claude login` first",
    ]) {
      const { classification } = classifySdkFailure(new Error(message))

      expect(classification.kind).toBe("auth")
      expect(classification.status).toBe(401)
      // The account needs a human, so no other account absorbs this one's problem — and nothing
      // here refreshes a token: the SDK owns it (§3).
      expect(classification.retryable).toBe(false)
      expect(classification.signal).toBe("claude-sdk:credential-expired")
    }
  })

  test("a spent window is rate limited, retryable, and carries no invented reset", () => {
    for (const message of [
      "Claude AI usage limit reached|1751200000",
      "API Error: rate limit exceeded",
    ]) {
      const { classification } = classifySdkFailure(new Error(message))

      expect(classification.kind).toBe("rate-limited")
      expect(classification.status).toBe(429)
      expect(classification.retryable).toBe(true)
      // The reset instant belongs to `rate_limit_event`, which reported it on the query stream.
      expect(classification.rateLimit).toBeNull()
    }
  })

  /**
   * The wording a spent *plan window* actually uses — recorded verbatim from a Max subscription at
   * 100% of its weekly allowance. It shares no phrase with the two above, so it used to fall all
   * the way through to `UNCLASSIFIED`: a `500`-shaped unknown for the most ordinary thing a pooled
   * subscription does, and the reason that account showed no diagnosis at all.
   */
  test("a spent plan window is a cooldown, in the wording the plan itself uses", () => {
    for (const message of [
      "You've hit your weekly limit · resets Jul 30, 11pm (UTC)",
      "You've hit your 5-hour limit · resets 4pm",
    ]) {
      const { classification } = classifySdkFailure(new Error(message))

      expect(classification.kind).toBe("rate-limited")
      expect(classification.status).toBe(429)
      // Never `auth`: parking a working subscription at `needs_reauth` for a window a clock
      // reopens is the exact confusion non-negotiable 7 forbids.
      expect(classification.retryable).toBe(true)
    }
  })

  test("the word 'limit' alone does not make a failure a cooldown", () => {
    const { classification } = classifySdkFailure(
      new Error("the configured context limit is not valid for this model"),
    )

    expect(classification.kind).not.toBe("rate-limited")
  })

  test("a stale session is its own class, not a server error", () => {
    const { classification } = classifySdkFailure(
      new Error("No conversation found with session ID: 4f2b-…"),
    )

    expect(classification.kind).toBe("stale-session")
    // Recovery is a replay on the *same* account, so this must not walk the chain to the next one.
    expect(classification.retryable).toBe(false)
    expect(classification.signal).toBe("claude-sdk:session-not-found")
  })

  test("a busy session is distinguished from a stale one", () => {
    const { classification } = classifySdkFailure(
      new Error("Session 4f2b is currently running as a background agent"),
    )

    expect(classification.kind).toBe("busy-session")
    expect(classification.retryable).toBe(false)
    expect(classification.status).toBe(503)
  })

  test("an overage-only variant cools down rather than reporting a dead balance", () => {
    const { classification } = classifySdkFailure(
      new Error("This request requires extra usage credits (claude-sonnet-4-5[1m])"),
    )

    // `cooling_down`, never `exhausted`: the included window it falls back to refills on a clock.
    expect(classification.kind).toBe("rate-limited")
    expect(classification.signal).toBe("claude-sdk:overage-required")
  })

  test("a subprocess exit is a crash, retryably, and says so", () => {
    const { classification } = classifySdkFailure(
      crash("Claude Code process exited with code 1", "panic: cannot open config"),
    )

    expect(classification.kind).toBe("subprocess-crash")
    expect(classification.status).toBe(502)
    // Another account's subprocess may well be fine.
    expect(classification.retryable).toBe(true)
  })

  test("a 401 buried in a crash's stderr does not mark the account needs_reauth", () => {
    const { classification } = classifySdkFailure(
      crash("Claude Code process exited with code 1", "fetch failed: 401 from some other host"),
    )

    // The bug this rule exists to avoid: an exit-1 heuristic that reports every crash as an auth
    // failure drops a working account out of routing until a human logs in again.
    expect(classification.kind).toBe("subprocess-crash")
  })

  test("a bare status in the message is still read, when nothing more specific matched", () => {
    expect(classifySdkFailure(new Error("API Error: 401 {}")).classification.kind).toBe("auth")
    expect(classifySdkFailure(new Error("API Error: 429 {}")).classification.kind).toBe(
      "rate-limited",
    )
    // A whole word, so an id that merely contains the digits is not a status.
    expect(classifySdkFailure(new Error("request req_11401 failed")).classification.kind).toBe(
      "unknown",
    )
  })

  test("an unrecognized failure is named unknown rather than guessed at", () => {
    const { classification, clientMessage } = classifySdkFailure(
      new Error("something went sideways"),
    )

    expect(classification.kind).toBe("unknown")
    expect(classification.status).toBe(502)
    expect(classification.signal).toBe("claude-sdk:unclassified")
    expect(clientMessage).not.toContain("sideways")
  })

  test("the client sentence is router-authored and the SDK's own words stay in the log field", () => {
    const raw = "OAuth token has expired for /data/accounts/sub/.credentials.json"
    const { classification, clientMessage } = classifySdkFailure(new Error(raw))

    expect(clientMessage).toBe("the account's Claude subscription needs re-authenticating")
    expect(clientMessage).not.toContain("/data/accounts")
    // Kept for the log line, where the redactor sees it — never rendered into a response body.
    expect(classification.message).toBe(raw)
  })
})

describe("reading what a throw carries", () => {
  test("a thrown string and a thrown error are both matched", () => {
    expect(readSdkFailure("Not logged in").message).toBe("Not logged in")
    expect(classifySdkFailure("Not logged in").classification.kind).toBe("auth")
  })

  test("stderr is bounded to its tail, where the cause is", () => {
    const stderr = `${"x".repeat(STDERR_TAIL_LIMIT * 2)}the real reason`
    const text = readSdkFailure(crash("exited with code 1", stderr))

    expect(text.stderrTail).toHaveLength(STDERR_TAIL_LIMIT)
    expect(text.stderrTail.endsWith("the real reason")).toBe(true)
  })

  test("a throw with nothing readable still classifies rather than throwing again", () => {
    for (const value of [null, undefined, 42, {}]) {
      const { classification } = classifySdkFailure(value)

      expect(classification.kind).toBe("unknown")
      expect(classification.message).toBeUndefined()
    }
  })
})
