import { afterEach, describe, expect, test } from "bun:test"
import { httpDriver } from "../../src/providers/registry"
import { runAttempt } from "../../src/services/dataplane/attempt"
import type { StreamDeadlines } from "../../src/services/dataplane/upstream-deadline"
import { account, cipher } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post } from "./harness"

/**
 * The streaming deadlines through Bun's real `fetch` and a local stub upstream: the abort reaches
 * the socket, a first-byte expiry is a `timeout` failure (failover-eligible: nothing was sent), and
 * an idle expiry errors the body the relay forwards. Nothing leaves the host.
 */

const openAi = (() => {
  const driver = httpDriver("openai-api")
  if (driver === null) throw new Error("openai-api driver missing")
  return driver
})()

describe("runAttempt against a real socket", () => {
  let server: ReturnType<typeof Bun.serve> | undefined
  afterEach(() => {
    server?.stop(true)
    server = undefined
  })

  function attempt(url: string, stream: StreamDeadlines | undefined, timeoutMs = 60_000) {
    const target = account("a", { provider: "openai-api", baseUrl: url })
    return runAttempt({
      plan: {
        account: target,
        driver: openAi,
        dialect: "openai-chat",
        url: new URL(`${url}/chat/completions`),
        upstreamModel: "m",
      },
      method: "POST",
      clientHeaders: new Headers({ "content-type": "application/json" }),
      body: new TextEncoder().encode('{"model":"m","stream":true}'),
      fetch: (request) => fetch(request),
      cipher: cipher(),
      timeoutMs,
      ...(stream === undefined ? {} : { stream }),
    })
  }

  test("an upstream that never answers is a timeout failure inside the first-byte window", async () => {
    server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
    const started = performance.now()
    const outcome = await attempt(server.url.origin, {
      firstByteMs: 150,
      idleMs: 5_000,
      totalMs: 60_000,
    })
    expect(outcome.kind).toBe("failure")
    expect(outcome.kind === "failure" && outcome.failure.kind).toBe("timeout")
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  test("an upstream that stalls mid-stream errors the relayed body with a TimeoutError", async () => {
    server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: first\n\n"))
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    })
    const outcome = await attempt(server.url.origin, {
      firstByteMs: 5_000,
      idleMs: 150,
      totalMs: 60_000,
    })
    expect(outcome.kind).toBe("success")
    if (outcome.kind !== "success") return
    const reader = outcome.response.body?.getReader()
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("data: first\n\n")
    const failure = await reader?.read().then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure instanceof Error && failure.name).toBe("TimeoutError")
  })

  test("a non-streamed attempt keeps the one total deadline: no first-byte clock", async () => {
    server = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(300)
        return Response.json({ ok: true })
      },
    })
    const outcome = await attempt(server.url.origin, undefined)
    expect(outcome.kind).toBe("success")
  })
})

describe("the chain: a hung upstream fails over, a stalled stream fails honestly", () => {
  const STREAM = JSON.stringify({
    model: "claude-opus-5",
    max_tokens: 64,
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  })

  function sse(): Response {
    const events = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]
    return new Response(events.join(""), { headers: { "content-type": "text/event-stream" } })
  }

  test("no headers inside the first-byte window: the next account serves, the client sees one answer", async () => {
    const setup: { upstream?: ReturnType<typeof harness>["upstream"] } = {}
    const hung = () =>
      new Promise<Response>((_, reject) => {
        const signal = setup.upstream?.calls.at(-1)?.signal
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    const built = harness({
      accounts: [
        account("a", { apiKey: "sk-a", cipher: CRYPTOR }),
        account("b", { apiKey: "sk-b", cipher: CRYPTOR }),
      ],
      responses: [hung, sse],
      upstreamStream: { firstByteMs: 100, idleMs: 5_000, totalMs: 60_000 },
    })
    setup.upstream = built.upstream
    const res = await built.app.request("/v1/messages", post(STREAM, bearer()))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("message_stop")
    expect(built.upstream.calls).toHaveLength(2)
    expect(built.usage.rows.map((row) => row.outcome)).toContain("upstream_timeout")
  })

  test("a stream that stalls after its first bytes is not retried: one call, an upstream_timeout row", async () => {
    const stalled = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
              ),
            )
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    const built = harness({
      accounts: [
        account("a", { apiKey: "sk-a", cipher: CRYPTOR }),
        account("b", { apiKey: "sk-b", cipher: CRYPTOR }),
      ],
      responses: [stalled, sse],
      upstreamStream: { firstByteMs: 5_000, idleMs: 100, totalMs: 60_000 },
    })
    const res = await built.app.request("/v1/messages", post(STREAM, bearer()))
    expect(res.status).toBe(200)
    await res.text().catch(() => "")
    await Bun.sleep(20)
    expect(built.upstream.calls).toHaveLength(1)
    expect(built.usage.rows.at(-1)?.outcome).toBe("upstream_timeout")
  })
})
