import { describe, expect, test } from "bun:test"
import type { RateLookup } from "../../src/services/cost"
import { account, slowStream } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

/**
 * An `openrouter` attempt records the cost OpenRouter itself reports (`usage.cost`) as metered spend.
 * Prod 2026-11-19..26: 144k attempts on `openrouter-dz-coding-30d` (Nemotron 3 Ultra among them)
 * recorded `costEstimate: null, costBasis: "unknown"`, so the spend was invisible. Upstream mocked.
 */

const MODEL = "nvidia/nemotron-3-ultra-550b-a55b"
const CHAT = { model: MODEL, messages: [{ role: "user", content: "hi" }] }
const SSE = { headers: { "content-type": "text/event-stream" } }
const JSON_TYPE = { headers: { "content-type": "application/json" } }

const ALIAS = "nemotron"
const openrouter = () =>
  account("or", {
    provider: "openrouter",
    dialect: "openai-chat",
    cipher: CRYPTOR,
    modelAliases: { [ALIAS]: MODEL },
  })

const usage = (extra: string, prompt = 1000, completion = 50) =>
  `{"prompt_tokens":${prompt},"completion_tokens":${completion},"total_tokens":${prompt + completion}${extra}}`
const jsonBody = (extra: string, prompt?: number, completion?: number) =>
  `{"id":"gen-1","model":"${MODEL}","choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"ok"}}],"usage":${usage(extra, prompt, completion)}}`
const streamFrames = (extra: string) => [
  `data: {"id":"gen-1","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}\n\n`,
  `data: {"id":"gen-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n`,
  `data: {"id":"gen-1","choices":[],"usage":${usage(extra)}}\n\n`,
  "data: [DONE]\n\n",
]
const streamBody = (extra: string) => streamFrames(extra).join("")
const dataFrames = (text: string): Record<string, unknown>[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
type Usage = Record<string, unknown> | undefined
const usageOf = (holder: unknown): Usage => (holder as { usage?: Usage } | undefined)?.usage

async function row(
  response: () => Response,
  request: { readonly path?: string; readonly body?: object; readonly prices?: RateLookup } = {},
) {
  const { app, usage: sink } = harness({
    accounts: [openrouter()],
    responses: [response],
    ...(request.prices === undefined ? {} : { prices: request.prices }),
  })
  const res = await app.request(
    request.path ?? "/v1/chat/completions",
    post(JSON.stringify(request.body ?? CHAT), bearer()),
  )
  const text = await res.text()
  await settle()
  return { text, row: sink.rows.at(-1) }
}

describe("no figure OpenRouter can be held to: unknown, as before", () => {
  test("a JSON body without cost", async () => {
    const { row: recorded } = await row(() => new Response(jsonBody(""), JSON_TYPE))
    expect(recorded).toMatchObject({ tokensIn: 1000, costEstimate: null, costBasis: "unknown" })
  })

  test("a stream whose usage chunk carries a malformed cost", async () => {
    const { row: recorded } = await row(() => new Response(streamBody(',"cost":"0.5"'), SSE), {
      body: { ...CHAT, stream: true },
    })
    expect(recorded).toMatchObject({ tokensOut: 50, costEstimate: null, costBasis: "unknown" })
  })
})

describe("the reported cost is the row's metered cost", () => {
  test("non-streamed: the body comes back byte for byte and the row carries the figure", async () => {
    const body = jsonBody(',"cost":0.012345,"is_byok":false')
    const { text, row: recorded } = await row(() => new Response(body, JSON_TYPE))
    expect(text).toBe(body)
    expect(recorded).toMatchObject({
      provider: "openrouter",
      upstreamModel: MODEL,
      tokensIn: 1000,
      tokensOut: 50,
      costEstimate: "0.012345",
      costBasis: "metered",
    })
  })

  test("streamed: the final usage chunk's figure, the stream relayed untouched", async () => {
    const body = streamBody(',"cost":0.75')
    const { text, row: recorded } = await row(() => new Response(body, SSE), {
      body: { ...CHAT, stream: true },
    })
    expect(text).toBe(body)
    expect(recorded).toMatchObject({
      streamed: true,
      costEstimate: "0.750000",
      costBasis: "metered",
    })
  })

  test("a translated response states it as reported, not estimated", async () => {
    const { text, row: recorded } = await row(
      () => new Response(jsonBody(',"cost":0.75'), JSON_TYPE),
      { path: "/v1/messages", body: { ...CHAT, max_tokens: 64 } },
    )
    const stated = (JSON.parse(text) as { usage?: Record<string, unknown> }).usage
    expect(stated).toMatchObject({ cost: 0.75, cost_source: "reported", cost_basis: "metered" })
    expect(recorded?.costEstimate).toBe("0.750000")
  })

  test("a translated reported zero is stated, not dropped as a zero-token answer", async () => {
    const { text, row: recorded } = await row(
      () => new Response(jsonBody(',"cost":0', 0, 0), JSON_TYPE),
      { path: "/v1/messages", body: { ...CHAT, max_tokens: 64 } },
    )
    expect(recorded).toMatchObject({ costEstimate: "0.000000", costBasis: "metered" })
    expect(usageOf(JSON.parse(text))).toMatchObject({
      cost: 0,
      cost_source: "reported",
      cost_basis: "metered",
    })
  })

  test("translated SSE: a usage chunk arriving after the finish chunk is the one stated", async () => {
    const slow = slowStream(streamFrames(',"cost":0.75'))
    slow.release(0)
    slow.release(1)
    const { app, usage: sink } = harness({
      accounts: [openrouter()],
      responses: [() => slow.response],
    })
    const res = await app.request(
      "/v1/messages",
      post(JSON.stringify({ ...CHAT, max_tokens: 64, stream: true }), bearer()),
    )
    const reader = res.body?.getReader()
    if (reader === undefined) throw new Error("missing body")
    let text = new TextDecoder().decode((await reader.read()).value)
    slow.release(2)
    slow.release(3)
    slow.finish()
    for (let step = await reader.read(); !step.done; step = await reader.read())
      text += new TextDecoder().decode(step.value)
    await settle()
    const delta = dataFrames(text).find((frame) => frame.type === "message_delta")
    expect(usageOf(delta)).toMatchObject({ cost: 0.75, cost_source: "reported" })
    expect(sink.rows.at(-1)).toMatchObject({ costEstimate: "0.750000", costBasis: "metered" })
  })

  test("an operator override for the upstream model wins over the reported figure", async () => {
    // Priced only under the post-alias upstream id: the client's alias must never find a rate.
    const override: RateLookup = (provider, model) =>
      provider === "openrouter" && model === MODEL
        ? { inputPerMtok: 1, outputPerMtok: 2, cacheReadPerMtok: 1, cacheWritePerMtok: 0 }
        : null
    const { text, row: recorded } = await row(
      () => new Response(jsonBody(',"cost":0.75'), JSON_TYPE),
      { path: "/v1/messages", body: { ...CHAT, model: ALIAS, max_tokens: 64 }, prices: override },
    )
    expect(recorded).toMatchObject({
      model: ALIAS,
      upstreamModel: MODEL,
      costEstimate: "0.001100",
      costBasis: "metered",
    })
    expect(usageOf(JSON.parse(text))).toMatchObject({
      cost: 0.0011,
      cost_source: "estimated",
      cost_basis: "metered",
    })
  })
})
