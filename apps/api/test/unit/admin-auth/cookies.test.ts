import { describe, expect, test } from "bun:test"
import {
  SESSION_COOKIE_NAME,
  sessionCookieFullName,
  sessionCookieOptions,
  sessionCookiePrefix,
} from "../../../src/services/admin-auth/cookies"

/**
 * The cookie's attributes are the security properties of the admin session, so they are pinned
 * here rather than only observed through a route. The escape hatch is pinned just as hard: what
 * it gives up is exactly `Secure` and `__Host-`, and nothing else moves with it.
 */

describe("the hardened cookie (the default)", () => {
  test("carries every attribute 04-api-keys-and-access.md names", () => {
    expect(sessionCookieOptions(3600, false)).toEqual({
      prefix: "host",
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
      path: "/",
      maxAge: 3600,
    })
  })

  test("is named with the __Host- prefix on the wire, and read back under it", () => {
    expect(sessionCookieFullName(false)).toBe(`__Host-${SESSION_COOKIE_NAME}`)
    expect(sessionCookiePrefix(false)).toBe("host")
  })
})

describe("SESSION_COOKIE_INSECURE", () => {
  test("gives up Secure and __Host- together, and gives up nothing else", () => {
    expect(sessionCookieOptions(3600, true)).toEqual({
      prefix: undefined,
      httpOnly: true,
      secure: false,
      sameSite: "Strict",
      path: "/",
      maxAge: 3600,
    })
  })

  test("names the cookie without a prefix, so the reader looks up the same key", () => {
    expect(sessionCookieFullName(true)).toBe(SESSION_COOKIE_NAME)
    expect(sessionCookiePrefix(true)).toBeUndefined()
  })

  test("the name and the prefix are the same decision — they can never disagree", () => {
    for (const insecure of [false, true]) {
      const prefixed = sessionCookiePrefix(insecure) === "host"
      expect(sessionCookieFullName(insecure).startsWith("__Host-")).toBe(prefixed)
      expect(sessionCookieOptions(1, insecure).secure).toBe(prefixed)
    }
  })
})

describe("maxAge", () => {
  test("is passed through, including the zero that expires the cookie on logout", () => {
    expect(sessionCookieOptions(0, false).maxAge).toBe(0)
    expect(sessionCookieOptions(28_800, false).maxAge).toBe(28_800)
  })
})
