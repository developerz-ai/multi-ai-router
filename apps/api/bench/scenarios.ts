import type { Dialect, ProviderId } from "@multi-ai-router/core"
import { type Built, drive, startBackground } from "./drive"
import { benchApp, type Fleet, scrape } from "./harness"
import { stubUpstream } from "./upstream"

/**
 * What gets driven, and how the two claims in the budget are told apart.
 *
 * CLAUDE.md non-negotiable 8 makes two separate promises, and they need two separate measurements:
 *
 * 1. **< 5 ms added p99 overhead.** Measured per request, unrounded: how late the router made it —
 *    its time before calling the upstream, plus the worse of its time after the upstream's last
 *    byte and the latest any stream token reached the client after the stub released it
 *    (`clocks.ts`). The router's own
 *    `router_overhead_seconds` histogram is scraped beside it and must have recorded every request —
 *    the series is what alerts — but it is fed whole milliseconds into eight buckets, so it cannot
 *    tell 0.1 ms from 0.9 ms, and its interpolated p99 reads a bucket's upper edge. The verdict
 *    needs the measurement; the series is the cross-check.
 * 2. **Zero added time-to-first-token.** No series records this, and none can: `ttfbMs` is measured
 *    from when the request entered the *router*, so it necessarily contains the upstream's own think
 *    time and cannot say how much of it the router added. The honest form of "added" is a
 *    difference between clocks that all exist in this process: how long the client waited for its
 *    first byte from the moment it sent the request, less how long the stub took to produce one
 *    once it was called. From the request's start, so the work the router does before it calls the
 *    upstream counts — it delays the first token as surely as a slow relay does.
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
  /**
   * A prod-shaped agent transcript of this many bytes instead of `--prompt-bytes` of `"x"`
   * (`transcript.ts`). The `"x"` body is the scanner's one fast path; this is what prod posts.
   */
  readonly transcriptBytes?: number
  /** A non-streamed answer padded to this many bytes, so response observation is measured too. */
  readonly answerBytes?: number
  /** SSE chunks for this scenario, overriding `--chunks`: a long answer, not a 16-chunk one. */
  readonly chunks?: number
  /** The wire the account speaks when it is not its provider's default (`openai-responses`). */
  readonly dialect?: Extract<Dialect, "openai-responses">
  /** A deployment-sized roster instead of the single account. See `harness.ts`. */
  readonly fleet?: Fleet
  /**
   * Long streams kept in flight on the same app for the whole measurement, and never measured
   * themselves. Prod's tail is not made by idle routers: a short request there shares the event
   * loop with dozens of generations being relayed chunk by chunk.
   */
  readonly backgroundStreams?: number
  /**
   * Scales `--requests` for a scenario whose every request is slow by construction. A 200-chunk
   * stream takes eleven times as long as a 16-chunk one; at the full count it was half the bench's
   * wall time for one row, and a quarter of the samples still resolves a p99. Warm-up scales too.
   */
  readonly requestShare?: number
  /**
   * A ceiling on `--concurrency` for this scenario. The bench reports per-request cost, which only
   * holds while offered load sits well under what one event loop retires (`run.ts`). A 350 KB
   * transcript costs milliseconds of CPU where a 1 KB prompt costs microseconds, so eight of them
   * in flight against a 20 ms upstream is a saturated loop, and what that measures is its queue.
   */
  readonly maxConcurrency?: number
}

/** The size prod's p99 is measured at (plan 101, 10.2 / 12.4): a long Claude Code session. */
const TRANSCRIPT_BYTES = 350_000

/** The deployment the prod overhead numbers come from: 31 accounts in 11 pools. */
const PROD_FLEET: Fleet = { accounts: 31, pools: 11 }

/** Heavy bodies run few at a time and for fewer requests: see `maxConcurrency`, `requestShare`. */
const HEAVY = { maxConcurrency: 2, requestShare: 0.2 } as const

/** Chunks in one background stream: long enough to outlast the measured requests around it. */
const BACKGROUND_CHUNKS = 400

export const SCENARIOS: readonly Scenario[] = [
  { name: "passthrough", path: "passthrough", stream: false, provider: "anthropic-api" },
  { name: "passthrough (stream)", path: "passthrough", stream: true, provider: "anthropic-api" },
  { name: "translate", path: "translate", stream: false, provider: "openrouter" },
  { name: "translate (stream)", path: "translate", stream: true, provider: "openrouter" },
  {
    name: "passthrough 350 KB transcript",
    path: "passthrough",
    stream: false,
    provider: "anthropic-api",
    transcriptBytes: TRANSCRIPT_BYTES,
    ...HEAVY,
  },
  {
    name: "passthrough 350 KB transcript (stream, 200 chunks)",
    path: "passthrough",
    stream: true,
    provider: "anthropic-api",
    transcriptBytes: TRANSCRIPT_BYTES,
    chunks: 200,
    maxConcurrency: 4,
    requestShare: 0.1,
  },
  {
    name: "passthrough 1 MB transcript",
    path: "passthrough",
    stream: false,
    provider: "anthropic-api",
    transcriptBytes: 1_000_000,
    ...HEAVY,
  },
  {
    // ~62 KB on the wire: just under the 64 KiB a non-streamed success is peeked at before commit.
    name: "passthrough 62 KB answer",
    path: "passthrough",
    stream: false,
    provider: "anthropic-api",
    answerBytes: 56_000,
  },
  {
    name: "translate 350 KB transcript",
    path: "translate",
    stream: false,
    provider: "openrouter",
    transcriptBytes: TRANSCRIPT_BYTES,
    ...HEAVY,
  },
  {
    name: "passthrough, 31 accounts in 11 pools",
    path: "passthrough",
    stream: false,
    provider: "anthropic-api",
    fleet: PROD_FLEET,
  },
  {
    // Prod's most expensive path: Anthropic Messages in, a Responses-API account out.
    name: "translate to responses (stream)",
    path: "translate",
    stream: true,
    provider: "openai-api",
    dialect: "openai-responses",
  },
  {
    name: "translate to responses 350 KB transcript",
    path: "translate",
    stream: false,
    provider: "openai-api",
    dialect: "openai-responses",
    transcriptBytes: TRANSCRIPT_BYTES,
    ...HEAVY,
  },
  {
    name: "passthrough under 32 long streams, 31 accounts",
    path: "passthrough",
    stream: false,
    provider: "anthropic-api",
    fleet: PROD_FLEET,
    backgroundStreams: 32,
  },
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
  /**
   * Per-request router overhead, ms, ascending and unrounded: how late the router made the request
   * (`clocks.ts`). One per measured request that reached the upstream.
   */
  readonly overheadMs: readonly number[]
  /**
   * Added time-to-first-token, ms, ascending: the client's wait for a first byte from the request's
   * start, less the upstream's own time to produce one. Empty for a non-streamed scenario.
   */
  readonly addedTtftMs: readonly number[]
  /**
   * For a scenario with `backgroundStreams`: the fewest and the most of them in flight when a
   * measured request reached the upstream. Null otherwise. A scenario that claims load and measured
   * an idle router is the failure this exists to name.
   */
  readonly backgroundOverlap: { readonly min: number; readonly max: number } | null
  /** Streams whose first client byte landed after the upstream's last one — a buffered relay. */
  readonly buffered: number
}

export async function runScenario(
  scenario: Scenario,
  options: DriveOptions,
): Promise<ScenarioResult> {
  const share = scenario.requestShare ?? 1
  const shaped: DriveOptions = {
    ...options,
    concurrency: Math.min(options.concurrency, scenario.maxConcurrency ?? options.concurrency),
  }
  const requests = Math.max(1, Math.round(options.requests * share))

  // Warmed on a throwaway app so its samples never reach the histogram that gets reported.
  await drive(build(scenario, shaped), scenario, shaped, Math.round(options.warmup * share))

  const built = build(scenario, shaped)
  const background = startBackground(
    built,
    scenario,
    shaped,
    shaped.firstByteDelayMs + BACKGROUND_CHUNKS * shaped.chunkGapMs,
  )
  const driven = await background.ready
    .then(() => drive(built, scenario, shaped, requests))
    .finally(() => background.stop())
  await background.settled

  return {
    scenario,
    requests,
    failures: driven.failures + background.failures(),
    exposition: await scrape(built.bench),
    overheadMs: [...driven.overheadMs].sort((a, b) => a - b),
    backgroundOverlap:
      scenario.backgroundStreams === undefined || driven.backgroundActive.length === 0
        ? null
        : {
            min: Math.min(...driven.backgroundActive),
            max: Math.max(...driven.backgroundActive),
          },
    addedTtftMs: [...driven.addedTtftMs].sort((a, b) => a - b),
    buffered: driven.buffered,
  }
}

function build(scenario: Scenario, options: DriveOptions): Built {
  const upstream = stubUpstream({
    dialect:
      scenario.dialect ?? (scenario.provider === "anthropic-api" ? "anthropic" : "openai-chat"),
    stream: scenario.stream,
    chunks: scenario.chunks ?? options.chunks,
    ...(scenario.answerBytes === undefined ? {} : { answerBytes: scenario.answerBytes }),
    chunkGapMs: options.chunkGapMs,
    firstByteDelayMs: options.firstByteDelayMs,
    // The stub answers a request that asks to stream with a stream, whatever the scenario's own
    // shape — which is what lets background streams share an app with non-streamed requests.
    streamOnRequest: scenario.backgroundStreams !== undefined,
    backgroundChunks: BACKGROUND_CHUNKS,
  })
  return {
    bench: benchApp({
      provider: scenario.provider,
      upstream,
      ...(scenario.dialect === undefined ? {} : { dialect: scenario.dialect }),
      ...(scenario.fleet === undefined ? {} : { fleet: scenario.fleet }),
    }),
    open: upstream.open,
    backgroundActive: upstream.backgroundActive,
  }
}
