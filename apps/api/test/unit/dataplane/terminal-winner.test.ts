import { expect, test } from "bun:test"
import { toErrorResponse } from "../../../src/errors/render"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import type { UsageRecord, UsageRequestTerminal } from "../../../src/services/usage"
import { account, catalog, cipher, clock } from "./fixtures"

for (const statuses of [
  [429, 500],
  [402, 500],
  [429, 429],
] as const) {
  test(`terminal owner follows winning ${statuses.join(" then ")} verdict`, async () => {
    const rows: UsageRecord[] = []
    const terminals: UsageRequestTerminal[] = []
    const timer = clock(new Date("2026-01-01T23:59:59Z"))
    let calls = 0
    const dispatcher = createDispatcher({
      catalog: catalog(
        [account("a"), account("b")],
        [
          {
            id: "pool",
            name: "pool",
            policy: "round-robin",
            members: [{ accountId: "a" }, { accountId: "b" }],
          },
        ],
      ),
      clock: timer,
      cipher: cipher(),
      health: createHealthStore(),
      usage: {
        record: (event) => void rows.push(event),
        recordTerminal: (event) => void terminals.push(event),
      },
      fetch: async () => {
        const status = statuses[calls++] ?? 500
        timer.advance(1_000)
        return new Response(
          JSON.stringify({
            error: { type: status === 429 ? "rate_limit_error" : "api_error", message: "offline" },
          }),
          {
            status,
            headers: {
              "content-type": "application/json",
              "retry-after": calls === 1 ? "60" : "10",
            },
          },
        )
      },
    })
    let response: Response | undefined
    try {
      response = await dispatcher.dispatch({
        ingress: "anthropic",
        requestId: "caller",
        key: {
          id: "key",
          name: "offline",
          prefix: "offline",
          scope: { kind: "pools", poolIds: ["pool"] },
          rateLimitRequests: null,
          rateLimitWindowSeconds: null,
          expiresAt: null,
        },
        request: new Request("http://router.test/v1/messages", {
          method: "POST",
          body: JSON.stringify({
            model: "claude",
            messages: [{ role: "user", content: "offline" }],
          }),
        }),
      })
    } catch (error) {
      response = toErrorResponse(error, "anthropic")
    }
    expect(calls).toBe(2)
    expect(response.status).toBe(statuses[0])
    expect(rows).toHaveLength(2)
    expect(terminals).toHaveLength(1)
    const winner = statuses[1] === 429 ? rows[1] : rows[0]
    expect(terminals[0]).toMatchObject({
      winnerEventId: winner?.eventId,
      accountId: winner?.accountId,
      poolId: "pool",
      responseStatus: statuses[0],
      attributionKind: "winning-attempt",
      startedAt: new Date("2026-01-01T23:59:59Z"),
      settledAt: new Date("2026-01-02T00:00:01Z"),
    })
    if (statuses[1] !== 429) expect(rows[1]?.responseStatus).toBeNull()
  })
}
