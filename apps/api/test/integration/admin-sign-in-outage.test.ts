import { describe, expect, test } from "bun:test"
import { AdminAuthError } from "@multi-ai-router/core"
import { Hono } from "hono"
import { ADMIN_AUTH_BASE_PATH, adminAuthRoutes } from "../../src/routes/admin/auth"
import { type AdminAuthService, AdminAuthUnavailableError } from "../../src/services/admin-auth"
import type { AppEnv } from "../../src/types"

/** A sign-in the router could not judge is an outage, not a wrong password, and leaves a log line. */
function mount(service: Partial<AdminAuthService>) {
  const lines: { level: string; msg: string; fields: Record<string, unknown> }[] = []
  const log = (level: string) => (msg: string, fields: Record<string, unknown>) =>
    void lines.push({ level, msg, fields })
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("log", { error: log("error"), warn: log("warn"), info: log("info") } as never)
    await next()
  })
  app.route(
    ADMIN_AUTH_BASE_PATH,
    adminAuthRoutes({
      service: {
        methods: async () => ({ oidc: true, local: true }),
        ...service,
      } as AdminAuthService,
      trustProxy: false,
      sessionCookieInsecure: true,
    }),
  )
  return { app, lines }
}

const refuse = (error: unknown) => () => Promise.reject(error)
const login = (app: Hono<AppEnv>) =>
  app.request(`${ADMIN_AUTH_BASE_PATH}/login`, {
    method: "POST",
    body: JSON.stringify({ password: "x" }),
  })

describe("sign-in when a dependency is down", () => {
  for (const [name, error] of [
    [
      "the throttle store",
      new AdminAuthUnavailableError({ cause: new Error("connect ECONNREFUSED") }),
    ],
    ["the credential store", new Error("connect ECONNREFUSED")],
  ] as const) {
    test(`password login: ${name} down is a 503 with Retry-After and a logged reason`, async () => {
      const { app, lines } = mount({ completeLocalLogin: refuse(error) })
      const res = await login(app)
      expect(res.status).toBe(503)
      expect(res.headers.get("retry-after")).toBe("5")
      expect(await res.json()).toMatchObject({
        error: { code: "admin_auth_unavailable", router: { wall: "clock", retryable: true } },
      })
      expect(lines[0]).toMatchObject({
        level: "error",
        fields: { door: "local", reason: expect.stringContaining("ECONNREFUSED") },
      })
    })
  }

  test("a wrong password is still a 401 and logs nothing", async () => {
    const { app, lines } = mount({ completeLocalLogin: refuse(new AdminAuthError("no")) })
    expect((await login(app)).status).toBe(401)
    expect(lines).toEqual([])
  })

  test("an unreachable IdP at /oidc/start is a 503, never a generic 500", async () => {
    const { app, lines } = mount({
      startLogin: refuse(new Error("discovery endpoint returned 502")),
    })
    const res = await app.request(`${ADMIN_AUTH_BASE_PATH}/oidc/start`)
    expect(res.status).toBe(503)
    expect(lines[0]?.fields.reason).toContain("discovery endpoint returned 502")
  })

  test("the callback tells an outage from a refusal", async () => {
    const path = `${ADMIN_AUTH_BASE_PATH}/oidc/callback?code=c&state=s`
    const outage = mount({ completeLogin: refuse(new AdminAuthUnavailableError()) })
    expect((await outage.app.request(path)).status).toBe(503)
    const refused = mount({ completeLogin: refuse(new AdminAuthError("no")) })
    expect((await refused.app.request(path)).status).toBe(401)
  })

  test("the IdP's own refusal is logged by code, and junk is not echoed", async () => {
    const { app, lines } = mount({})
    const path = `${ADMIN_AUTH_BASE_PATH}/oidc/callback?error=`
    expect((await app.request(`${path}access_denied`)).status).toBe(400)
    expect((await app.request(`${path}${encodeURIComponent("<b>x y</b>")}`)).status).toBe(400)
    expect(lines.map((line) => line.fields.idpError)).toEqual(["access_denied", "unrecognized"])
  })
})
