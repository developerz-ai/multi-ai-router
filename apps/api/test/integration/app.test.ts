import { describe, expect, test } from "bun:test"
import { CreditsExhaustedError, QuotaExhaustedError, VERSION } from "@multi-ai-router/core"
import { type AppDeps, createApp } from "../../src/app"
import { createLogger } from "../../src/logging/logger"
import { REQUEST_ID_HEADER } from "../../src/middleware/requestId"
import type { ReadinessProbes } from "../../src/services/health/readiness"
import { createLifecycle } from "../../src/services/shutdown/lifecycle"

/**
 * Exercises the real Hono app through `app.request(...)`. No database and no upstream: the
 * readiness probes are injected, which is the whole point of `createApp` taking them.
 */

interface Harness {
  readonly app: ReturnType<typeof createApp>
  readonly lines: string[]
}

function harness(probes: Partial<ReadinessProbes> = {}): Harness {
  const lines: string[] = []
  const deps: AppDeps = {
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    probes: {
      database: probes.database ?? (() => Promise.resolve(true)),
      accounts: probes.accounts ?? (() => Promise.resolve("ok")),
      claudeCli: probes.claudeCli ?? (() => Promise.resolve("platform_package")),
      shuttingDown: probes.shuttingDown ?? (() => false),
    },
  }
  return { app: createApp(deps), lines }
}

describe("GET /healthz", () => {
  test("is 200 whenever the process is serving, and names the build", async () => {
    const res = await harness().app.request("/healthz")

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok", version: VERSION })
  })

  test("stays 200 while the database is down — liveness is not readiness", async () => {
    const { app } = harness({ database: () => Promise.resolve(false) })

    expect((await app.request("/healthz")).status).toBe(200)
    expect((await app.request("/readyz")).status).toBe(503)
  })

  test("assigns a request id and echoes a safe supplied one", async () => {
    const { app } = harness()

    const assigned = await app.request("/healthz")
    expect(assigned.headers.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/)

    const echoed = await app.request("/healthz", { headers: { [REQUEST_ID_HEADER]: "req-42" } })
    expect(echoed.headers.get(REQUEST_ID_HEADER)).toBe("req-42")
  })

  test("logs one structured line carrying the request id", async () => {
    const { app, lines } = harness()
    await app.request("/healthz", { headers: { [REQUEST_ID_HEADER]: "req-42" } })

    const entry: unknown = JSON.parse(lines.at(-1) ?? "{}")
    expect(entry).toMatchObject({
      level: "info",
      msg: "request completed",
      component: "transport",
      requestId: "req-42",
      path: "/healthz",
      status: 200,
    })
  })
})

describe("GET /readyz", () => {
  test("is 200 with both checks green", async () => {
    const res = await harness().app.request("/readyz")

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: "ready",
      checks: { database: "ok", accounts: "ok", claudeCli: "platform_package" },
      reason: null,
    })
  })

  test("is 503 naming the failed check when the database is unreachable", async () => {
    const { app } = harness({ database: () => Promise.resolve(false) })
    const res = await app.request("/readyz")

    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({
      status: "not_ready",
      checks: { database: "fail", accounts: "ok" },
      reason: "database unreachable",
    })
  })

  test("is 503 shutting_down once a drain has been accepted, while /healthz stays 200", async () => {
    // The endpoint an orchestrator polls has to turn before the listener does, or the first thing
    // the load balancer learns is a refused connection. Liveness is unaffected: the process is up
    // and finishing what it has — restarting it now would truncate exactly what the drain protects.
    const lifecycle = createLifecycle()
    const { app } = harness({ shuttingDown: lifecycle.shuttingDown })

    expect((await app.request("/readyz")).status).toBe(200)

    lifecycle.begin()
    const res = await app.request("/readyz")

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      status: "shutting_down",
      // No probe ran, so there is nothing to report — a stale `ok` here would be a lie.
      checks: null,
      reason: "shutting down — draining in-flight requests",
    })
    expect((await app.request("/healthz")).status).toBe(200)
  })

  test("is 503 while draining even with every check green", async () => {
    const { app } = harness({
      shuttingDown: () => true,
      database: () => Promise.resolve(true),
      accounts: () => Promise.resolve("ok"),
    })

    expect((await app.request("/readyz")).status).toBe(503)
  })

  test("names the claude cli rung that won — two hosts can both 'find it' and differ", async () => {
    const { app } = harness({ claudeCli: () => Promise.resolve("env_override") })
    const res = await app.request("/readyz")

    expect(await res.json()).toMatchObject({ checks: { claudeCli: "env_override" } })
  })

  test("stays ready without a claude cli — API-key accounts do not need one", async () => {
    const { app } = harness({ claudeCli: () => Promise.resolve("missing") })
    const res = await app.request("/readyz")

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      status: "ready",
      checks: { claudeCli: "missing" },
      reason: "claude cli not found",
    })
  })

  test("stays ready with no accounts configured — a fresh install must be reachable", async () => {
    // The deadlock this avoids: gate readiness on accounts and a new deployment is never ready,
    // so nothing routes to the console that is the only way to add the first account.
    const { app } = harness({ accounts: () => Promise.resolve("none") })
    const res = await app.request("/readyz")

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      status: "ready",
      checks: { database: "ok", accounts: "none" },
      reason: "no accounts configured",
    })
  })

  test("stays ready when every account is blocked, and says so", async () => {
    const { app } = harness({ accounts: () => Promise.resolve("blocked") })
    const res = await app.request("/readyz")

    // Still 200: withholding traffic would take away the console the operator needs to fix it.
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      checks: { accounts: "blocked" },
      reason: "every account is unavailable",
    })
  })

  test("a throwing account probe reports blocked — unknown is not the same as fine", async () => {
    const { app } = harness({ accounts: () => Promise.reject(new Error("boom")) })
    const res = await app.request("/readyz")

    expect(await res.json()).toMatchObject({ checks: { accounts: "blocked" } })
    expect(await (await app.request("/readyz")).text()).not.toContain("boom")
  })

  test("treats a throwing probe as a failed check, not a 500", async () => {
    const { app } = harness({
      database: () => Promise.reject(new Error("ECONNREFUSED")),
    })
    const res = await app.request("/readyz")

    expect(res.status).toBe(503)
    expect(await res.text()).not.toContain("ECONNREFUSED")
  })
})

describe("unknown routes", () => {
  test("404 in the OpenAI error shape by default", async () => {
    const res = await harness().app.request("/nope")

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: {
        message: "Not found",
        type: "invalid_request_error",
        param: null,
        code: "not_found",
      },
    })
  })

  test("404 in the Anthropic error shape on the Anthropic ingress path", async () => {
    const res = await harness().app.request("/v1/messages")

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      type: "error",
      error: { type: "not_found_error", message: "Not found" },
    })
  })
})

describe("error handling", () => {
  test("a RouterError becomes its documented status — 402, never 429", async () => {
    const { app } = harness()
    app.get("/__test/credits", () => {
      throw new CreditsExhaustedError("account is out of credits")
    })

    const res = await app.request("/__test/credits")

    expect(res.status).toBe(402)
    expect(await res.json()).toEqual({
      error: {
        message: "account is out of credits",
        type: "invalid_request_error",
        param: null,
        code: "credits_exhausted",
      },
    })
  })

  test("a quota error renders 429 with Retry-After in the ingress dialect", async () => {
    const { app } = harness()
    app.post("/v1/messages", () => {
      throw new QuotaExhaustedError("every account is cooling down", { retryAfterSeconds: 90 })
    })

    const res = await app.request("/v1/messages", { method: "POST" })

    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("90")
    expect(await res.json()).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "every account is cooling down" },
    })
  })

  test("an unexpected error is a generic 500 that leaks nothing", async () => {
    const { app, lines } = harness()
    app.get("/__test/boom", () => {
      throw new Error("postgres://router:hunter2@postgres:5432 refused")
    })

    const res = await app.request("/__test/boom")
    const body = await res.text()

    expect(res.status).toBe(500)
    expect(body).not.toContain("hunter2")
    expect(JSON.parse(body)).toEqual({
      error: { message: "Internal server error", type: "server_error", param: null, code: null },
    })
    // The operator still gets the detail, on the log line rather than the wire.
    expect(lines.join("\n")).toContain("request failed")
  })
})
