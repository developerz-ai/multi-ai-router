import { describe, expect, test } from "bun:test"
import type { UsageExportRow } from "@multi-ai-router/db"
import {
  renderUsageCsv,
  USAGE_EXPORT_CHUNK_ROWS,
  usageCsvChunks,
  usageCsvStream,
} from "../../../src/services/usage-read/export"

/**
 * The export body is produced in bounded chunks (issue #226 review): rendering 50k rows in one
 * synchronous pass blocks the event loop the /v1 traffic shares, so the body is a stream whose
 * pull() renders at most one chunk and yields before the next.
 */
const subjects = {
  labels: { keys: new Map(), accounts: new Map(), pools: new Map() },
  providers: new Map(),
}
const row = (n: number): UsageExportRow => ({
  day: "2026-10-15",
  apiKeyId: null,
  accountId: null,
  poolId: null,
  model: `m${n}`,
  requests: n,
  attempts: n,
  errors: 0,
  tokensIn: 1,
  tokensOut: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMetered: "0.000000",
  costNotional: "0.000000",
  unpricedAttempts: 0,
})
const rows = (count: number) => Array.from({ length: count }, (_, i) => row(i))

describe("usage CSV chunking", () => {
  test("more rows than a chunk yields several chunks, each bounded, joining to the single-pass render", () => {
    const all = rows(USAGE_EXPORT_CHUNK_ROWS * 2 + 7)
    const chunks = [...usageCsvChunks(all, subjects)]
    expect(chunks.length).toBeGreaterThan(2)
    for (const chunk of chunks) {
      // header line + at most one chunk of rows
      expect(chunk.split("\r\n").length - 1).toBeLessThanOrEqual(USAGE_EXPORT_CHUNK_ROWS + 1)
    }
    expect(chunks.join("")).toBe(renderUsageCsv(all, subjects))
  })

  test("no rows is just the header, once", () => {
    expect([...usageCsvChunks([], subjects)].join("")).toBe(renderUsageCsv([], subjects))
    expect(renderUsageCsv([], subjects).startsWith("day,owner,")).toBe(true)
  })

  test("the stream emits one chunk per pull and decodes to the same body", async () => {
    const all = rows(USAGE_EXPORT_CHUNK_ROWS + 5)
    const reader = usageCsvStream(all, subjects).getReader()
    const parts: Uint8Array[] = []
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      parts.push(next.value)
    }
    expect(parts.length).toBeGreaterThan(1)
    expect(new TextDecoder().decode(Buffer.concat(parts))).toBe(renderUsageCsv(all, subjects))
  })
})
