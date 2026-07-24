import { describe, expect, test } from "bun:test"
import { buildInit, buildPath, CSRF_HEADER, isMutating } from "../../src/lib/api/client"

// Transport rules, asserted without a network. The load-bearing one is the CSRF
// header: the admin guard rejects a mutation that arrives without it, so a
// regression here breaks every write in the console at once.

describe("buildPath", () => {
  test("prefixes the admin base the API actually mounts", () => {
    expect(buildPath("/accounts")).toBe("/api/admin/accounts")
  })

  test("drops absent filters rather than serialising them", () => {
    expect(buildPath("/accounts", { status: undefined, provider: undefined })).toBe(
      "/api/admin/accounts",
    )
    expect(buildPath("/accounts", { status: "exhausted", provider: undefined })).toBe(
      "/api/admin/accounts?status=exhausted",
    )
  })

  test("encodes values", () => {
    expect(buildPath("/accounts", { provider: "openai-compatible" })).toBe(
      "/api/admin/accounts?provider=openai-compatible",
    )
  })
})

describe("isMutating", () => {
  test("GET is the only read", () => {
    expect(isMutating("GET")).toBe(false)
    for (const method of ["POST", "PATCH", "DELETE"] as const) {
      expect(isMutating(method)).toBe(true)
    }
  })
})

describe("buildInit", () => {
  test("every mutating method carries the CSRF token", () => {
    for (const method of ["POST", "PATCH", "DELETE"] as const) {
      const headers = buildInit(method, undefined, "token-abc").headers as Record<string, string>
      expect(headers[CSRF_HEADER]).toBe("token-abc")
    }
  })

  test("a read does not", () => {
    const headers = buildInit("GET", undefined, "token-abc").headers as Record<string, string>
    expect(headers[CSRF_HEADER]).toBeUndefined()
  })

  test("the session cookie rides along — same origin, no CORS layer", () => {
    expect(buildInit("GET", undefined, null).credentials).toBe("same-origin")
  })

  test("a body is JSON and declares itself as such", () => {
    const init = buildInit("POST", { label: "claude-max-01" }, "t")
    expect(init.body).toBe('{"label":"claude-max-01"}')
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json")
  })

  test("no body means no content-type", () => {
    const init = buildInit("POST", undefined, "t")
    expect(init.body).toBeUndefined()
    expect((init.headers as Record<string, string>)["content-type"]).toBeUndefined()
  })
})
