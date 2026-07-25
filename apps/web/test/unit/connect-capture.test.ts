import { describe, expect, test } from "bun:test"
import {
  classifyPaste,
  connectExpiry,
  describePasteShape,
  isSubmittablePaste,
  type PastedShape,
} from "../../src/lib/connect-capture"

// Opaque on purpose. These stand in for an authorization code and a one-shot state, and they carry
// no English inside them — so "does the feedback sentence echo the value" is a question about the
// module, not about which common word both happened to contain.
const CODE = "Ac1cQ9uZk4Tp"
const STATE = "St8vN2hR6yLw"
const CALLBACK_URL = `https://router.example/admin/accounts/oauth/callback?code=${CODE}&state=${STATE}`
const QUERY_STRING = `code=${CODE}&state=${STATE}`
const SHORTHAND = `${CODE}#${STATE}`

const SHAPES: readonly PastedShape[] = [
  "callback-url",
  "query-string",
  "shorthand",
  "unrecognised",
  "empty",
]

describe("classifyPaste", () => {
  // All three are what the server accepts (`services/accounts/connect/oauth-paste.ts`). Refusing
  // two of them in the console would only teach operators to hand-edit a code before pasting it.
  test("recognises the whole callback URL", () => {
    expect(classifyPaste(CALLBACK_URL)).toBe("callback-url")
  })

  test("recognises a bare query string", () => {
    expect(classifyPaste(QUERY_STRING)).toBe("query-string")
  })

  test("recognises the code#state shorthand", () => {
    expect(classifyPaste(SHORTHAND)).toBe("shorthand")
  })

  test("trims surrounding whitespace before deciding", () => {
    expect(classifyPaste(`  ${SHORTHAND}\n`)).toBe("shorthand")
    expect(classifyPaste(`\t${CALLBACK_URL}  `)).toBe("callback-url")
  })

  test("ignores a fragment that follows the query", () => {
    expect(classifyPaste(`${CALLBACK_URL}#`)).toBe("callback-url")
    expect(classifyPaste(`${CALLBACK_URL}#anything`)).toBe("callback-url")
  })

  // Whitespace inside the shorthand means a URL arrived with a line break, or two values were
  // pasted together. Guessing which half was meant is how the wrong one gets exchanged.
  test("rejects whitespace inside the shorthand", () => {
    expect(classifyPaste(`${CODE} #${STATE}`)).toBe("unrecognised")
    expect(classifyPaste(`${CODE}#${STATE.slice(0, 4)} ${STATE.slice(4)}`)).toBe("unrecognised")
    expect(classifyPaste(`${CODE}\n#${STATE}`)).toBe("unrecognised")
  })

  test("rejects a shorthand that is not exactly two non-empty halves", () => {
    expect(classifyPaste(CODE)).toBe("unrecognised")
    expect(classifyPaste(`${CODE}#`)).toBe("unrecognised")
    expect(classifyPaste(`#${STATE}`)).toBe("unrecognised")
    expect(classifyPaste(`${CODE}#${STATE}#extra`)).toBe("unrecognised")
  })

  test("rejects a query string missing either half", () => {
    expect(classifyPaste(`code=${CODE}`)).toBe("unrecognised")
    expect(classifyPaste(`state=${STATE}`)).toBe("unrecognised")
    expect(classifyPaste(`code=&state=${STATE}`)).toBe("unrecognised")
    expect(classifyPaste(`code=${CODE}&state=`)).toBe("unrecognised")
  })

  test("rejects a callback URL missing either half", () => {
    expect(classifyPaste(`https://router.example/cb?code=${CODE}`)).toBe("unrecognised")
    expect(classifyPaste(`https://router.example/cb?error=access_denied`)).toBe("unrecognised")
  })

  test("empty and whitespace-only are empty, not a rejection", () => {
    expect(classifyPaste("")).toBe("empty")
    expect(classifyPaste("   \n\t ")).toBe("empty")
  })
})

describe("isSubmittablePaste", () => {
  test("true for the three recognised shapes", () => {
    expect(isSubmittablePaste(CALLBACK_URL)).toBe(true)
    expect(isSubmittablePaste(QUERY_STRING)).toBe(true)
    expect(isSubmittablePaste(SHORTHAND)).toBe(true)
  })

  test("false for empty and unrecognised", () => {
    expect(isSubmittablePaste("")).toBe(false)
    expect(isSubmittablePaste("   ")).toBe(false)
    expect(isSubmittablePaste(CODE)).toBe(false)
    expect(isSubmittablePaste(`code=${CODE}`)).toBe(false)
  })
})

describe("describePasteShape", () => {
  test("every shape has a sentence", () => {
    for (const shape of SHAPES) {
      expect(describePasteShape(shape).length).toBeGreaterThan(0)
    }
  })

  test("the unrecognised sentence says what to paste instead", () => {
    const sentence = describePasteShape("unrecognised")
    expect(sentence).toContain("callback URL")
    expect(sentence).toContain("code#state")
  })

  // The pasted value is an authorization code. A feedback line that quotes any part of it back puts
  // credential material into the DOM — the one thing this console must never do.
  test("no sentence echoes any part of the pasted code or state", () => {
    const inputs = [CALLBACK_URL, QUERY_STRING, SHORTHAND, `${CODE} #${STATE}`, ""]
    for (const input of inputs) {
      const sentence = describePasteShape(classifyPaste(input))
      expect(sentence).not.toContain(CODE)
      expect(sentence).not.toContain(STATE)
      if (input !== "") expect(sentence).not.toContain(input)

      for (const secret of [CODE, STATE]) {
        for (let start = 0; start + 4 <= secret.length; start += 1) {
          expect(sentence).not.toContain(secret.slice(start, start + 4))
        }
      }
    }
  })
})

describe("connectExpiry", () => {
  const NOW = Date.UTC(2026, 0, 15, 12, 0, 0)
  const MINUTE = 60_000

  test("counts down while the one-shot start is live", () => {
    const live = connectExpiry(new Date(NOW + 4 * MINUTE + 30_000).toISOString(), NOW)
    expect(live.expired).toBe(false)
    expect(live.remaining).toBe("4m 30s")
  })

  test("is expired the instant it is due, and counts no further back", () => {
    expect(connectExpiry(new Date(NOW).toISOString(), NOW)).toEqual({
      expired: true,
      remaining: "0s",
    })
    expect(connectExpiry(new Date(NOW - 10 * MINUTE).toISOString(), NOW)).toEqual({
      expired: true,
      remaining: "0s",
    })
  })

  // A deadline that cannot be read must not be presented as time remaining.
  test("an unparsable timestamp counts as expired", () => {
    const unreadable = connectExpiry("not a timestamp", NOW)
    expect(unreadable.expired).toBe(true)
    expect(unreadable.remaining).toBe("0s")
  })
})
