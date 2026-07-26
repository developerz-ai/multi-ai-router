import { describe, expect, test } from "bun:test"
import type { PoolSnapshot } from "../../src/services/routing"
import { account, jsonResponse, slowStream } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, MESSAGE, post, settle } from "./harness"

/**
 * The `translate` egress mode end to end: an Anthropic client dispatched to an openai-chat
 * account, streaming intact. `dataplane.test.ts` covers the non-streaming direction (M6a/M6b's
 * first landing); this file is the streaming half plus the error and usage guarantees that only
 * show up once bytes are actually flowing incrementally through a translator.
 *
 * Nothing here touches a network: `fetch` is `harness()`'s mocked upstream, same as every other
 * integration suite in this directory.
 */

function openRouterAccount(id = "or-1", overrides: Parameters<typeof account>[1] = {}) {
  return account(id, { provider: "openrouter", apiKey: "sk-or", cipher: CRYPTOR, ...overrides })
}

function openAiChunk(body: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: "chatcmpl-1", model: "gpt-4o", ...body })}\n\n`
}

const DONE = "data: [DONE]\n\n"

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let out = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += new TextDecoder().decode(value)
  }
  return out
}

describe("cross-dialect streaming (translate egress)", () => {
  test("an anthropic request against an openai-chat account comes back as Anthropic SSE with stop_reason and usage", async () => {
    const body =
      openAiChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] }) +
      openAiChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      openAiChunk({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 22 } }) +
      DONE
    const slow = slowStream([body])
    const { app, upstream, usage } = harness({
      accounts: [openRouterAccount()],
      responses: [() => slow.response],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    slow.release(0)
    slow.finish()
    const text = await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    // Addressed at the account's dialect, at the account's dialect's path.
    expect(upstream.calls[0]?.url).toContain("/chat/completions")
    // Anthropic's own event names and shape — never the openai-chat ones the account spoke.
    expect(text).toContain("event: message_start")
    expect(text).toContain("event: message_delta")
    expect(text).toContain("event: message_stop")
    expect(text).toContain('"stop_reason":"end_turn"')
    expect(text).toContain('"output_tokens":22')
    expect(text).toContain('"input_tokens":11')

    expect(usage.rows[0]).toMatchObject({ egressMode: "translate", outcome: "success" })
    expect(usage.rows[0]?.tokensIn).toBeGreaterThan(0)
    expect(usage.rows[0]?.tokensOut).toBeGreaterThan(0)
  })

  /**
   * The shape vLLM, SGLang, Fireworks and Together emit for parallel calls — both announced in one
   * chunk, arguments streamed per index afterwards — on the bytes a client actually reads. A reader
   * keeping only the block it opened last hands back `get_weather` with an empty `input` under
   * `"stop_reason":"tool_use"`, which no client can tell from a model that meant it.
   */
  test("parallel tool calls arrive whole when the upstream revisits an earlier index", async () => {
    const call = (index: number, args: string, named?: Record<string, unknown>) => ({
      index,
      ...named,
      function: { ...(named?.name === undefined ? {} : { name: named.name }), arguments: args },
    })
    const body =
      openAiChunk({
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                call(0, "", { id: "call_1", name: "get_weather" }),
                call(1, "", { id: "call_2", name: "lookup" }),
              ],
            },
          },
        ],
      }) +
      openAiChunk({ choices: [{ index: 0, delta: { tool_calls: [call(0, '{"city":"NY"}')] } }] }) +
      openAiChunk({ choices: [{ index: 0, delta: { tool_calls: [call(1, '{"q":"x"}')] } }] }) +
      openAiChunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
      DONE
    const slow = slowStream([body])
    const { app } = harness({ accounts: [openRouterAccount()], responses: [() => slow.response] })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    slow.release(0)
    slow.finish()
    const text = await res.text()
    await settle()

    expect(text).toContain('"name":"get_weather"')
    expect(text).toContain('"name":"lookup"')
    expect(text).toContain('"partial_json":"{\\"city\\":\\"NY\\"}"')
    expect(text).toContain('"partial_json":"{\\"q\\":\\"x\\"}"')
    expect(text).toContain('"stop_reason":"tool_use"')
    // One open block at a time: every start is closed before the next one opens.
    const boundaries = [...text.matchAll(/event: content_block_(start|stop)/g)].map((hit) => hit[1])
    expect(boundaries).toEqual(["start", "stop", "start", "stop"])
  })

  test("streams without buffering: the first translated event reaches the client before the upstream sends its next chunk", async () => {
    const first = openAiChunk({
      choices: [{ index: 0, delta: { role: "assistant", content: "partial" } }],
    })
    const second = openAiChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + DONE
    const slow = slowStream([first, second])
    const { app } = harness({ accounts: [openRouterAccount()], responses: [() => slow.response] })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    if (res.body === null) throw new Error("expected a body")
    const reader = res.body.getReader()

    slow.release(0)
    const early = new TextDecoder().decode((await reader.read()).value)
    // The first upstream chunk's own content reached the client...
    expect(early).toContain("event: message_start")
    expect(early).toContain('"text_delta"')
    // ...while the second upstream chunk is still gated. A relay that buffered the whole response
    // before writing anything would have nothing to hand back here at all — `reader.read()` above
    // would still be pending on the still-unreleased second chunk instead of resolving now.
    expect(early).not.toContain("message_stop")

    slow.release(1)
    slow.finish()
    const rest = await drain(reader)
    expect(rest).toContain("event: message_stop")
  })

  test("an upstream error from a translated account renders in the client's own dialect and names no account", async () => {
    const { app, upstream } = harness({
      accounts: [openRouterAccount("secret-account-id", { apiKey: "sk-shh" })],
      responses: [
        () =>
          jsonResponse(400, {
            error: {
              message: "temperature must be between 0 and 2",
              type: "invalid_request_error",
              code: "400",
            },
          }),
      ],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    const body = (await res.json()) as Record<string, unknown>
    const rendered = JSON.stringify(body)

    expect(res.status).toBe(400)
    expect(res.headers.get("content-type")).toBe("application/json")
    // Anthropic's error shape — the client asked `/v1/messages`, even though the account behind it
    // spoke openai-chat and answered in that shape.
    expect(body).toMatchObject({ type: "error", error: { type: "invalid_request_error" } })
    expect(rendered).toContain("temperature must be between 0 and 2")
    // The account's identity and credential never reach the client, translated or not.
    expect(rendered).not.toContain("secret-account-id")
    expect(rendered).not.toContain("sk-shh")
    expect(upstream.calls).toHaveLength(1)
  })
})

/**
 * The output ceiling is one field with two names, and no upstream accepts both. OpenAI renamed
 * `max_tokens` to `max_completion_tokens` and refuses the old one on every reasoning model it
 * sells; five of the compatible vendors here have never heard of the new one, and the ones that
 * merely ignore it generate unbounded instead of answering an error anybody can see.
 *
 * So the name is the **account's**, resolved per candidate like the model is
 * (docs/idea/06-protocol-translation.md#known-lossy-edges). These are the assertions that say the
 * caller's ceiling survives the conversion, whichever account answers.
 */
describe("the openai-chat output ceiling (translate egress)", () => {
  const CEILING_POOL_ID = "ceiling-pool"

  /** Priority order, so the failover walk below is the chain the test says it is. */
  const ceilingPool = (): PoolSnapshot => ({
    id: CEILING_POOL_ID,
    name: "ceiling",
    policy: "priority-failover",
    members: [
      { accountId: "oa", priority: 0 },
      { accountId: "or-1", priority: 1 },
    ],
  })

  const openAiAccount = (id = "oa") =>
    account(id, { provider: "openai-api", apiKey: "sk-o", cipher: CRYPTOR })

  const ok = () => jsonResponse(200, { usage: { prompt_tokens: 1, completion_tokens: 2 } })

  function sent(body: string | undefined): Record<string, unknown> {
    return JSON.parse(body ?? "{}") as Record<string, unknown>
  }

  test("an openai-api account is sent max_completion_tokens, and never the name it refuses", async () => {
    const { app, upstream } = harness({ accounts: [openAiAccount()], responses: [ok] })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    const body = sent(upstream.calls[0]?.body)
    // 64 is `MESSAGE`'s own `max_tokens` — the caller's ceiling, under the target's name for it.
    expect(body.max_completion_tokens).toBe(64)
    expect(body).not.toHaveProperty("max_tokens")
  })

  test("every other openai-chat vendor keeps max_tokens: the new name would drop the ceiling silently", async () => {
    const { app, upstream } = harness({ accounts: [openRouterAccount()], responses: [ok] })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    const body = sent(upstream.calls[0]?.body)
    expect(body.max_tokens).toBe(64)
    expect(body).not.toHaveProperty("max_completion_tokens")
  })

  test("a failover between two openai-chat accounts converts twice: each gets the name it reads", async () => {
    const { app, upstream, usage } = harness({
      accounts: [openAiAccount(), openRouterAccount()],
      pools: [ceilingPool()],
      scope: "pools",
      poolIds: [CEILING_POOL_ID],
      // The openai-api account's turn: a plain 429 is retryable, so the chain walks on.
      responses: [() => jsonResponse(429, {}), ok],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect(upstream.calls).toHaveLength(2)
    // The conversion is cached per target *shape*, not per target dialect. Cached by dialect alone,
    // the second account would be handed the first account's body — a field OpenRouter's upstream
    // model may never see, and no ceiling at all under the name it does read.
    expect(sent(upstream.calls[0]?.body).max_completion_tokens).toBe(64)
    expect(sent(upstream.calls[0]?.body)).not.toHaveProperty("max_tokens")
    expect(sent(upstream.calls[1]?.body).max_tokens).toBe(64)
    expect(sent(upstream.calls[1]?.body)).not.toHaveProperty("max_completion_tokens")
    expect(usage.rows.map((row) => row.accountId)).toEqual(["oa", "or-1"])
  })

  test("two accounts that agree are handed the same bytes: the ceiling adds no per-attempt drift", async () => {
    const { app, upstream } = harness({
      accounts: [openRouterAccount("or-1"), openRouterAccount("or-2")],
      pools: [
        {
          ...ceilingPool(),
          members: [
            { accountId: "or-1", priority: 0 },
            { accountId: "or-2", priority: 1 },
          ],
        },
      ],
      scope: "pools",
      poolIds: [CEILING_POOL_ID],
      responses: [() => jsonResponse(429, {}), ok],
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect(upstream.calls).toHaveLength(2)
    expect(upstream.calls[0]?.body).toBe(upstream.calls[1]?.body ?? "")
  })
})
