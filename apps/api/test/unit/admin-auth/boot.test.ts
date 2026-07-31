import { describe, expect, test } from "bun:test"
import { adminAuthBootProblem, isLoopbackUrl } from "../../../src/services/admin-auth/boot"

/**
 * The boot rule as a pure matrix: some sign-in method must exist, and a local
 * credential on a publicly addressed router is refused unless the override
 * names itself. `main.ts` runs this after migrations and exits on a problem.
 */

const PUBLIC = "https://router.example.com"
const LOOPBACK = "http://localhost:8080"

describe("at least one sign-in method", () => {
  test("OIDC alone boots", () => {
    expect(
      adminAuthBootProblem({
        oidcConfigured: true,
        localCredentialConfigured: false,
        publicUrl: PUBLIC,
        allowPublicLocalLogin: false,
      }),
    ).toBeNull()
  })

  test("a local credential alone boots, with no PUBLIC_URL set", () => {
    expect(
      adminAuthBootProblem({
        oidcConfigured: false,
        localCredentialConfigured: true,
        publicUrl: null,
        allowPublicLocalLogin: false,
      }),
    ).toBeNull()
  })

  test("both boot", () => {
    expect(
      adminAuthBootProblem({
        oidcConfigured: true,
        localCredentialConfigured: true,
        publicUrl: LOOPBACK,
        allowPublicLocalLogin: false,
      }),
    ).toBeNull()
  })

  test("neither refuses, naming both remedies and the doc", () => {
    const problem = adminAuthBootProblem({
      oidcConfigured: false,
      localCredentialConfigured: false,
      publicUrl: null,
      allowPublicLocalLogin: false,
    })

    expect(problem).toContain("no admin sign-in method")
    expect(problem).toContain("ADMIN_OIDC_")
    expect(problem).toContain("bin/admin set-password")
    expect(problem).toContain("docs/idea/13-admin-oidc.md")
  })
})

describe("the fail-closed loopback rule", () => {
  const base = {
    oidcConfigured: false,
    localCredentialConfigured: true,
  } as const

  test("a local credential on a public PUBLIC_URL refuses without the override", () => {
    const problem = adminAuthBootProblem({
      ...base,
      publicUrl: PUBLIC,
      allowPublicLocalLogin: false,
    })

    expect(problem).toContain(PUBLIC)
    expect(problem).toContain("ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC")
    expect(problem).toContain("bin/admin delete-password")
    expect(problem).toContain("docs/idea/13-admin-oidc.md")
  })

  test("the override passes, by name", () => {
    expect(
      adminAuthBootProblem({ ...base, publicUrl: PUBLIC, allowPublicLocalLogin: true }),
    ).toBeNull()
  })

  test("an unset PUBLIC_URL is not a public address", () => {
    expect(
      adminAuthBootProblem({ ...base, publicUrl: null, allowPublicLocalLogin: false }),
    ).toBeNull()
  })

  test("OIDC plus a local credential still refuses on a public address", () => {
    const problem = adminAuthBootProblem({
      oidcConfigured: true,
      localCredentialConfigured: true,
      publicUrl: PUBLIC,
      allowPublicLocalLogin: false,
    })
    expect(problem).toContain("ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC")
  })

  test.each([
    "http://localhost:8080",
    "https://localhost",
    "http://127.0.0.1:8080",
    "http://127.10.20.30",
    "http://[::1]:8080",
    "http://router.localhost",
  ])("loopback %s passes", (publicUrl) => {
    expect(isLoopbackUrl(publicUrl)).toBe(true)
    expect(adminAuthBootProblem({ ...base, publicUrl, allowPublicLocalLogin: false })).toBeNull()
  })

  test.each([
    "https://router.example.com",
    "http://192.168.1.50:8080",
    "http://0.0.0.0:8080",
    "http://10.0.0.5",
    "http://[::2]",
    "not a url",
  ])("anything not positively loopback (%s) is treated as public", (publicUrl) => {
    expect(isLoopbackUrl(publicUrl)).toBe(false)
    expect(
      adminAuthBootProblem({ ...base, publicUrl, allowPublicLocalLogin: false }),
    ).not.toBeNull()
  })
})
