import { describe, expect, test } from "bun:test"
import { createSdkConcurrency, createSdkInvoker, type SdkInvoker } from "../../../src/providers"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import { account, catalog, cipher, clock, subscriptionAccount } from "./fixtures"

/**
 * developerz.ai plan 101 slice 09, R1, at the seam the client reads: a structured-output request
 * whose Claude-subscription account is on the Agent-SDK transport. The refusal itself is pinned in
 * `claude-sdk/structured-output-refusal.test.ts`; this pins what the chain (`routing/failover.ts`)
 * does with it — fail over to an account that carries the field, never strike the SDK account, end
 * as the typed `400` request wall after two refusals — and after one, when nothing else is in
 * scope: a `503` would read as capacity, and a retry of the same key would meet the same refusal.
 *
 * Both endings are the router's own `InvalidRequestError` (`invalid_request`), never the
 * upstream-shaped `api_error` body an attempt's held answer renders as.
 */

const SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string" } },
  required: ["verdict"],
  additionalProperties: false,
}

const ANSWER = {
  id: "msg_api",
  type: "message",
  role: "assistant",
  model: "claude-opus-5",
  content: [{ type: "text", text: '{"verdict":"ok"}' }],
  stop_reason: "end_turn",
  usage: { input_tokens: 5, output_tokens: 4 },
}

interface HarnessOptions {
  /** Replaces the default `query()`, which refuses to launch at all. */
  readonly runQuery?: () => never
  /** Leave the structured-output constraint off the body. */
  readonly plain?: boolean
}

function harness(accounts: Parameters<typeof catalog>[0], options: HarnessOptions = {}) {
  const entries = catalog(accounts)
  const health = createHealthStore()
  let sdkCalls = 0
  let launches = 0
  let httpCalls = 0
  const real = createSdkInvoker({
    concurrency: createSdkConcurrency({ global: 2, perAccount: 2 }),
    resolveCli: () => ({ ok: true, source: "env_override", path: "/offline/claude", bytes: 1 }),
    runQuery: () => {
      launches++
      if (options.runQuery) options.runQuery()
      throw new Error("a structured-output turn must never launch the SDK")
    },
  })
  const invokeSdk: SdkInvoker = (input) => {
    sdkCalls++
    return real(input)
  }
  const dispatcher = createDispatcher({
    usage: { record: () => {} },
    catalog: entries,
    health,
    cipher: cipher(),
    clock: clock(new Date("2026-11-15T00:00:00Z")),
    invokeSdk,
    fetch: async () => {
      httpCalls++
      return Response.json(ANSWER)
    },
  })
  const dispatch = () =>
    dispatcher.dispatch({
      ingress: "anthropic",
      requestId: crypto.randomUUID(),
      key: {
        id: "key",
        name: "offline",
        prefix: "offline",
        scope: { kind: "accounts", accountIds: accounts.map((entry) => entry.snapshot.id) },
        rateLimitRequests: null,
        rateLimitWindowSeconds: null,
        expiresAt: null,
      },
      request: new Request("http://router.test/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-opus-5",
          max_tokens: 64,
          messages: [{ role: "user", content: "grade this" }],
          ...(options.plain
            ? {}
            : { output_config: { format: { type: "json_schema", schema: SCHEMA } } }),
        }),
      }),
    })
  return {
    dispatch,
    health,
    counts: () => ({ sdkCalls, launches, httpCalls }),
  }
}

/** The answer a refused chain renders, whether thrown as a router error or returned. */
async function outcome(run: Promise<Response>): Promise<{ status: number; body: string }> {
  try {
    const response = await run
    return { status: response.status, body: await response.text() }
  } catch (error) {
    const status = (error as { status?: unknown }).status
    if (typeof status !== "number") throw error
    return { status, body: JSON.stringify(error, Object.getOwnPropertyNames(error)) }
  }
}

function unstruck(h: ReturnType<typeof harness>, id: string) {
  const breaker = h.health.stateOf(id).breaker
  expect(breaker.status).toBe("active")
  expect(breaker.consecutiveFailures).toBe(0)
}

describe("a structured-output request on the Agent-SDK transport, through the chain (R1)", () => {
  test("fails over to an API-key account that carries the field; the SDK account is not struck", async () => {
    const h = harness([
      subscriptionAccount("sub"),
      account("api", { provider: "anthropic-api", apiKey: "sk-ant-offline" }),
    ])

    const answer = await outcome(h.dispatch())

    expect(answer.status).toBe(200)
    expect(answer.body).toContain('{\\"verdict\\":\\"ok\\"}')
    expect(h.counts()).toEqual({ sdkCalls: 1, launches: 0, httpCalls: 1 })
    unstruck(h, "sub")
  })

  test("two SDK refusals end as the 400 request wall, never a 429; neither account is struck", async () => {
    const h = harness([subscriptionAccount("sub-a"), subscriptionAccount("sub-b")])

    const answer = await outcome(h.dispatch())

    expect(answer.status).toBe(400)
    expect(answer.body).toContain('"code":"invalid_request"')
    expect(answer.body).toContain("structured output")
    expect(h.counts()).toEqual({ sdkCalls: 2, launches: 0, httpCalls: 0 })
    unstruck(h, "sub-a")
    unstruck(h, "sub-b")
  })

  test("a one-account pool ends as the same 400 request wall, and the account is not struck", async () => {
    const h = harness([subscriptionAccount("sub")])

    const answer = await outcome(h.dispatch())

    expect(answer.status).toBe(400)
    expect(answer.body).toContain('"code":"invalid_request"')
    expect(answer.body).toContain("structured output")
    expect(h.counts()).toEqual({ sdkCalls: 1, launches: 0, httpCalls: 0 })
    unstruck(h, "sub")
  })

  test("the lone-refusal wall is structured output's alone: extra-usage-gated on one account stays the 429", async () => {
    // Extra Usage gating is a quota wall that clears with time, so a 400 would tell the client
    // never to retry a request that succeeds later. Only a refusal that can never succeed on
    // this pool (structured output on the Agent SDK) ends a one-account chain as the wall.
    const h = harness([subscriptionAccount("sub")], {
      plain: true,
      runQuery: () => {
        throw new Error(
          "API Error: 400 Third-party apps now draw from your extra usage, not your plan limits.",
        )
      },
    })

    const answer = await outcome(h.dispatch())

    expect(answer.status).toBe(429)
    expect(h.counts().launches).toBe(1)
    unstruck(h, "sub")
  })
})
