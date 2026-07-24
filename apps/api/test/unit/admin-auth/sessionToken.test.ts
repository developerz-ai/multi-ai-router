import { describe, expect, test } from "bun:test"
import { timingSafeEqualStrings } from "../../../src/services/admin-auth/constantTime"
import {
  CSRF_HEADER,
  csrfTokenMatches,
  isMutatingMethod,
  mintCsrfToken,
} from "../../../src/services/admin-auth/csrf"
import type { AdminSession } from "../../../src/services/admin-auth/sessionStore"
import {
  deriveSessionSigningKey,
  mintSessionId,
  parseSignedSessionId,
  signSessionId,
} from "../../../src/services/admin-auth/sessionToken"

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64")
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64")

const key = deriveSessionSigningKey(ENCRYPTION_KEY)

describe("deriveSessionSigningKey", () => {
  test("is deterministic, 32 bytes, and not the encryption key itself", () => {
    expect(key.byteLength).toBe(32)
    expect(key.equals(deriveSessionSigningKey(ENCRYPTION_KEY))).toBe(true)
    expect(key.toString("base64")).not.toBe(ENCRYPTION_KEY)
  })

  test("a different ENCRYPTION_KEY derives a different signing key", () => {
    expect(key.equals(deriveSessionSigningKey(OTHER_KEY))).toBe(false)
  })

  test("refuses a key that is not 32 bytes rather than deriving from garbage", () => {
    expect(() => deriveSessionSigningKey("too-short")).toThrow(/32 bytes/)
  })
})

describe("session ids", () => {
  test("are opaque, high-entropy, and never repeat", () => {
    const ids = new Set(Array.from({ length: 500 }, () => mintSessionId()))

    expect(ids.size).toBe(500)
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test("round-trip through signing", () => {
    const id = mintSessionId()

    expect(parseSignedSessionId(signSessionId(id, key), key)).toBe(id)
  })

  test("a tampered id, a tampered signature, or a bare id does not validate", () => {
    const id = mintSessionId()
    const signed = signSessionId(id, key)

    expect(parseSignedSessionId(`${mintSessionId()}.${signed.split(".")[1]}`, key)).toBeNull()
    expect(parseSignedSessionId(`${id}.deadbeef`, key)).toBeNull()
    expect(parseSignedSessionId(id, key)).toBeNull()
    expect(parseSignedSessionId("", key)).toBeNull()
    expect(parseSignedSessionId(".", key)).toBeNull()
    expect(parseSignedSessionId(`${id}.`, key)).toBeNull()
  })

  test("a cookie signed under another key is rejected", () => {
    const id = mintSessionId()

    expect(
      parseSignedSessionId(signSessionId(id, key), deriveSessionSigningKey(OTHER_KEY)),
    ).toBeNull()
  })
})

describe("csrf tokens", () => {
  const session = (csrfToken: string): AdminSession => ({
    id: "s",
    username: "admin",
    csrfToken,
    createdAtMs: 0,
    lastSeenAtMs: 0,
    idleExpiryMs: 1,
    absoluteExpiryMs: 1,
  })

  test("are unguessable and unique per session", () => {
    const tokens = new Set(Array.from({ length: 500 }, () => mintCsrfToken()))

    expect(tokens.size).toBe(500)
  })

  test("match only their own session's token", () => {
    const token = mintCsrfToken()

    expect(csrfTokenMatches(session(token), token)).toBe(true)
    expect(csrfTokenMatches(session(token), mintCsrfToken())).toBe(false)
    expect(csrfTokenMatches(session(token), token.slice(0, -1))).toBe(false)
    expect(csrfTokenMatches(session(token), "")).toBe(false)
    expect(csrfTokenMatches(session(token), undefined)).toBe(false)
  })

  test("names the header the SPA echoes", () => {
    expect(CSRF_HEADER).toBe("x-csrf-token")
  })

  test("every state-changing method needs one; reads do not", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post", "delete"]) {
      expect(isMutatingMethod(method)).toBe(true)
    }
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(isMutatingMethod(method)).toBe(false)
    }
  })
})

describe("timingSafeEqualStrings", () => {
  test("compares unequal lengths without throwing", () => {
    expect(timingSafeEqualStrings("a", "a")).toBe(true)
    expect(timingSafeEqualStrings("a", "aaaaaaaaaaaaaaaaaaaa")).toBe(false)
    expect(timingSafeEqualStrings("", "")).toBe(true)
    expect(timingSafeEqualStrings("héllo", "héllo")).toBe(true)
  })
})
