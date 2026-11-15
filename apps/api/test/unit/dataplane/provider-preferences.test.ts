import { describe, expect, test } from "bun:test"
import type { ProviderPreferences } from "@multi-ai-router/core"
import { withProviderPreferences } from "../../../src/services/dataplane/body/provider-preferences"

/**
 * An OpenRouter account's `provider` preferences, written into the body it is sent. The coding
 * account's case: DeepSeek V4.1 Flash, cheapest endpoint, fp8 or bf16 only — which a model slug's
 * `:floor` suffix could ask for the first half of and never the second.
 */

const CODING: ProviderPreferences = {
  sort: "price",
  quantizations: ["fp8", "bf16"],
  allow_fallbacks: true,
}

const encode = (text: string) => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const edit = (text: string, preferences: ProviderPreferences = CODING) =>
  decode(withProviderPreferences(encode(text), preferences))

const CLIENT = `{ "model": "deepseek/deepseek-v4.1-flash",\n  "messages": [{"role":"user","content":"hi"}], "stream": true }`

describe("withProviderPreferences, the merge first", () => {
  test("a body with no provider field gets the account's object, every other byte kept", () => {
    const sent = edit(CLIENT)
    expect(JSON.parse(sent).provider).toEqual(CODING)
    // Spliced, not re-serialized: the client's spacing and key order are still there, verbatim.
    expect(sent).toBe(
      `{"provider":{"sort":"price","quantizations":["fp8","bf16"],"allow_fallbacks":true}, ${CLIENT.slice(2)}`,
    )
  })

  test("a client-sent provider wins field by field; the account fills what it left out", () => {
    const body = JSON.stringify({
      model: "deepseek/deepseek-v4.1-flash",
      provider: { sort: "latency", require_parameters: true },
      messages: [],
    })
    expect(JSON.parse(edit(body)).provider).toEqual({
      sort: "latency",
      quantizations: ["fp8", "bf16"],
      allow_fallbacks: true,
      require_parameters: true,
    })
  })

  test("a client field the account also sets is the client's, including a falsy one", () => {
    const body = JSON.stringify({ provider: { allow_fallbacks: false, quantizations: ["fp16"] } })
    expect(JSON.parse(edit(body)).provider).toEqual({
      sort: "price",
      quantizations: ["fp16"],
      allow_fallbacks: false,
    })
  })

  test("`provider` appearing only inside the conversation is not the client's field", () => {
    const body = JSON.stringify({
      model: "m",
      messages: [{ role: "user", content: '{"provider": "x"}' }],
      tools: [{ type: "function", function: { name: "f", parameters: { provider: {} } } }],
    })
    const sent = JSON.parse(edit(body))
    expect(sent.provider).toEqual(CODING)
    expect(sent.messages).toEqual(JSON.parse(body).messages)
    expect(sent.tools).toEqual(JSON.parse(body).tools)
  })

  test("an empty object body still becomes valid JSON", () => {
    expect(JSON.parse(edit(" {  } "))).toEqual({ provider: CODING })
  })

  test("a client `provider` that is not an object is the client's, and is left for upstream", () => {
    for (const text of ['{"provider":null,"model":"m"}', '{"provider":"deepinfra"}']) {
      expect(edit(text)).toBe(text)
    }
  })

  test("a body that is not a JSON object is returned as the same bytes", () => {
    for (const text of ["[1,2]", "not json", ""]) {
      const bytes = encode(text)
      expect(withProviderPreferences(bytes, CODING)).toBe(bytes)
    }
  })
})
