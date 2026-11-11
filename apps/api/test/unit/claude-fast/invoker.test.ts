import { describe, expect, test } from "bun:test"
import { createFastInvoker } from "../../../src/providers/claude-fast/invoker"
import { reportFastQuota } from "../../../src/providers/claude-fast/quota"
import { fastFailureOf } from "../../../src/providers/claude-fast/response"
import { createSdkConcurrency } from "../../../src/providers/claude-sdk/concurrency"
import { classifySdkFailure } from "../../../src/providers/claude-sdk/errors"
import type { SdkInvocation } from "../../../src/providers/claude-sdk/invoke"

const credential = {
  accessToken: "selected-account-secret",
  expiresAt: Date.now() + 3600000,
  deviceId: "a".repeat(64),
  accountUuid: "11111111-1111-4111-8111-111111111111",
}
const event = (value: object) => `data: ${JSON.stringify(value)}\n\n`
const wire = [
  event({
    type: "message_start",
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [],
      usage: { input_tokens: 3, cache_read_input_tokens: 8 },
    },
  }),
  event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
  event({ type: "content_block_stop", index: 0 }),
  event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
  event({ type: "message_stop" }),
].join("")
function input(stream = true): SdkInvocation {
  return {
    accountId: "account",
    configDir: "/isolated/account",
    apiKeyId: "key",
    sessionKey: "session",
    model: "claude-opus-5",
    body: Buffer.from(
      JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 64,
        stream,
        messages: [{ role: "user", content: "hello" }],
      }),
    ),
    signal: new AbortController().signal,
    session: { kind: "fresh", reason: "no-session" },
    clientHeaders: new Headers({
      authorization: "Bearer client-secret",
      "x-api-key": "client-key",
    }),
  }
}
function setup(
  options: {
    fresh?: boolean
    expired?: boolean
    status?: number
    body?: string
    contentType?: string
    model?: string | null
  } = {},
) {
  const concurrency = createSdkConcurrency({ global: 2, perAccount: 2 })
  const requests: Request[] = []
  let fallback = 0
  const invoke = createFastInvoker({
    concurrency,
    errorMaxBytes: 4096,
    credential: async () =>
      options.fresh === false
        ? null
        : options.expired
          ? { ...credential, expiresAt: Date.now() + 60_000 }
          : credential,
    resolveModel: () => (options.model === undefined ? "claude-opus-5" : options.model),
    sdk: async () => {
      fallback++
      return new Response("sdk")
    },
    fetch: async (request) => {
      requests.push(request)
      return new Response(options.body ?? wire, {
        status: options.status ?? 200,
        headers: { "content-type": options.contentType ?? "text/event-stream" },
      })
    },
  })
  return {
    invoke,
    concurrency,
    requests,
    get fallback() {
      return fallback
    },
  }
}
describe("Claude fast invoker", () => {
  test("warm streaming inference relays exact bytes with selected auth and no SDK", async () => {
    const h = setup()
    const response = await h.invoke(input())
    expect(h.concurrency.inFlight).toBe(1)
    expect(await response.text()).toBe(wire)
    expect(h.concurrency.inFlight).toBe(0)
    expect(h.fallback).toBe(0)
    const request = h.requests[0]
    expect(request?.url).toBe("https://api.anthropic.com/v1/messages?beta=true")
    expect(request?.headers.get("authorization")).toBe(`Bearer ${credential.accessToken}`)
    expect(request?.headers.has("x-api-key")).toBe(false)
    expect(request?.headers.get("x-claude-code-sandy-plover")).toBe("[]")
    expect(request?.headers.get("anthropic-beta")).toContain("tool-provenance-2026-10-26")
    expect(request?.redirect).toBe("manual")
  })
  test("nonstream folds usage and content, releases its permit", async () => {
    const h = setup()
    const response = await h.invoke(input(false))
    const body = (await response.json()) as {
      content: readonly { type: string; text: string }[]
      usage: { cache_read_input_tokens: number; output_tokens: number }
    }
    expect(body.content).toEqual([{ type: "text", text: "ok" }])
    expect(body.usage.cache_read_input_tokens).toBe(8)
    expect(body.usage.output_tokens).toBe(1)
    expect(h.concurrency.inFlight).toBe(0)
  })
  test("missing credentials or unresolved models use the SDK once before HTTP", async () => {
    for (const options of [{ fresh: false }, { model: null }]) {
      const h = setup(options)
      expect(await (await h.invoke(input())).text()).toBe("sdk")
      expect(h.requests).toHaveLength(0)
      expect(h.fallback).toBe(1)
    }
  })
  test("near-expiry credentials stay with SDK and context tags become beta headers", async () => {
    const cold = setup({ expired: true })
    expect(await (await cold.invoke(input())).text()).toBe("sdk")
    expect(cold.requests).toHaveLength(0)
    const warm = setup({ model: "claude-opus-5[1m]" })
    const response = await warm.invoke(input())
    const request = warm.requests[0]
    if (!request) throw new Error("missing direct request")
    expect(request.headers.get("anthropic-beta")).toContain("context-1m-2025-08-07")
    expect(JSON.parse(await request.text()).model).toBe("claude-opus-5")
    await response.body?.cancel()
  })
  test("upstream failures cannot echo a credential and do not retry via SDK", async () => {
    const h = setup({ status: 401, body: `authentication failed ${credential.accessToken}` })
    const response = await h.invoke(input())
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain(credential.accessToken)
    expect(h.fallback).toBe(0)
    expect(h.concurrency.inFlight).toBe(0)
  })
  test("rejects redirects and truncated nonstream responses", async () => {
    for (const options of [
      { status: 302 },
      { body: wire.replace(event({ type: "message_stop" }), "") },
    ]) {
      const h = setup(options)
      expect((await h.invoke(input(false))).status).toBe(502)
      expect(h.concurrency.inFlight).toBe(0)
    }
  })
  test("a successful HTTP status with a non-SSE body is a safe upstream failure", async () => {
    for (const stream of [true, false]) {
      const h = setup({ contentType: "text/html", body: "<html>private upstream error</html>" })
      const response = await h.invoke(input(stream))
      expect(response.status).toBe(502)
      expect(await response.text()).not.toContain("private upstream error")
      expect(h.fallback).toBe(0)
      expect(h.concurrency.inFlight).toBe(0)
    }
  })
  test("nonstream refuses malformed event lifecycles instead of returning partial success", async () => {
    for (const body of [
      wire.replace(
        event({ type: "message_stop" }),
        `data: not-json\n\n${event({ type: "message_stop" })}`,
      ),
      wire + event({ type: "message_start", message: {} }),
      wire.replace(
        event({ type: "content_block_stop", index: 0 }),
        event({ type: "content_block_stop", index: 9 }),
      ),
      wire.replace(
        event({ type: "message_stop" }),
        event({ type: "message_stop" }) + event({ type: "message_stop" }),
      ),
    ]) {
      const h = setup({ body })
      expect((await h.invoke(input(false))).status).toBe(502)
      expect(h.concurrency.inFlight).toBe(0)
      expect(h.fallback).toBe(0)
    }
  })
  test("HTTP failure status remains structured for billing and cooling", async () => {
    for (const status of [400, 402, 403, 429, 500, 529]) {
      const h = setup({ status, body: "upstream unavailable" })
      const response = await h.invoke(input())
      expect(response.status).toBe(status === 403 ? 401 : status === 500 ? 502 : status)
      expect(h.fallback).toBe(0)
    }
  })
  test("cancellation releases a streaming permit", async () => {
    const h = setup()
    const response = await h.invoke(input())
    await response.body?.cancel()
    expect(h.concurrency.inFlight).toBe(0)
  })
  test("parallel child histories do not serialize or combine", async () => {
    const h = setup()
    const responses = await Promise.all([h.invoke(input()), h.invoke(input())])
    expect(h.concurrency.inFlight).toBe(2)
    expect(h.requests).toHaveLength(2)
    await Promise.all(responses.map((r) => r.text()))
    expect(h.concurrency.inFlight).toBe(0)
  })
  test("credentials are read after queued admission and SDK fallback does not hold the slot", async () => {
    let admitted = false
    let held = false
    let directCalls = 0
    const invoke = createFastInvoker({
      concurrency: {
        acquire: async () => {
          admitted = true
          held = true
          return {
            release: () => {
              held = false
            },
          }
        },
        inFlight: 0,
        queued: 0,
        inFlightFor: () => 0,
      },
      credential: async () => (admitted ? null : credential),
      resolveModel: () => "claude-opus-5",
      errorMaxBytes: 4096,
      sdk: async () => {
        expect(held).toBe(false)
        return new Response("sdk after queue")
      },
      fetch: async () => {
        directCalls++
        return new Response(wire, { headers: { "content-type": "text/event-stream" } })
      },
    })
    expect(await (await invoke(input())).text()).toBe("sdk after queue")
    expect(directCalls).toBe(0)
    expect(held).toBe(false)
  })
  test("a completed empty upstream refusal remains a valid Messages response", async () => {
    const refusal = [
      event({
        type: "message_start",
        message: {
          id: "msg_refusal",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [],
          usage: { input_tokens: 57, output_tokens: 0 },
        },
      }),
      event({
        type: "message_delta",
        delta: { stop_reason: "refusal", stop_details: { type: "refusal" } },
        usage: { output_tokens: 0 },
      }),
      event({ type: "message_stop" }),
    ].join("")
    const h = setup({ body: refusal })
    const response = await h.invoke(input(false))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      type: "message",
      content: [],
      stop_reason: "refusal",
      stop_details: { type: "refusal" },
      usage: { output_tokens: 0 },
    })
    expect(h.fallback).toBe(0)
    expect(h.concurrency.inFlight).toBe(0)
  })
  test("reports included windows separately from rejected overage", () => {
    const values: unknown[] = []
    reportFastQuota(
      new Headers({
        "anthropic-ratelimit-unified-5h-status": "allowed",
        "anthropic-ratelimit-unified-5h-utilization": "0.23",
        "anthropic-ratelimit-unified-overage-status": "rejected",
      }),
      (v) => values.push(v),
    )
    expect(values).toEqual([
      {
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: 0.23,
        resetsAt: undefined,
        overageStatus: "rejected",
        overageResetsAt: undefined,
        utilizationSource: "continuous",
      },
    ])
  })
})

describe("Claude fast invoker: forced tool choice (#370)", () => {
  const weather = { name: "weather", input_schema: { type: "object" } }
  const search = { name: "search", input_schema: { type: "object" } }
  function forced(stream: boolean): SdkInvocation {
    return {
      ...input(stream),
      model: "claude-opus-5-5",
      body: Buffer.from(
        JSON.stringify({
          model: "claude-opus-5-5",
          max_tokens: 64,
          stream,
          tools: [weather, search],
          tool_choice: { type: "tool", name: "search" },
          thinking: { type: "disabled" },
          messages: [{ role: "user", content: "hello" }],
        }),
      ),
    }
  }
  const toolUseWire = [
    event({
      type: "message_start",
      message: {
        id: "msg_tool",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        usage: { input_tokens: 3 },
      },
    }),
    event({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "search", input: {} },
    }),
    event({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"q":"x"}' },
    }),
    event({ type: "content_block_stop", index: 0 }),
    event({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 1 },
    }),
    event({ type: "message_stop" }),
  ].join("")

  test("the forwarded body of an adapted request forces nothing", async () => {
    const h = setup({ body: toolUseWire })
    const response = await h.invoke(forced(false))
    expect(response.status).toBe(200)
    const sent = JSON.parse((await h.requests[0]?.text()) ?? "{}")
    expect(sent.tool_choice).toEqual({ type: "auto" })
    expect(sent.tools).toEqual([search])
    expect(sent).not.toHaveProperty("thinking")
    const body = (await response.json()) as { content: { type: string; name?: string }[] }
    expect(body.content[0]).toMatchObject({ type: "tool_use", name: "search" })
  })

  test("a nonstream 200 without the forced call fails as forced-tool-unmet", async () => {
    const h = setup()
    let thrown: unknown
    try {
      await h.invoke(forced(false))
    } catch (error) {
      thrown = error
    }
    const failure = classifySdkFailure(thrown)
    expect(failure.classification).toMatchObject({
      kind: "server-error",
      status: 502,
      retryable: true,
      signal: "claude-sdk:forced-tool-unmet",
    })
    expect(h.concurrency.inFlight).toBe(0)
    expect(h.fallback).toBe(0)
  })

  test("a streaming adapted request is relayed untouched", async () => {
    const h = setup()
    const response = await h.invoke(forced(true))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(wire)
    expect(JSON.parse((await h.requests[0]?.text()) ?? "{}").tool_choice).toEqual({ type: "auto" })
  })

  test("an upstream 400's scrubbed words reach the failure, never the client body", async () => {
    const said = `tool_choice forced is not supported with this model; credential ${credential.accessToken}`
    const h = setup({
      status: 400,
      body: JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: said },
      }),
    })
    const response = await h.invoke(forced(false))
    expect(response.status).toBe(400)
    const client = await response.text()
    expect(client).not.toContain("tool_choice forced is not supported")
    expect(client).not.toContain(credential.accessToken)
    const failure = fastFailureOf(response)
    expect(failure?.classification).toMatchObject({
      kind: "invalid-request",
      status: 400,
      signal: "claude-sdk:api-status-400",
    })
    expect(failure?.classification.message).toContain("tool_choice forced is not supported")
    expect(failure?.classification.message).not.toContain(credential.accessToken)
  })
})
