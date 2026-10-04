import { createDatabase, createSessionRepository } from "@multi-ai-router/db"
import { apiKeys } from "../../../packages/db/src/schema/api-keys"
import { createSessionStore } from "../src/providers"
import { positiveBinding } from "./binding-positive"
import { benchApp } from "./harness"
import { stubUpstream, TRIP_HEADER } from "./upstream"

/** A deliberately held single main-pool connection, never a real upstream. */
export async function runBindingContention(url: string, requests = 100, holdMs = 20, warmup = 20) {
  const database = createDatabase({ url, maxConnections: 1 })
  const keyId = crypto.randomUUID()
  const repository = createSessionRepository(database.db)
  const results = []
  try {
    await database.db
      .insert(apiKeys)
      .values({ id: keyId, name: "offline-binding-bench", value: "offline", prefix: keyId })
    for (const promptBytes of [1024, 280000]) {
      for (const provider of ["anthropic-api", "openrouter"] as const) {
        for (const stream of [false, true]) {
          for (const cache of ["unique-indexed-miss", "negative-hit"] as const) {
            for (const occupied of [false, true]) {
              let queries = 0
              let warmupQueries = 0
              let measured = false
              const sessions = createSessionStore({
                repository: {
                  ...repository,
                  findByKey: (id, key) => {
                    queries++
                    return repository.findByKey(id, key)
                  },
                },
                now: () => new Date(),
              })
              if (cache === "negative-hit") await sessions.binding(keyId, "cached-negative")
              queries = 0
              const bindingWait: number[] = [],
                overhead: number[] = [],
                duration: number[] = []
              const ttft: number[] = []
              const uploadWait: number[] = []
              let failures = 0,
                buffered = 0
              const upstream = stubUpstream({
                dialect: provider === "anthropic-api" ? "anthropic" : "openai-chat",
                stream,
                chunks: 3,
                chunkGapMs: 1,
                firstByteDelayMs: 2,
              })
              const bench = benchApp({
                provider,
                upstream,
                sessions,
                bindingKeyId: keyId,
                subscriptionPresent: true,
                onBindingWait: (ms) => {
                  if (measured) bindingWait.push(ms)
                },
                onTerminal: (sample) => {
                  if (!measured) return
                  duration.push(sample.durationMs)
                  uploadWait.push(sample.bodyReadMs ?? 0)
                },
                onUsage: (record) => {
                  if (measured) overhead.push(record.routerOverheadMs)
                },
              })
              for (let index = -warmup; index < requests; index++) {
                if (index === 0) {
                  await bench.settle()
                  warmupQueries = queries
                  queries = 0
                  measured = true
                }

                const tripId = crypto.randomUUID()
                const trip = upstream.open(tripId)
                // reserve() resolves only after ownership; release timer bounds deliberate occupancy.
                const held = occupied ? await database.sql.reserve() : undefined
                let released = false
                const releaseHeld = () => {
                  if (!released) {
                    released = true
                    held?.release()
                  }
                }
                const release = held === undefined ? undefined : setTimeout(releaseHeld, holdMs)
                try {
                  const response = await bench.app.request("/v1/messages", {
                    method: "POST",
                    headers: {
                      authorization: `Bearer ${bench.key}`,
                      "content-type": "application/json",
                      "x-session-id":
                        cache === "negative-hit" ? "cached-negative" : `miss-${tripId}`,
                      [TRIP_HEADER]: tripId,
                    },
                    body: JSON.stringify({
                      model: "claude-opus-5",
                      max_tokens: 64,
                      stream,
                      messages: [{ role: "user", content: "x".repeat(promptBytes) }],
                    }),
                  })
                  if (response.status !== 200)
                    throw Error(`fixture response ${response.status}: ${await response.text()}`)
                  if (response.body !== null) {
                    const reader = response.body.getReader()
                    let first = 0
                    for (;;) {
                      const chunk = await reader.read()
                      if (chunk.done) break
                      if (!first) first = performance.now()
                    }
                    if (measured && stream && first) {
                      ttft.push(first - trip.upstreamFirstByteAt)
                      if (first > trip.upstreamLastByteAt) buffered++
                    }
                  }
                } finally {
                  if (release !== undefined) clearTimeout(release)
                  releaseHeld()
                }
              }
              await bench.settle()
              const expectedQueries = cache === "negative-hit" ? 0 : requests
              if (queries !== expectedQueries)
                throw Error(`lookup count ${queries}, expected ${expectedQueries}`)
              if (failures || buffered)
                throw Error(`invalid measurement: failures=${failures}, buffered=${buffered}`)
              results.push({
                promptBytes,
                path: provider === "anthropic-api" ? "passthrough" : "translate",
                stream,
                cache,
                occupied,
                requests,
                queries,
                discardedWarmupRequests: warmup,
                discardedWarmupQueries: warmupQueries,
                failures,
                buffered,
                bindingWaitMs: summary(bindingWait),
                routerOverheadMs: summary(overhead),
                terminalDurationMs: summary(duration),
                bodyReadWaitMs: summary(uploadWait),
                addedTtftMs: summary(ttft),
              })
            }
          }
        }
      }
    }
    const positive = await positiveBinding(database, keyId, requests, holdMs, warmup)
    return {
      positive,
      scope: "offline actual dispatcher + PostgreSQL single pool; no provider or CLI",
      holdMs,
      results,
    }
  } finally {
    try {
      await database.sql`delete from api_keys where id = ${keyId}`
    } finally {
      await database.close()
    }
  }
}
function summary(values: number[]) {
  const ordered = values.toSorted((a, b) => a - b)
  const at = (p: number) => ordered[Math.max(0, Math.ceil(p * ordered.length) - 1)] ?? null
  return { count: ordered.length, p50: at(0.5), p95: at(0.95), p99: at(0.99) }
}
if (import.meta.main) {
  const url = process.env.DATABASE_URL
  if (!url) throw Error("DATABASE_URL must name a disposable migrated fixture database")
  const requests = Number(process.env.BINDING_BENCH_REQUESTS ?? 100)
  const warmup = Number(process.env.BINDING_BENCH_WARMUP ?? 20)
  const holdMs = Number(process.env.BINDING_BENCH_HOLD_MS ?? 20)
  if (
    !Number.isSafeInteger(warmup) ||
    warmup < 0 ||
    warmup > 1000 ||
    !Number.isSafeInteger(requests) ||
    requests < 1 ||
    requests > 1000 ||
    !Number.isFinite(holdMs) ||
    holdMs < 1 ||
    holdMs > 1000
  )
    throw Error("invalid bounded benchmark settings")
  console.log(JSON.stringify(await runBindingContention(url, requests, holdMs, warmup), null, 2))
}
