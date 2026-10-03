import { expect, test } from "bun:test"
import { toErrorResponse } from "../../../src/errors/render"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import type { VerifiedKey } from "../../../src/services/dataplane/auth/verifier"
import type { UsageRecord } from "../../../src/services/usage"
import { account, catalog, cipher } from "./fixtures"

const key: VerifiedKey = {
  id: "key",
  name: "offline",
  prefix: "offline",
  scope: { kind: "all" },
  rateLimitRequests: null,
  rateLimitWindowSeconds: null,
  expiresAt: null,
}

for (const scenario of [
  { name: "missing model", body: "{}", headers: {}, status: 400 },
  {
    name: "encoded body",
    body: '{"model":"claude"}',
    headers: { "content-encoding": "gzip" },
    status: 415,
  },
  {
    name: "declared oversized body",
    body: "{}",
    headers: { "content-length": "100" },
    status: 413,
  },
]) {
  test(`authenticated ${scenario.name} records one unstarted event with the rendered response status`, async () => {
    const rows: UsageRecord[] = []
    const dispatcher = createDispatcher({
      catalog: catalog([]),
      cipher: cipher(),
      health: createHealthStore(),
      usage: { record: (row) => rows.push(row) },
      options: { body: { maxBytes: 32 } },
      fetch: async () => {
        throw new Error("unstarted request reached transport")
      },
    })
    let error: unknown
    try {
      await dispatcher.dispatch({
        ingress: "anthropic",
        key,
        requestId: "caller-label",
        request: new Request("http://router.test/v1/messages", {
          method: "POST",
          body: scenario.body,
          headers: scenario.headers,
        }),
      })
    } catch (failure) {
      error = failure
    }
    expect(toErrorResponse(error, "anthropic").status).toBe(scenario.status)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      apiKeyId: key.id,
      clientRequestId: "caller-label",
      model: null,
      upstreamModel: null,
      accountId: null,
      provider: null,
      egressMode: null,
      httpStatus: null,
      responseStatus: scenario.status,
      costEstimate: null,
      costBasis: "unknown",
    })
  })
}

test("existing model-known selection refusal is not duplicated by outer accounting", async () => {
  const rows: UsageRecord[] = []
  const dispatcher = createDispatcher({
    catalog: catalog([]),
    cipher: cipher(),
    health: createHealthStore(),
    usage: { record: (row) => rows.push(row) },
  })
  await expect(
    dispatcher.dispatch({
      ingress: "anthropic",
      key,
      requestId: "caller",
      request: new Request("http://router.test/v1/messages", {
        method: "POST",
        body: '{"model":"claude"}',
      }),
    }),
  ).rejects.toThrow()
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ model: "claude", upstreamModel: null, responseStatus: 403 })
})

test("actual dispatches with a repeated caller UUID have separate event and chain identities", async () => {
  const rows: UsageRecord[] = []
  const dispatcher = createDispatcher({
    catalog: catalog([account("offline")]),
    cipher: cipher(),
    health: createHealthStore(),
    usage: { record: (row) => rows.push(row) },
    fetch: async () =>
      new Response('{"type":"message","usage":{"input_tokens":1,"output_tokens":1}}', {
        headers: { "content-type": "application/json" },
      }),
  })
  const label = crypto.randomUUID()
  for (const id of ["key-a", "key-b"]) {
    const response = await dispatcher.dispatch({
      ingress: "anthropic",
      key: { ...key, id },
      requestId: label,
      request: new Request("http://router.test/v1/messages", {
        method: "POST",
        body: '{"model":"claude"}',
      }),
    })
    await response.text()
  }
  expect(rows).toHaveLength(2)
  expect(rows[0]?.correlationId).not.toBe(rows[1]?.correlationId)
  expect(rows[0]?.eventId).not.toBe(rows[1]?.eventId)
  expect(rows.map((row) => row.clientRequestId)).toEqual([label, label])
  expect(rows.map((row) => row.responseStatus)).toEqual([200, 200])
})
