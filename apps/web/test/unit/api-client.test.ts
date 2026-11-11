import { describe, expect, test } from "bun:test"
import { buildInit, buildPath, CSRF_HEADER, isMutating, request } from "../../src/lib/api/client"
import { clearSession } from "../../src/lib/api/session"

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

describe("buildPath repeated params", () => {
  test("an array is appended once per value, never joined", () => {
    expect(buildPath("/usage", { owner: ["alice", "bob"] })).toBe(
      "/api/admin/usage?owner=alice&owner=bob",
    )
  })

  test("empty values and empty lists are dropped", () => {
    expect(buildPath("/usage", { owner: ["alice", ""], tool: [], model: undefined })).toBe(
      "/api/admin/usage?owner=alice",
    )
    expect(buildPath("/usage", { owner: [""] })).toBe("/api/admin/usage")
  })

  test("scalars and lists mix", () => {
    expect(buildPath("/usage", { window: "7d", model: ["a b", "c"] })).toBe(
      "/api/admin/usage?window=7d&model=a+b&model=c",
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

describe("request before the session read has landed", () => {
  test("a mutation waits for the session's CSRF token instead of going out without one", async () => {
    const originalFetch = globalThis.fetch
    clearSession()
    const sent: { method: string; path: string; csrf: string | null }[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      const headers = (init?.headers ?? {}) as Record<string, string>
      sent.push({ method: init?.method ?? "GET", path, csrf: headers[CSRF_HEADER] ?? null })
      if (path.endsWith("/auth/session")) {
        return Response.json({ username: "admin", csrfToken: "token-1" })
      }
      return Response.json({ ok: true })
    }) as typeof fetch
    try {
      await request({ method: "POST", path: "/accounts/acc-1/recheck" })
      expect(sent.map((call) => `${call.method} ${call.path}`)).toEqual([
        "GET /api/admin/auth/session",
        "POST /api/admin/accounts/acc-1/recheck",
      ])
      expect(sent[1]?.csrf).toBe("token-1")
    } finally {
      globalThis.fetch = originalFetch
      clearSession()
    }
  })

  test("login is the one mutation that never waits — it is what issues the session", async () => {
    const originalFetch = globalThis.fetch
    clearSession()
    const paths: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      paths.push(String(input))
      return Response.json({ username: "admin", csrfToken: "token-2" })
    }) as typeof fetch
    try {
      await request({ method: "POST", path: "/auth/login", body: { password: "x" } })
      expect(paths).toEqual(["/api/admin/auth/login"])
    } finally {
      globalThis.fetch = originalFetch
      clearSession()
    }
  })
})
