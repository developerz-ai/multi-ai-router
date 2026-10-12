import { describe, expect, test } from "bun:test"
import { CODEX_RESPONSES_EGRESS, httpDriver } from "../../../src/providers"
import {
  collectResponsesStream,
  DEFAULT_RESPONSES_EGRESS,
  type TranslationContext,
  type TranslationDrop,
  translationPair,
} from "../../../src/services/translate"

/**
 * Production, 2026-10-04: a ChatGPT (Codex) account reached by `/v1/messages` or
 * `/v1/chat/completions` was sent the standard Responses body — `max_output_tokens`, `temperature`,
 * the client's `stream`, no `instructions` — which the Codex backend refuses outright. The surface's
 * rules come from its driver; the translator applies them and stays pure.
 */
function context(overrides: Partial<TranslationContext> = {}): TranslationContext {
  return { created: 1, model: "gpt-5.5", fallbackId: "req-1", ...overrides }
}

function sent(
  ingress: "anthropic" | "openai-chat",
  body: unknown,
  rules = CODEX_RESPONSES_EGRESS,
): { body: Record<string, unknown>; drops: TranslationDrop[] } {
  const pair = translationPair(ingress, "openai-responses")
  if (pair === null) throw new Error("no pair")
  const drops: TranslationDrop[] = []
  const out = pair.request(body, context({ responsesEgress: rules, onDrop: (d) => drops.push(d) }))
  return { body: out as Record<string, unknown>, drops }
}

const ANTHROPIC = {
  model: "gpt-5.5",
  max_tokens: 1024,
  temperature: 0.2,
  top_p: 0.9,
  messages: [{ role: "user", content: "hi" }],
}

const CHAT = {
  model: "gpt-5.5",
  max_completion_tokens: 512,
  temperature: 0.3,
  top_p: 0.8,
  messages: [{ role: "user", content: "hi" }],
}

describe("a Codex-ruled Responses surface", () => {
  test("anthropic ingress: refused params are gone, stream forced, instructions present", () => {
    const { body, drops } = sent("anthropic", ANTHROPIC)
    expect(body.max_output_tokens).toBeUndefined()
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
    expect(body.stream).toBe(true)
    expect(body.instructions).toBe("")
    expect(body.store).toBe(false)
    expect(drops.map((d) => d.field).sort()).toEqual(["max_output_tokens", "temperature", "top_p"])
    expect(JSON.stringify(drops)).not.toContain("1024")
  })

  test("a system prompt still becomes the instructions", () => {
    const { body } = sent("anthropic", { ...ANTHROPIC, system: "be terse", stream: false })
    expect(body.instructions).toBe("be terse")
    expect(body.stream).toBe(true)
  })

  test("chat ingress gets the same treatment", () => {
    const { body } = sent("openai-chat", CHAT)
    expect(body.max_output_tokens).toBeUndefined()
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
    expect(body.stream).toBe(true)
    expect(body.instructions).toBe("")
    expect(body.store).toBe(false)
  })

  test("an ordinary Responses surface is untouched by any of it", () => {
    const { body, drops } = sent("anthropic", ANTHROPIC, DEFAULT_RESPONSES_EGRESS)
    expect(body.max_output_tokens).toBe(1024)
    expect(body.temperature).toBe(0.2)
    expect(body.stream).toBeUndefined()
    expect(body.instructions).toBeUndefined()
    expect(drops).toHaveLength(0)
    const absent = translationPair("anthropic", "openai-responses")?.request(ANTHROPIC, context())
    expect((absent as Record<string, unknown>).max_output_tokens).toBe(1024)
  })
})

function sse(events: ReadonlyArray<readonly [string, unknown]>): Uint8Array {
  return new TextEncoder().encode(
    events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
  )
}

const MESSAGE = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "hello", annotations: [] }],
}

describe("collecting a forced stream for a client that did not ask for one", () => {
  test("the completed response is the body, its empty output filled from the done items", () => {
    const collected = collectResponsesStream(
      sse([
        ["response.created", { type: "response.created", response: { id: "resp_1" } }],
        [
          "response.output_item.done",
          { type: "response.output_item.done", output_index: 0, item: MESSAGE },
        ],
        [
          "response.completed",
          {
            type: "response.completed",
            response: {
              id: "resp_1",
              object: "response",
              status: "completed",
              model: "gpt-5.5",
              output: [],
              usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
            },
          },
        ],
      ]),
    ) as Record<string, unknown>
    expect(collected.id).toBe("resp_1")
    expect(collected.output).toEqual([MESSAGE])
    expect(collected.usage).toEqual({ input_tokens: 3, output_tokens: 1, total_tokens: 4 })

    const pair = translationPair("anthropic", "openai-responses")
    const client = pair?.response(collected, context()).body as Record<string, unknown>
    expect(client.content).toEqual([{ type: "text", text: "hello" }])
  })

  test("a terminal snapshot that already carries its output is kept as sent", () => {
    const other = { ...MESSAGE, id: "msg_2" }
    const collected = collectResponsesStream(
      sse([
        [
          "response.output_item.done",
          { type: "response.output_item.done", output_index: 0, item: MESSAGE },
        ],
        [
          "response.completed",
          { type: "response.completed", response: { id: "r", output: [other] } },
        ],
      ]),
    ) as Record<string, unknown>
    expect(collected.output).toEqual([other])
  })

  test("a stream that never reached a terminal event yields nothing to translate", () => {
    expect(
      collectResponsesStream(
        sse([
          [
            "response.output_item.done",
            { type: "response.output_item.done", output_index: 0, item: MESSAGE },
          ],
        ]),
      ),
    ).toBeNull()
  })

  test("a failed response is returned as the upstream stated it", () => {
    const failed = { id: "r", status: "failed", error: { code: "server_error", message: "boom" } }
    expect(
      collectResponsesStream(
        sse([["response.failed", { type: "response.failed", response: failed }]]),
      ),
    ).toEqual({ ...failed, output: [] })
  })
})

describe("the rules come from the driver", () => {
  test("the Codex surface declares them; an ordinary Responses surface answers the default", () => {
    const codex = httpDriver("openai-oauth")
    const openai = httpDriver("openai-api")
    if (codex === null || openai === null) throw new Error("missing driver")
    const at = (provider: "openai-oauth" | "openai-api") => ({
      id: "a",
      provider,
      dialect: "openai-responses" as const,
    })
    expect(codex.resolveResponsesEgress(at("openai-oauth"))).toBe(CODEX_RESPONSES_EGRESS)
    expect(openai.resolveResponsesEgress(at("openai-api"))).toBe(DEFAULT_RESPONSES_EGRESS)
  })

  test("the Codex surface declares stripLookaroundPatterns: true; the default surface does not", () => {
    expect(CODEX_RESPONSES_EGRESS.stripLookaroundPatterns).toBe(true)
    expect(DEFAULT_RESPONSES_EGRESS.stripLookaroundPatterns).toBe(false)
  })
})

/**
 * Production, 2026-10-11: the Codex backend compiles the JSON-Schema `pattern` field and refuses
 * any value containing a regex lookaround (`(?=`, `(?!`, `(?<=`, `(?<!`) with `400`. The client still
 * enforces the schema, so dropping the pattern degrades the request rather than corrupting it; the
 * router reports the drop by tool name and schema path, never by pattern value.
 */
const TOOL_WITH_LOOKAROUND = {
  model: "gpt-5.5",
  max_tokens: 256,
  messages: [{ role: "user", content: "log in" }],
  tools: [
    {
      name: "auth",
      description: "Auth helper",
      input_schema: {
        type: "object",
        properties: {
          login: {
            type: "string",
            // Lookaround — the backend refuses this; the field is reported and stripped.
            pattern: "(?=.*[A-Z]).{6,}",
          },
          password: {
            type: "string",
            // Negative lookbehind — same fate.
            pattern: "(?<!guest).+",
          },
          email: {
            type: "string",
            // No lookaround — kept verbatim.
            pattern: "^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$",
          },
          // `default` holds a lookaround, but it's data, not a schema pattern — must stay.
          fallback: {
            type: "string",
            default: "(?=.*[A-Z]).+",
          },
        },
        required: ["login"],
      },
    },
  ],
}

const LOOKAROUND_DROP =
  "the target account's Responses surface cannot compile regex lookarounds in tool schemas (tool `auth`)"

describe("a tool schema carrying a regex lookaround", () => {
  test("Codex egress strips the lookaround `pattern`s and reports the drops by tool + schema path", () => {
    const { body, drops } = sent("anthropic", TOOL_WITH_LOOKAROUND)
    const tools = body.tools as ReadonlyArray<{
      name?: string
      parameters?: {
        properties?: Record<string, { pattern?: string | undefined; default?: string | undefined }>
      }
    }>
    expect(tools).toHaveLength(1)
    const params = tools[0]?.parameters?.properties
    expect(params?.login?.pattern).toBeUndefined()
    expect(params?.password?.pattern).toBeUndefined()
    // The non-lookaround pattern survives.
    expect(params?.email?.pattern).toBe("^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$")
    // The `default` is data, not a schema pattern — left alone even when its content looks like one.
    expect(params?.fallback?.default).toBe("(?=.*[A-Z]).+")

    // The drop names the tool and the schema path; it never quotes the pattern value.
    const drop = drops.find((d) => d.field === "tools[0].parameters.properties.login.pattern")
    expect(drop).toBeDefined()
    expect(drop?.reason).toBe(LOOKAROUND_DROP)
    // Tool name surfaces in the reason (structural; never the pattern value).
    expect(drop?.reason).toContain("auth")
    expect(JSON.stringify(drops)).not.toContain("(?=.*[A-Z]")
    expect(JSON.stringify(drops)).not.toContain("(?<!guest")
  })

  test("the input body is not mutated — a second conversion to a default surface still has the pattern", () => {
    const input = JSON.parse(JSON.stringify(TOOL_WITH_LOOKAROUND)) as typeof TOOL_WITH_LOOKAROUND
    const codex = sent("anthropic", input, CODEX_RESPONSES_EGRESS)
    expect(
      (codex.body.tools?.[0]?.parameters?.properties?.login as { pattern?: string } | undefined)
        ?.pattern,
    ).toBeUndefined()

    // The same input, fed to a non-Codex surface: nothing changed upstream.
    const defaults = sent("anthropic", input, DEFAULT_RESPONSES_EGRESS)
    const params = (
      defaults.body.tools as ReadonlyArray<{
        parameters?: { properties?: Record<string, unknown> }
      }>
    )?.[0]?.parameters?.properties
    expect((params?.login as { pattern?: string } | undefined)?.pattern).toBe("(?=.*[A-Z]).{6,}")
    expect((params?.password as { pattern?: string } | undefined)?.pattern).toBe("(?<!guest).+")
  })

  test("an ordinary Responses surface keeps every `pattern`, including lookarounds", () => {
    const { body, drops } = sent("anthropic", TOOL_WITH_LOOKAROUND, DEFAULT_RESPONSES_EGRESS)
    expect(drops).toHaveLength(0)
    const params = (
      body.tools as ReadonlyArray<{ parameters?: { properties?: Record<string, unknown> } }>
    )?.[0]?.parameters?.properties
    expect((params?.login as { pattern?: string } | undefined)?.pattern).toBe("(?=.*[A-Z]).{6,}")
  })
})
