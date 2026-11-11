/**
 * A wall read out of an upstream `2xx` leaves its own mark on the attempt's usage row
 * (developerz.ai plan 101 slice 07, step 4: "measure wall rates in prod").
 *
 * The client hears the wall at its owed status (`429` / `402` / `503`), but the row's `http_status`
 * is the **upstream's** status (`docs/idea/08` § usage record), so a wall in a `200` records `200`.
 * Through 2.57.1 it recorded the owed `429`: the row and `router_upstream_errors_total` read exactly
 * like an upstream that answered `429` itself, and the rate of walls in `2xx` could not be counted
 * in prod. `error_class = success_wall` marks it; a real `4xx` keeps its status and a NULL class.
 */
import { describe, expect, test } from "bun:test"
import {
  createDispatcher,
  createHealthStore,
  type RoutableAccount,
} from "../../../src/services/dataplane"
import type { UsageRecord } from "../../../src/services/usage"
import { account, catalog, cipher, mockUpstream } from "./fixtures"

const CRYPTOR = cipher()

const STREAM =
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [], usage: { input_tokens: 3, output_tokens: 0 } } })}\n\n` +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"served"}}\n\n' +
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
const WALL_IN_200 =
  'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}\n\n'

function sse(text: string): () => Response {
  return () => new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } })
}

function rateLimited(): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }),
    { status: 429, headers: { "content-type": "application/json", "retry-after": "30" } },
  )
}

async function records(responses: readonly (() => Response)[]): Promise<UsageRecord[]> {
  const accounts: RoutableAccount[] = ["a", "b"].map((id) =>
    account(id, { provider: "anthropic-api", cipher: CRYPTOR }),
  )
  const rows: UsageRecord[] = []
  const dispatcher = createDispatcher({
    catalog: catalog(accounts),
    cipher: CRYPTOR,
    health: createHealthStore(),
    usage: { record: (row) => rows.push(row) },
    fetch: mockUpstream(responses).fetch,
  })
  const response = await dispatcher.dispatch({
    ingress: "anthropic",
    requestId: "req-success-wall-record",
    key: {
      id: "key",
      name: "wall",
      prefix: "wall",
      scope: { kind: "all" },
      rateLimitRequests: null,
      rateLimitWindowSeconds: null,
      expiresAt: null,
    },
    request: new Request("http://router.test/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "m",
        max_tokens: 8,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
  })
  expect(response.status).toBe(200)
  await response.text()
  return rows.sort((x, y) => x.attempt - y.attempt)
}

describe("the usage row of a walled attempt", () => {
  test("a wall peeked out of a 2xx records the upstream's 200, marked success_wall", async () => {
    const [walled, served] = await records([sse(WALL_IN_200), sse(STREAM)])

    expect(walled).toMatchObject({ httpStatus: 200, errorClass: "success_wall" })
    expect(walled?.outcome).not.toBe("success")
    expect(served).toMatchObject({ outcome: "success", httpStatus: 200 })
  })

  test("an upstream that answered 429 itself carries no mark", async () => {
    const [walled, served] = await records([rateLimited, sse(STREAM)])

    expect(walled).toMatchObject({ httpStatus: 429, errorClass: null })
    expect(served).toMatchObject({ outcome: "success", httpStatus: 200 })
  })
})
