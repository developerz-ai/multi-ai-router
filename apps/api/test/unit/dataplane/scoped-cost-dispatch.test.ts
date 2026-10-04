import { expect, test } from "bun:test"
import { createPriceBook } from "../../../src/services/cost"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import type { UsageRecord } from "../../../src/services/usage"
import { account, catalog, cipher } from "./fixtures"

test("actual dispatch preserves the explicit alias and uses the selected account override", async () => {
  const rows: UsageRecord[] = []
  const book = createPriceBook({
    refreshIntervalMs: 1_000,
    load: async () =>
      [null, "a"].map((accountId) => ({
        id: crypto.randomUUID(),
        accountId,
        provider: "anthropic-api",
        model: "glm-4.7",
        inputPerMtok: accountId === null ? 100 : 2,
        outputPerMtok: 3,
        cacheReadPerMtok: 0.5,
        cacheWritePerMtok: 4,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      })),
  })
  await book.refresh()
  let wireModel: unknown
  const dispatcher = createDispatcher({
    catalog: catalog([
      account("a", { modelAliases: { claude: "glm-4.7" }, billing: "subscription" }),
    ]),
    cipher: cipher(),
    health: createHealthStore(),
    prices: book.lookup,
    usage: { record: (event) => void rows.push(event) },
    fetch: async (request) => {
      const body = (await request.json()) as { model?: unknown }
      wireModel = body.model
      return new Response(
        JSON.stringify({
          id: "offline",
          type: "message",
          role: "assistant",
          model: "glm-4.7",
          content: [{ type: "text", text: "offline" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 5,
          },
        }),
        { headers: { "content-type": "application/json" } },
      )
    },
  })
  const response = await dispatcher.dispatch({
    ingress: "anthropic",
    requestId: "caller",
    key: {
      id: "key",
      name: "offline",
      prefix: "offline",
      scope: { kind: "all" },
      rateLimitRequests: null,
      rateLimitWindowSeconds: null,
      expiresAt: null,
    },
    request: new Request("http://router.test/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude", messages: [{ role: "user", content: "offline" }] }),
    }),
  })
  await response.text()
  expect(wireModel).toBe("glm-4.7")
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    accountId: "a",
    model: "claude",
    upstreamModel: "glm-4.7",
    costBasis: "notional",
    costEstimate: "0.000260",
  })
  book.stop()
})
