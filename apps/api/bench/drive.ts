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
}

export interface Background {
  stop(): void
  failures(): number
  readonly settled: Promise<void>
}

const NO_BACKGROUND: Background = {
  stop: () => undefined,
  failures: () => 0,
  settled: Promise.resolve(),
}

/**
 * Keeps `backgroundStreams` long streams open until told to stop. Each worker opens the next as
 * soon as its last one ends, so the count in flight holds for the whole measurement. Their bodies
 * are drained and nothing about them is timed: they are load, not samples.
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
  return {
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
  const addedTtftMs: number[] = []
  const overheadMs: number[] = []
  let failures = 0
  let buffered = 0

  // Everything the client waited, less everything the upstream held it for. A request that never
  // reached the stub has no wait to subtract and is a failure already; it adds no sample.
  const settle = (trip: Trip, startedAt: number) => {
    if (trip.upstreamEnteredAt === 0 || trip.upstreamLastByteAt === 0) return
    const waited = trip.upstreamLastByteAt - trip.upstreamEnteredAt
    overheadMs.push(Math.max(0, performance.now() - startedAt - waited))
  }

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
    if (!scenario.stream || response.body === null) {
      await response.arrayBuffer()
      settle(trip, startedAt)
      return
    }

    trip.clientFirstByteAt = await drain(response.body)
    settle(trip, startedAt)
    if (trip.clientFirstByteAt > trip.upstreamLastByteAt) buffered += 1
    addedTtftMs.push(trip.clientFirstByteAt - trip.upstreamFirstByteAt)
  })

  return { failures, addedTtftMs, overheadMs, buffered }
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
