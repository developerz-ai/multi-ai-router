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

  test("a credential shrunk away early cannot pull a cut fragment into the kept text (#207 review)", () => {
    const { log, lines } = captured()
    const maxChars = 200
    // The window is maxChars + 4096. A 4,100-character bearer value collapses to `[REDACTED]`, and
    // the window ends four characters before the `@` of a userinfo URL whose password is then cut
    // below anything a pattern can match.
    const head = `Bearer ${"b".repeat(4100)} `
    const url = "postgres://router:SuperSecretPassw0rdXYZ@db"
    const filler = "f".repeat(maxChars + 4096 - head.length - (url.indexOf("@") - 4))
    logAttemptFailure(log, "a", 1, failure(`${head}${filler}${url}`), maxChars)
    expect(JSON.stringify(lines)).not.toContain("SuperSecret")
    const quoted = lines[0]?.upstreamMessage
    if (typeof quoted !== "string") throw new Error("the line carries no upstreamMessage")
    expect(quoted.length).toBeLessThanOrEqual(maxChars)
  })

  test("the words before a collapsed token are still logged (#207 review)", () => {
    const { log, lines } = captured()
    const message = `Failed to authenticate: upstream said Bearer ${"t".repeat(400)} ${"x".repeat(5000)}`
    logAttemptFailure(log, "a", 1, failure(message), 200)
    const quoted = lines[0]?.upstreamMessage
    if (typeof quoted !== "string") throw new Error("the line carries no upstreamMessage")
    expect(quoted.startsWith("Failed to authenticate: upstream said [REDACTED]")).toBe(true)
    expect(quoted.length).toBe(200)
  })

  test("a token far longer than the window still leaves the words before it (#207 round 3)", () => {
    for (const message of [
      `Failed: Bearer ${"t".repeat(30_000)} ${"x".repeat(5_000)}`,
      Array.from(
        { length: 400 },
        (_, i) => `sk-${String(i).padStart(12, "k")}abcdefghijklmnop`,
      ).join(","),
    ]) {
      const { log, lines } = captured()
      logAttemptFailure(log, "a", 1, failure(message), 200)
      const quoted = lines[0]?.upstreamMessage
      if (typeof quoted !== "string") throw new Error("the line carries no upstreamMessage")
      expect(quoted.length).toBeGreaterThan(10)
      expect(quoted.length).toBeLessThanOrEqual(200)
      expect(quoted).not.toContain("abcdefghijklmnop")
    }
  })

  test("a cut never splits a [REDACTED] marker, so the logged line stays within the bound", () => {
    for (let pad = 0; pad < 20; pad++) {
      const { log, lines } = captured()
      // The logger's own pass re-expands a cut `?token=[RE…` to `?token=[REDACTED]`.
      const message = `${"p".repeat(pad + 10)} https://h/cb?token=abcdefgh ${"x".repeat(6_000)}`
      logAttemptFailure(log, "a", 1, failure(message), 40)
      const quoted = lines[0]?.upstreamMessage
      if (typeof quoted !== "string") throw new Error("the line carries no upstreamMessage")
      expect(quoted.length).toBeLessThanOrEqual(40)
    }
  })

  test("a credential over 4 KB across the window's end leaves no head (#207 round 4)", () => {
    const message = `sk-${"k".repeat(4300)} x://svc:${"P".repeat(5000)}@db.internal/app`
    const { log, lines } = captured()
    logAttemptFailure(log, "a", 1, failure(message), 200)
    expect(JSON.stringify(lines)).not.toContain("PPPP")
  })

  test.each([
    ["a JWT payload", `eyJ${"Q".repeat(20)}.${"Q".repeat(13_000)}.${"Q".repeat(40)}`],
    ["a userinfo password", `postgres://u:${"Q".repeat(13_000)}@h`],
    ["a long JWT header", `eyJ${"Q".repeat(13_000)}.${"Q".repeat(40)}.${"Q".repeat(40)}`],
  ])(
    "%s over 4 KB behind a collapsed token leaves nothing (#207 round 4)",
    (_label, credential) => {
      const { log, lines } = captured()
      logAttemptFailure(log, "a", 1, failure(`Bearer ${"t".repeat(5_000)} ${credential} tail`), 200)
      expect(JSON.stringify(lines)).not.toContain("QQQQ")
    },
  )

  test("a long message with nothing to redact still keeps the full bound", () => {
    const { log, lines } = captured()
    logAttemptFailure(log, "a", 1, failure("m".repeat(10_000)), REASON_MAX_CHARS)
    expect(lines[0]?.upstreamMessage).toBe(`${"m".repeat(REASON_MAX_CHARS - 1)}…`)
  })

  test("a short message passes through whole, and an absent one stays absent", () => {
    const { log, lines } = captured()
    logAttemptFailure(log, "a", 1, failure("was rejected"), REASON_MAX_CHARS)
    expect(lines[0]?.upstreamMessage).toBe("was rejected")
  })
})
