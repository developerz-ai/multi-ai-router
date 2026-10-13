import { describe, expect, test } from "bun:test"
import { createLogger } from "../../../src/logging/logger"
import type { AttemptOutcome } from "../../../src/services/dataplane/attempt"
import { logAttemptFailure } from "../../../src/services/dataplane/attempt-log"

const REASON_MAX_CHARS = 40
const FAKE_KEY = "sk-LIVEFAKEKEY-do-not-leak-1234567890abcdef"

function captured() {
  const lines: Record<string, unknown>[] = []
  const log = createLogger({
    level: "info",
    write: (line) => {
      lines.push(JSON.parse(line))
    },
  })
  return { log, lines }
}

/** A classified failure whose message no earlier stage scrubbed, as the Agent-SDK path delivers. */
function failure(message: string): Extract<AttemptOutcome, { kind: "failure" }> {
  return {
    kind: "failure",
    failure: { kind: "auth", status: 401, message: "the upstream rejected the credential" },
    classification: {
      kind: "auth",
      status: 401,
      retryable: true,
      signal: "claude-sdk:auth",
      rateLimit: null,
      message,
    },
    rateLimit: null,
  } as Extract<AttemptOutcome, { kind: "failure" }>
}

describe("logAttemptFailure (#206)", () => {
  test("a credential cut by the length bound is redacted first, so no fragment survives", () => {
    const { log, lines } = captured()
    // The cut keeps REASON_MAX_CHARS - 1 characters; this prefix puts the cut seven characters into
    // the key, shorter than the `sk-` pattern needs to match on its own.
    logAttemptFailure(log, "a", 1, failure(`${"r".repeat(31)} ${FAKE_KEY}`), REASON_MAX_CHARS)
    const text = JSON.stringify(lines)
    expect(text).not.toContain("sk-LIVE")
    const quoted = lines[0]?.upstreamMessage
    if (typeof quoted !== "string") throw new Error("the line carries no upstreamMessage")
    expect(quoted.length).toBeLessThanOrEqual(REASON_MAX_CHARS)
  })

  test("a short message passes through whole, and an absent one stays absent", () => {
    const { log, lines } = captured()
    logAttemptFailure(log, "a", 1, failure("was rejected"), REASON_MAX_CHARS)
    expect(lines[0]?.upstreamMessage).toBe("was rejected")
  })
})
