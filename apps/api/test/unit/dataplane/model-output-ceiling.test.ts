import { expect, test } from "bun:test"
import type { ModelDescriptor } from "@multi-ai-router/core"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import { modelOutputCeiling } from "../../../src/services/dataplane/model-output-ceiling"
import { createTranslatedRequestBody } from "../../../src/services/dataplane/translate-body"
import { translationPair } from "../../../src/services/translate"
import { account, catalog, cipher, mockUpstream, usageSink } from "./fixtures"

function descriptor(id: string, maxOutputTokens: number | null): ModelDescriptor {
  return {
    id,
    maxOutputTokens,
    contextTokens: null,
    contextSource: "upstream",
    listingSource: "upstream",
    resolvedModel: null,
  }
}
const key = {
  id: "key",
  name: "test",
  prefix: "test",
  scope: { kind: "all" as const },
  rateLimitRequests: null,
  rateLimitWindowSeconds: null,
  expiresAt: null,
}
const context = { created: 1, model: "alias", fallbackId: "test", defaultMaxTokens: 1234 }

test("the selected account's actual upstream alias gets its warm ceiling and preserves explicit client limit", async () => {
  const cryptor = cipher(),
    queries: [string, string][] = []
  const upstream = mockUpstream([
    () =>
      new Response(JSON.stringify({ type: "message", content: [], stop_reason: "end_turn" }), {
        headers: { "content-type": "application/json" },
      }),
  ])
  const dispatcher = createDispatcher({
    catalog: catalog([
      account("selected", { cipher: cryptor, modelAliases: { alias: "actual-model" } }),
    ]),
    cipher: cryptor,
    health: createHealthStore(),
    usage: usageSink(),
    fetch: upstream.fetch,
    modelMetadata: {
      describe: (id, model) => {
        queries.push([id, model])
        return descriptor(model, 32000)
      },
    },
    options: { translation: { defaultMaxTokens: 1234 } },
  })
  for (const ceiling of [undefined, 77]) {
    const response = await dispatcher.dispatch({
      key,
      requestId: crypto.randomUUID(),
      ingress: "openai-chat",
      request: new Request("http://router.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "alias",
          messages: [{ role: "user", content: "hi" }],
          ...(ceiling === undefined ? {} : { max_completion_tokens: ceiling }),
        }),
      }),
    })
    expect(response.status).toBe(200)
    await response.text()
  }
  expect(queries).toEqual([
    ["selected", "actual-model"],
    ["selected", "actual-model"],
  ])
  expect(upstream.calls.map((call) => JSON.parse(call.body))).toEqual([
    expect.objectContaining({ model: "actual-model", max_tokens: 32000 }),
    expect.objectContaining({ model: "actual-model", max_tokens: 77 }),
  ])
  expect(upstream.calls.every((call) => call.headers.get("x-api-key") === "sk-selected")).toBe(true)
})

test("conversion cache separates candidate ceilings and reuses equal-cap shapes", () => {
  const pair = translationPair("openai-chat", "anthropic")
  if (!pair) throw new Error("Missing pair")
  const source = new TextEncoder().encode(
    JSON.stringify({ model: "alias", messages: [{ role: "user", content: "hi" }] }),
  )
  const converted = createTranslatedRequestBody(source, context)
  const read = (model: string, ceiling?: number) =>
    JSON.parse(new TextDecoder().decode(converted.bodyFor(pair, model, "max_tokens", ceiling)))
  expect(read("account-a-model", 16000)).toMatchObject({
    model: "account-a-model",
    max_tokens: 16000,
  })
  expect(read("account-b-model", 32000)).toMatchObject({
    model: "account-b-model",
    max_tokens: 32000,
  })
  expect(read("account-c-model", 16000)).toMatchObject({
    model: "account-c-model",
    max_tokens: 16000,
  })
  expect(read("unknown-model")).toMatchObject({ max_tokens: 1234 })
})

test("unknown, invalid, unsourced, and mismatched model ceilings use the configured fallback", () => {
  for (const ceiling of [
    null,
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expect(
      modelOutputCeiling({ describe: () => descriptor("actual", ceiling) }, "selected", "actual"),
    ).toBeUndefined()
  }
  expect(modelOutputCeiling({ describe: () => null }, "selected", "actual")).toBeUndefined()
  expect(
    modelOutputCeiling({ describe: () => descriptor("other", 32000) }, "selected", "actual"),
  ).toBeUndefined()
  expect(
    modelOutputCeiling(
      { describe: () => ({ ...descriptor("actual", 32000), contextSource: null }) },
      "selected",
      "actual",
    ),
  ).toBeUndefined()
})

test("same-dialect dispatch keeps exact bytes and never reads model metadata", async () => {
  const cryptor = cipher(),
    source = '{ "model":"actual", "max_tokens":13, "messages":[{"role":"user","content":"hi"}] }'
  let lookups = 0
  const upstream = mockUpstream([
    () => new Response("{}", { headers: { "content-type": "application/json" } }),
  ])
  const dispatcher = createDispatcher({
    catalog: catalog([account("selected", { cipher: cryptor })]),
    cipher: cryptor,
    health: createHealthStore(),
    usage: usageSink(),
    fetch: upstream.fetch,
    modelMetadata: {
      describe: () => {
        lookups++
        throw new Error("Passthrough must not consult metadata")
      },
    },
  })
  const response = await dispatcher.dispatch({
    key,
    requestId: crypto.randomUUID(),
    ingress: "anthropic",
    request: new Request("http://router.test/v1/messages", { method: "POST", body: source }),
  })
  await response.text()
  expect(upstream.calls[0]?.body).toBe(source)
  expect(lookups).toBe(0)
})

test("actual failover sends each account's own alias, credential, and model ceiling", async () => {
  const cryptor = cipher(),
    lookups: [string, string][] = []
  const upstream = mockUpstream([
    () =>
      new Response(JSON.stringify({ error: { message: "Unavailable" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response(JSON.stringify({ type: "message", content: [], stop_reason: "end_turn" }), {
        headers: { "content-type": "application/json" },
      }),
  ])
  const dispatcher = createDispatcher({
    catalog: catalog([
      account("a", { cipher: cryptor, modelAliases: { alias: "model-a" } }),
      account("b", { cipher: cryptor, modelAliases: { alias: "model-b" } }),
    ]),
    cipher: cryptor,
    health: createHealthStore({ jitter: () => 0 }),
    usage: usageSink(),
    fetch: upstream.fetch,
    modelMetadata: {
      describe: (id, model) => {
        lookups.push([id, model])
        return descriptor(model, id === "a" ? 16000 : 32000)
      },
    },
  })
  const response = await dispatcher.dispatch({
    key,
    requestId: crypto.randomUUID(),
    ingress: "openai-chat",
    request: new Request("http://router.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "alias", messages: [{ role: "user", content: "hi" }] }),
    }),
  })
  expect(response.status).toBe(200)
  await response.text()
  expect(upstream.calls).toHaveLength(2)
  expect(new Set(lookups.map(([id]) => id))).toEqual(new Set(["a", "b"]))
  for (const call of upstream.calls) {
    const id = call.headers.get("x-api-key") === "sk-a" ? "a" : "b"
    expect(JSON.parse(call.body)).toMatchObject({
      model: `model-${id}`,
      max_tokens: id === "a" ? 16000 : 32000,
    })
    expect(lookups).toContainEqual([id, `model-${id}`])
  }
})
