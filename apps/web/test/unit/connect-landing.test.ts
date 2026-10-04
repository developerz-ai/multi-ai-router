import { describe, expect, test } from "bun:test"
import { redirectLanded } from "../../src/routes/accounts/connect-landing"

describe("redirectLanded", () => {
  test("a row with no credential has not landed, however recently it was written", () => {
    expect(
      redirectLanded(
        { hasCredential: false, status: "needs_reauth" },
        { hasCredential: false, status: "needs_reauth" },
      ),
    ).toBe(false)
  })

  test("a credential appearing where there was none has landed", () => {
    expect(
      redirectLanded(
        { hasCredential: false, status: "needs_reauth" },
        { hasCredential: true, status: "active" },
      ),
    ).toBe(true)
  })

  test("a needs_reauth row that holds a credential and left that state has landed", () => {
    expect(
      redirectLanded(
        { hasCredential: true, status: "needs_reauth" },
        { hasCredential: true, status: "active" },
      ),
    ).toBe(true)
    expect(
      redirectLanded(
        { hasCredential: true, status: "needs_reauth" },
        { hasCredential: true, status: "needs_reauth" },
      ),
    ).toBe(false)
  })

  test("a healthy row being re-authorized is never inferred — a refresh looks the same", () => {
    expect(
      redirectLanded(
        { hasCredential: true, status: "active" },
        { hasCredential: true, status: "active" },
      ),
    ).toBe(false)
  })
})
