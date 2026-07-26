import { describe, expect, test } from "bun:test"
import { account, jsonResponse, slowStream } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, MESSAGE, post, settle } from "./harness"

/**
 * `router_overhead_seconds` and its per-row twin `routerOverheadMs` measure **time in the router,
 * excluding upstream** — the number CLAUDE.md non-negotiable 8 budgets at under 5 ms p99 and calls
 * a bug when it regresses. Everything here is about the one way that number can lie: by quietly
 * containing upstream time and reporting a fast router as a slow one (or, on a long stream, as a
 * catastrophically slow one).
 *
 * These read as timing tests but nothing here waits on a clock. The harness's clock is driven by
 * hand, and the stub upstream advances it — so "the upstream took 400 ms" is a fact the test states,
 * not one it hopes the scheduler will produce. `bin/bench` is the counterpart that runs against a
 * real clock and reports distributions; this file is what fails the build.
 */

const UPSTREAM_MS = 400
const DRAIN_MS = 250

/** A response factory that charges the harness clock for the upstream's own time first. */
function afterUpstream(advance: () => void, make: () => Response): () => Response {
  return () => {
    advance()
    return make()
  }
}

describe("router overhead excludes upstream time", () => {
  test("a successful non-streamed attempt charges its upstream wait to the upstream", async () => {
    let advance: (ms: number) => void = () => undefined
    const bench = harness({
      responses: [
        afterUpstream(
          () => advance(UPSTREAM_MS),
          () => jsonResponse(200, {}),
        ),
      ],
    })
    advance = bench.clock.advance

    await (await bench.app.request("/v1/messages", post(MESSAGE, bearer()))).text()
    await settle()

    const row = bench.usage.rows[0]
    expect(row?.outcome).toBe("success")
    expect(row?.latencyMs).toBeGreaterThanOrEqual(UPSTREAM_MS)
    // The whole request took at least UPSTREAM_MS; none of it was the router's.
    expect(row?.routerOverheadMs).toBe(0)
  })

  test("a streamed reply's drain is upstream time, not router time", async () => {
    let advance: (ms: number) => void = () => undefined
    const slow = slowStream(["event: a\ndata: {}\n\n", "event: b\ndata: {}\n\n"])
    const bench = harness({
      responses: [
        afterUpstream(
          () => advance(UPSTREAM_MS),
          () => slow.response,
        ),
      ],
    })
    advance = bench.clock.advance

    const response = await bench.app.request("/v1/messages", post(MESSAGE, bearer()))
    slow.release(0)
    // The client is reading while the upstream is still generating — the long tail of every real
    // stream, and the part that would swamp the budget if it were counted as router time.
    bench.clock.advance(DRAIN_MS)
    slow.release(1)
    slow.finish()
    await response.text()
    await settle()

    const row = bench.usage.rows[0]
    expect(row?.streamed).toBe(true)
    expect(row?.latencyMs).toBeGreaterThanOrEqual(UPSTREAM_MS + DRAIN_MS)
    expect(row?.routerOverheadMs).toBe(0)
  })

  test("a translated reply is measured the same way — the path label changes, the rule does not", async () => {
    let advance: (ms: number) => void = () => undefined
    const bench = harness({
      accounts: [account("or-1", { provider: "openrouter", apiKey: "sk-or", cipher: CRYPTOR })],
      responses: [
        afterUpstream(
          () => advance(UPSTREAM_MS),
          () =>
            jsonResponse(200, {
              id: "chatcmpl-1",
              model: "gpt-4o",
              choices: [{ index: 0, message: { role: "assistant", content: "hi" } }],
              usage: { prompt_tokens: 3, completion_tokens: 4 },
            }),
        ),
      ],
    })
    advance = bench.clock.advance

    await (await bench.app.request("/v1/messages", post(MESSAGE, bearer()))).text()
    await settle()

    const row = bench.usage.rows[0]
    expect(row?.egressMode).toBe("translate")
    expect(row?.routerOverheadMs).toBe(0)
  })

  test("a failover charges every attempt's wait upstream, not just the one that answered", async () => {
    let advance: (ms: number) => void = () => undefined
    const bench = harness({
      accounts: [
        account("acct-1", { apiKey: "sk-one", cipher: CRYPTOR }),
        account("acct-2", { apiKey: "sk-two", cipher: CRYPTOR }),
      ],
      responses: [
        afterUpstream(
          () => advance(UPSTREAM_MS),
          () => jsonResponse(500, { error: "nope" }),
        ),
        afterUpstream(
          () => advance(UPSTREAM_MS),
          () => jsonResponse(200, {}),
        ),
      ],
    })
    advance = bench.clock.advance

    await (await bench.app.request("/v1/messages", post(MESSAGE, bearer()))).text()
    await settle()

    expect(bench.usage.rows).toHaveLength(2)
    for (const row of bench.usage.rows) expect(row.routerOverheadMs).toBe(0)
  })

  test("the overhead histogram sees the same number the row does", async () => {
    let advance: (ms: number) => void = () => undefined
    const bench = harness({
      responses: [
        afterUpstream(
          () => advance(UPSTREAM_MS),
          () => jsonResponse(200, {}),
        ),
      ],
    })
    advance = bench.clock.advance

    await (await bench.app.request("/v1/messages", post(MESSAGE, bearer()))).text()
    await settle()

    const exposition = await (await bench.app.request("/metrics")).text()
    // One sample, and it is in the smallest bucket — not in the one a 400 ms upstream would fill.
    expect(exposition).toContain(
      'router_overhead_seconds_bucket{ingress_dialect="anthropic",path="passthrough",le="0.0005"} 1',
    )
    expect(exposition).toContain(
      'router_overhead_seconds_sum{ingress_dialect="anthropic",path="passthrough"} 0',
    )
  })
})
