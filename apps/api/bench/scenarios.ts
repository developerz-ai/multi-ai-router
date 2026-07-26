import type { ProviderId } from "@multi-ai-router/core"
import { type BenchApp, benchApp, scrape } from "./harness"
import { stubUpstream, TRIP_HEADER, type Trip } from "./upstream"

/**
 * What gets driven, and how the two claims in the budget are told apart.
 *
 * CLAUDE.md non-negotiable 8 makes two separate promises, and they need two separate measurements:
 *
 * 1. **< 5 ms added p99 overhead.** Read off `router_overhead_seconds` — the router's own histogram,
 *    scraped from `/metrics`. Nothing here holds a stopwatch, because the series is what regresses
 *    and the series is what alerts.
 * 2. **Zero added time-to-first-token.** No series records this, and none can: `ttfbMs` is measured
 *    from when the request entered the *router*, so it necessarily contains the upstream's own think
 *    time and cannot say how much of it the router added. The only honest form of "added" is a
 *    difference between two clocks that both exist in this process — when the stub let its first
 *    byte go, and when the client saw one.
 *
 * Both non-SDK egress paths are covered, streamed and not. The Agent-SDK path is excluded by
 * design: it spawns a `claude` subprocess per request and is the budget's labeled exception.
 */

export interface Scenario {
  readonly name: string
  /** The `path` label its `router_overhead_seconds` samples land under. */
  readonly path: "passthrough" | "translate"
  readonly stream: boolean
  /** Anthropic ingress against an Anthropic account passes bytes through; anything else converts. */
  readonly provider: ProviderId
}

export const SCENARIOS: readonly Scenario[] = [
  { name: "passthrough", path: "passthrough", stream: false, provider: "anthropic-api" },
  { name: "passthrough (stream)", path: "passthrough", stream: true, provider: "anthropic-api" },
  { name: "translate", path: "translate", stream: false, provider: "openrouter" },
  { name: "translate (stream)", path: "translate", stream: true, provider: "openrouter" },
]

export interface DriveOptions {
  readonly requests: number
  readonly concurrency: number
  /** Requests run and thrown away before measuring, so the report is not a JIT warm-up curve. */
  readonly warmup: number
  /** Prompt size, bytes. The body a passthrough forwards and a translation rebuilds. */
  readonly promptBytes: number
  readonly chunks: number
  readonly chunkGapMs: number
  /** The stub's time to first byte. See `StubOptions.firstByteDelayMs` — it is load-shaping. */
  readonly firstByteDelayMs: number
}

export interface ScenarioResult {
  readonly scenario: Scenario
  readonly requests: number
  /** Responses that were not a 200. Any at all invalidates the run. */
  readonly failures: number
  /** The `/metrics` body, scraped after the usage queue drained. */
  readonly exposition: string
  /** Added time-to-first-token, ms, ascending. Empty for a non-streamed scenario. */
  readonly addedTtftMs: readonly number[]
  /** Streams whose first client byte landed after the upstream's last one — a buffered relay. */
  readonly buffered: number
}

const INGRESS_PATH = "/v1/messages"
const MODEL = "claude-opus-5"

export async function runScenario(
  scenario: Scenario,
  options: DriveOptions,
): Promise<ScenarioResult> {
  // Warmed on a throwaway app so its samples never reach the histogram that gets reported.
  await drive(build(scenario, options), scenario, options, options.warmup)

  const built = build(scenario, options)
  const driven = await drive(built, scenario, options, options.requests)

  return {
    scenario,
    requests: options.requests,
    failures: driven.failures,
    exposition: await scrape(built.bench),
    addedTtftMs: [...driven.addedTtftMs].sort((a, b) => a - b),
    buffered: driven.buffered,
  }
}

interface Built {
  readonly bench: BenchApp
  readonly open: (id: string) => Trip
}

function build(scenario: Scenario, options: DriveOptions): Built {
  const upstream = stubUpstream({
    dialect: scenario.provider === "anthropic-api" ? "anthropic" : "openai-chat",
    stream: scenario.stream,
    chunks: options.chunks,
    chunkGapMs: options.chunkGapMs,
    firstByteDelayMs: options.firstByteDelayMs,
  })
  return { bench: benchApp({ provider: scenario.provider, upstream }), open: upstream.open }
}

interface Driven {
  readonly failures: number
  readonly addedTtftMs: number[]
  readonly buffered: number
}

async function drive(
  built: Built,
  scenario: Scenario,
  options: DriveOptions,
  count: number,
): Promise<Driven> {
  const body = requestBody(scenario.stream, options.promptBytes)
  const addedTtftMs: number[] = []
  let failures = 0
  let buffered = 0

  await pool(count, options.concurrency, async (index) => {
    const id = `${scenario.name}-${index}`
    const trip = built.open(id)

    const response = await built.bench.app.request(INGRESS_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${built.bench.key}`,
        [TRIP_HEADER]: id,
      },
      body,
    })

    if (response.status !== 200) failures += 1
    // Drained either way: the usage record is written when the last byte lands, so a body left
    // unread is a sample the histogram never sees.
    if (!scenario.stream || response.body === null) {
      await response.arrayBuffer()
      return
    }

    trip.clientFirstByteAt = await drain(response.body)
    if (trip.clientFirstByteAt > trip.upstreamLastByteAt) buffered += 1
    addedTtftMs.push(trip.clientFirstByteAt - trip.upstreamFirstByteAt)
  })

  return { failures, addedTtftMs, buffered }
}

/** Reads to the end and returns when the **first** chunk arrived. Zero if none ever did. */
async function drain(body: ReadableStream<Uint8Array>): Promise<number> {
  const reader = body.getReader()
  let firstByteAt = 0
  for (;;) {
    const { done } = await reader.read()
    if (done) break
    if (firstByteAt === 0) firstByteAt = performance.now()
  }
  return firstByteAt
}

/** N requests through C workers. Single-threaded, so the cursor needs no lock. */
async function pool(
  count: number,
  concurrency: number,
  run: (index: number) => Promise<void>,
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, count)) }, async () => {
    for (let index = next++; index < count; index = next++) await run(index)
  })
  await Promise.all(workers)
}

function requestBody(stream: boolean, promptBytes: number): string {
  return JSON.stringify({
    model: MODEL,
    max_tokens: 256,
    messages: [{ role: "user", content: "x".repeat(Math.max(1, promptBytes)) }],
    ...(stream ? { stream: true } : {}),
  })
}
