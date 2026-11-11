/**
 * What the `request completed` line carries beyond method, path, status and duration.
 *
 * A session collision is invisible in production without it: two requests contending for one SDK
 * session look exactly like one request that died, until you can see they carried the same
 * `x-session-id`. And a fleet-wide symptom that turns out to be one box, one client build, or one
 * model is a different investigation from one that is not.
 */

import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { createLogger } from "../../../src/logging/logger"
import { deferFailureLine, requestLogger } from "../../../src/middleware/logger"
import type { AppEnv } from "../../../src/types"

/**
 * The completion line is written when the response settles (01.12), so a test reads the body —
 * exactly what a real client does — before it looks for the line.
 */
async function settled(response: Response | Promise<Response>): Promise<Response> {
  const resolved = await response
  await resolved.text()
  return resolved
}

async function completed(headers: Record<string, string>) {
  const lines: Record<string, unknown>[] = []
  const log = createLogger({
    level: "debug",
    write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  })
  const hono = new Hono<AppEnv>()
  hono.use("*", requestLogger(log))
  hono.post("/v1/chat/completions", (c) => c.json({ ok: true }))

  await settled(hono.request("/v1/chat/completions", { method: "POST", headers }))
  return lines.find((line) => line.msg === "request completed") ?? {}
}

describe("the request-completed line", () => {
  test("it names the conversation, so a collision is visible rather than inferred", async () => {
    const line = await completed({
      "X-Session-Id": "ses_abc",
      "x-parent-session-id": "ses_parent",
    })

    expect(line).toMatchObject({
      "x-session-id": "ses_abc",
      // A subagent runs in its own session, concurrently with its parent by design. Seeing both is
      // what distinguishes that from two turns of one conversation racing each other.
      "x-parent-session-id": "ses_parent",
    })
  })

  test("and who is asking, when the client says", async () => {
    const line = await completed({
      "x-opencode-client": "opencode/1.18.29",
      "x-opencode-host": "ovh-1a",
      "x-opencode-model": "claude-opus-5",
    })

    expect(line).toMatchObject({
      "x-opencode-client": "opencode/1.18.29",
      "x-opencode-host": "ovh-1a",
      "x-opencode-model": "claude-opus-5",
    })
  })

  test("a header the client did not send is absent, never a null", async () => {
    const line = await completed({ "x-session-id": "ses_abc" })

    expect(line).not.toHaveProperty("x-parent-session-id")
    expect(line).not.toHaveProperty("x-opencode-host")
  })

  test("nothing outside the allowlist is logged, whatever the request carried", async () => {
    const line = await completed({
      authorization: "Bearer mar_live_secret",
      "x-api-key": "sk-secret",
      "x-session-id": "ses_abc",
    })

    // An allowlist rather than "log the headers": the way to be sure no credential is logged is to
    // name the ones that are not.
    expect(JSON.stringify(line)).not.toContain("secret")
    expect(line).not.toHaveProperty("authorization")
  })

  test("a hostile value cannot become an unbounded log field", async () => {
    const line = await completed({ "x-session-id": "x".repeat(5_000) })

    expect(String(line["x-session-id"]).length).toBe(200)
  })

  test("the line still says what it always said", async () => {
    const line = await completed({})

    expect(line).toMatchObject({
      msg: "request completed",
      method: "POST",
      path: "/v1/chat/completions",
      status: 200,
    })
    expect(typeof line.durationMs).toBe("number")
  })
})

/**
 * Probe traffic. Fourteen hours of production held ~10k `/healthz` + `/readyz` lines at `info`,
 * burying the requests an operator opened the log to read.
 */
describe("quiet paths", () => {
  function probe(status: 200 | 302 | 503, quietPaths?: readonly string[]) {
    const lines: Record<string, unknown>[] = []
    const log = createLogger({
      level: "debug",
      write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
    })
    const hono = new Hono<AppEnv>()
    hono.use("*", requestLogger(log, quietPaths === undefined ? {} : { quietPaths }))
    hono.get("/readyz", (c) => c.json({ ok: status < 400 }, status))
    hono.get("/readyz/deep", (c) => c.json({ ok: true }))

    // `hono.request` is typed `Promise<Response> | Response`, so it cannot carry a `.then`;
    // awaiting it is the only form that holds for both branches.
    return async (path = "/readyz") => {
      await settled(hono.request(path))
      return lines.find((line) => line.msg === "request completed") ?? {}
    }
  }

  test("a failing probe keeps its normal level — that line is the point", async () => {
    const line = await probe(503, ["/readyz"])()

    expect(line).toMatchObject({ level: "info", path: "/readyz", status: 503 })
  })

  test("a successful probe logs at debug", async () => {
    expect(await probe(200, ["/healthz", "/readyz"])()).toMatchObject({ level: "debug" })
    expect(await probe(302, ["/readyz"])()).toMatchObject({ level: "debug" })
  })

  test("the match is exact: a path that merely starts like a probe is ordinary traffic", async () => {
    const line = await probe(200, ["/readyz"])("/readyz/deep")

    expect(line).toMatchObject({ level: "info", path: "/readyz/deep" })
  })

  test("nothing is quiet unless configured", async () => {
    expect(await probe(200)()).toMatchObject({ level: "info" })
  })

  test("at the default level a quiet probe emits no line at all", async () => {
    const lines: string[] = []
    const log = createLogger({ level: "info", write: (line) => void lines.push(line) })
    const hono = new Hono<AppEnv>()
    hono.use("*", requestLogger(log, { quietPaths: ["/healthz"] }))
    hono.get("/healthz", (c) => c.json({ ok: true }))

    await settled(hono.request("/healthz"))

    expect(lines).toHaveLength(0)
  })
})

describe("one transport line per request", () => {
  function harness() {
    const lines: Record<string, unknown>[] = []
    const log = createLogger({
      level: "debug",
      write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
    })
    const hono = new Hono<AppEnv>()
    hono.use("*", requestLogger(log))
    hono.post("/v1/messages", () => {
      throw new Error("refused")
    })
    hono.get("/v1/stream", (c) =>
      c.body("data: {}\n\n", 200, { "content-type": "text/event-stream" }),
    )
    // The shape `errorHandler` takes: hand the failure to the completion line, else log it here.
    hono.onError((err, c) => {
      const fields = { errorClass: err.name, errorCode: "translation_failed" }
      if (!deferFailureLine(c.req.raw, { level: "warn", fields }))
        log.warn("request failed", fields)
      return c.json({ error: err.message }, 400)
    })
    return { hono, lines }
  }

  test("a rejected request writes exactly one line, carrying the failure and the timing", async () => {
    const { hono, lines } = harness()

    await settled(
      hono.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-id": "ses_abc" },
      }),
    )

    // Production fingerprint: every rejection logged `request failed` and `request completed`.
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      level: "warn",
      msg: "request failed",
      component: "transport",
      method: "POST",
      path: "/v1/messages",
      status: 400,
      errorClass: "Error",
      errorCode: "translation_failed",
      "content-type": "application/json",
      "x-session-id": "ses_abc",
    })
    expect(typeof lines[0]?.durationMs).toBe("number")
  })

  test("a failure no request logger is tracking is not swallowed", () => {
    expect(
      deferFailureLine(new Request("http://router/v1/messages"), { level: "warn", fields: {} }),
    ).toBe(false)
  })

  test("a streamed response carries both its time-to-headers and its whole duration", async () => {
    const { hono, lines } = harness()

    await settled(hono.request("/v1/stream"))

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ msg: "request completed", streamed: true })
    expect(typeof lines[0]?.timeToHeadersMs).toBe("number")
    // Written at settle (01.12), so the duration is the stream's, not time-to-headers.
    expect(typeof lines[0]?.durationMs).toBe("number")
  })
})
