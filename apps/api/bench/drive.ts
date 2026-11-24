import { addedTtftMs, overheadMs, type RequestClocks, tokensIn } from "./clocks"
import type { BenchApp } from "./harness"
import type { DriveOptions, Scenario } from "./scenarios"
import { transcriptBody } from "./transcript"
import { TRIP_HEADER, type Trip } from "./upstream"

/**
 * Driving a built app: the measured requests, and the background streams that load it.
 *
 * Apart from `scenarios.ts` so that file stays the list of what is measured and this one how. All
 * the clocks the report reads are taken here, in this process, around `app.request()`.
 */

export const INGRESS_PATH = "/v1/messages"
export const MODEL = "claude-opus-5"

export interface Built {
  readonly bench: BenchApp
  readonly open: (id: string) => Trip
  /** Background streams in flight at the stub right now. */
  readonly backgroundActive: () => number
}

export interface Background {
  /** Resolves once every background stream is in flight at the upstream. Measure after it. */
  readonly ready: Promise<void>
  stop(): void
  failures(): number
  readonly settled: Promise<void>
}

const NO_BACKGROUND: Background = {
  ready: Promise.resolve(),
  stop: () => undefined,
  failures: () => 0,
  settled: Promise.resolve(),
}

/** How long the background streams get to all be in flight before the scenario is called broken. */
const BACKGROUND_READY_TIMEOUT_MS = 10_000

/**
 * Keeps `backgroundStreams` long streams open until told to stop. Each worker opens the next as
 * soon as its last one ends, so the count in flight holds for the whole measurement. Their bodies
 * are drained and nothing about them is timed: they are load, not samples.
 *
 * `ready` exists because starting them is not having them: a stream is load only once the router
 * has it open against the upstream, and a measured request sent in the same tick gets there first.
 * Without the wait the first requests of a "loaded" scenario were measured on an idle router.
 */
export function startBackground(
  built: Built,
  scenario: Scenario,
  options: DriveOptions,
): Background {
  const count = scenario.backgroundStreams
  if (count === undefined || count <= 0) return NO_BACKGROUND
  const body = requestBody(true, options.promptBytes)
  let running = true
  let failures = 0

  const worker = async () => {
    while (running) {
      const response = await built.bench.app.request(INGRESS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${built.bench.key}` },
        body,
      })
      if (response.status !== 200) failures += 1
      await response.arrayBuffer()
    }
  }
  const settled = Promise.all(Array.from({ length: count }, worker)).then(() => undefined)
  const ready = (async () => {
    const deadline = performance.now() + BACKGROUND_READY_TIMEOUT_MS
    while (built.backgroundActive() < count) {
      if (performance.now() > deadline) {
        throw new Error(
          `${scenario.name}: only ${built.backgroundActive()} of ${count} background streams were in flight after ${BACKGROUND_READY_TIMEOUT_MS} ms`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  })()
  return {
    ready,
    stop: () => {
      running = false
    },
    failures: () => failures,
    settled,
  }
}

interface Driven {
  readonly failures: number
  readonly overheadMs: number[]
  readonly addedTtftMs: number[]
  readonly buffered: number
  /** Background streams in flight when each measured request reached the upstream. */
  readonly backgroundActive: number[]
}

export async function drive(
  built: Built,
  scenario: Scenario,
  options: DriveOptions,
  count: number,
): Promise<Driven> {
  const body =
    scenario.transcriptBytes === undefined
      ? requestBody(scenario.stream, options.promptBytes)
      : transcriptBody({ model: MODEL, bytes: scenario.transcriptBytes, stream: scenario.stream })
  const driven: Driven = {
    failures: 0,
    overheadMs: [],
    addedTtftMs: [],
    buffered: 0,
    backgroundActive: [],
  }
  let failures = 0
  let buffered = 0

  await pool(count, options.concurrency, async (index) => {
    const id = `${scenario.name}-${index}`
    const trip = built.open(id)

    const startedAt = performance.now()
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
    const streamBody = scenario.stream ? response.body : null
    const streamed = streamBody !== null
    let read: Drained = { firstByteAt: 0, tokenAt: [] }
    if (streamBody !== null) read = await drain(streamBody)
    else await response.arrayBuffer()
    const clocks: RequestClocks = {
      startedAt,
      endedAt: performance.now(),
      upstreamEnteredAt: trip.upstreamEnteredAt,
      upstreamFirstByteAt: trip.upstreamFirstByteAt,
      upstreamLastByteAt: trip.upstreamLastByteAt,
      clientFirstByteAt: read.firstByteAt,
      upstreamTokenAt: trip.upstreamTokenAt,
      clientTokenAt: read.tokenAt,
    }
    trip.clientFirstByteAt = read.firstByteAt

    // The arithmetic is `clocks.ts`'s. A request that never reached the stub adds no sample.
    const overhead = overheadMs(clocks)
    if (overhead !== null) {
      driven.overheadMs.push(overhead)
      driven.backgroundActive.push(trip.backgroundActive)
    }
    if (!streamed) return
    if (read.firstByteAt > trip.upstreamLastByteAt) buffered += 1
    const ttft = addedTtftMs(clocks)
    if (ttft !== null) driven.addedTtftMs.push(ttft)
  })

  return { ...driven, failures, buffered }
}

interface Drained {
  /** When the first chunk arrived. Zero if none ever did. */
  readonly firstByteAt: number
  /** When the chunk carrying stream token N arrived, to match against the stub's release of it. */
  readonly tokenAt: (number | undefined)[]
}

/**
 * Reads to the end, timing the first chunk and every stream token. The clock is read before the
 * chunk is decoded, so the driver's own scan is not charged to the token it finds.
 */
async function drain(body: ReadableStream<Uint8Array>): Promise<Drained> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const tokenAt: (number | undefined)[] = []
  let firstByteAt = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const at = performance.now()
    if (firstByteAt === 0) firstByteAt = at
    // First sight only: a translated stream's closing event may carry the whole text again.
    for (const token of tokensIn(decoder.decode(value, { stream: true }))) tokenAt[token] ??= at
  }
  return { firstByteAt, tokenAt }
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
