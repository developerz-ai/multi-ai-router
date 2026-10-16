import type { SqlConnection } from "@multi-ai-router/db"

/**
 * The issue #250 fixture: a ~30-day window whose rollup tables each hold
 * ~180k rows and whose raw table holds ~200k records, with durable
 * contributions only on the current partial day. `window = "30d"` then reads
 * the whole seeded history, which is the worst case the admin summary must
 * stay well under the request timeout for.
 */

export interface UsageBenchScale {
  /** Full days inside the window; the window spans this many days plus edges. */
  readonly days: number
  /** Rows per day per v2 rollup table (grain: key × model × basis). */
  readonly v2RowsPerDay: number
  /** Total `usage_records` rows, spread uniformly over the whole window. */
  readonly rawRows: number
  /** `usage_contributions` rows on the current partial day. */
  readonly contributionRows: number
}

/** The shape the issue measured: ~180k per rollup table, 200k raw. */
export const ISSUE_250_SCALE: UsageBenchScale = {
  days: 30,
  v2RowsPerDay: 6200,
  rawRows: 200_000,
  contributionRows: 50_000,
}

const MODELS = ["claude-opus-4-6", "claude-sonnet-5-5", "gpt-5.2", "glm-4.7"] as const
const DAY_MS = 86_400_000

/** Deterministic uuid for fixture entity n, stable across tables so joins line up. */
export function benchUuid(n: number): string {
  const h = new Bun.CryptoHasher("md5").update(String(n)).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** Distinct keys the v2 tables and raw rows reference, and the seeded window. */
export type SeededUsageFixture = { keys: number; window: { from: Date; to: Date } }

export async function seedUsageFixture(
  sql: SqlConnection,
  scale: UsageBenchScale,
): Promise<SeededUsageFixture> {
  await sql.unsafe(
    "truncate usage_attempt_daily_v2, usage_request_daily_v2, usage_records, usage_contributions",
  )
  const now = Date.now()
  const to = new Date(now)
  const from = new Date(now - scale.days * DAY_MS)
  const firstFull = new Date(Math.ceil(from.getTime() / DAY_MS) * DAY_MS)
  const lastFull = new Date(Math.floor(to.getTime() / DAY_MS) * DAY_MS)
  const days: string[] = []
  for (let t = firstFull.getTime(); t < lastFull.getTime(); t += DAY_MS)
    days.push(new Date(t).toISOString().slice(0, 10))
  const basisCombos = 4 * 2 // models × basis
  const keys = scale.v2RowsPerDay / basisCombos
  if (!Number.isInteger(keys)) throw new Error("v2RowsPerDay must be a multiple of 8")
  await seedV2(sql, days, keys, true)
  await seedV2(sql, days, keys, false)
  await seedRaw(sql, scale.rawRows, from, to, Math.min(keys * 2, 1550))
  await seedContributions(sql, scale.contributionRows, lastFull, keys)
  await sql.unsafe(
    "analyze usage_attempt_daily_v2, usage_request_daily_v2, usage_records, usage_contributions",
  )
  return { keys, window: { from, to } }
}

async function insertBatches(
  sql: SqlConnection,
  table: string,
  columns: string[],
  types: string[],
  columnsData: unknown[][],
) {
  for (let start = 0; start < columnsData[0].length; start += 10_000) {
    const slice = columnsData.map((c) => c.slice(start, start + 10_000))
    const params = slice.map(
      (c) =>
        `{${c
          .map((v) => (v === null ? "null" : `"${String(v).replace(/["\\]/g, "\\$&")}"`))
          .join(",")}}`,
    )
    const placeholders = types.map((t, i) => `$${i + 1}::${t}[]`).join(",")
    await sql.unsafe(
      `insert into ${table} (${columns.join(",")}) select * from unnest(${placeholders})`,
      params,
    )
  }
}

const V2_COLUMNS = [
  "id",
  "day",
  "api_key_id",
  "account_id",
  "pool_id",
  "model",
  "basis",
  "requests",
  "attempts",
  "errors",
  "tokens_in",
  "tokens_out",
  "cache_read_tokens",
  "cache_write_tokens",
  "cost_metered",
  "cost_notional",
] as const

const V2_TYPES = [
  "uuid",
  "date",
  "uuid",
  "uuid",
  "uuid",
  "text",
  "text",
  "bigint",
  "bigint",
  "bigint",
  "bigint",
  "bigint",
  "bigint",
  "bigint",
  "numeric",
  "numeric",
] as const

async function seedV2(sql: SqlConnection, days: string[], keys: number, attempt: boolean) {
  const table = attempt ? "usage_attempt_daily_v2" : "usage_request_daily_v2"
  const columns = [...V2_COLUMNS, ...(attempt ? ["unpriced_attempts"] : [])]
  const types = [...V2_TYPES, ...(attempt ? ["bigint"] : [])]
  const data: unknown[][] = columns.map(() => [])
  let n = 0
  for (const day of days)
    for (let k = 0; k < keys; k++)
      for (const model of MODELS)
        for (const basis of ["live", "legacy"] as const) {
          const r = 100 + (n % 400)
          const row: Record<string, unknown> = {
            id: benchUuid(n++),
            day,
            api_key_id: benchUuid(k),
            account_id: benchUuid(10_000 + (k % 6)),
            pool_id: benchUuid(20_000 + (k % 3)),
            model,
            basis,
            requests: basis === "live" ? r : Math.floor(r / 2),
            attempts: r,
            errors: n % 20 === 0 ? 1 : 0,
            tokens_in: r * 50,
            tokens_out: r * 20,
            cache_read_tokens: r * 200,
            cache_write_tokens: r * 5,
            cost_metered: (r * 0.002).toFixed(6),
            cost_notional: (r * 0.001).toFixed(6),
            ...(attempt
              ? { unpriced_attempts: basis === "live" ? (n % 7 === 0 ? 1 : 0) : null }
              : {}),
          }
          for (const [i, c] of columns.entries()) data[i].push(row[c])
        }
  await insertBatches(sql, table, [...columns], [...types], data)
}

async function seedRaw(sql: SqlConnection, rows: number, from: Date, to: Date, keys: number) {
  const columns = [
    "id",
    "correlation_id",
    "attempt",
    "api_key_id",
    "account_id",
    "pool_id",
    "provider",
    "model",
    "upstream_model",
    "ingress_dialect",
    "egress_mode",
    "tokens_in",
    "tokens_out",
    "cache_read_tokens",
    "cache_write_tokens",
    "cost_estimate",
    "cost_basis",
    "latency_ms",
    "ttfb_ms",
    "router_overhead_ms",
    "streamed",
    "http_status",
    "response_status",
    "outcome",
    "created_at",
  ]
  const types = [
    "uuid",
    "uuid",
    "integer",
    "uuid",
    "uuid",
    "uuid",
    "provider_id",
    "text",
    "text",
    "text",
    "text",
    "integer",
    "integer",
    "integer",
    "integer",
    "numeric",
    "cost_basis",
    "integer",
    "integer",
    "integer",
    "boolean",
    "integer",
    "smallint",
    "text",
    "timestamptz",
  ]
  const data: unknown[][] = columns.map(() => [])
  const span = to.getTime() - from.getTime()
  for (let i = 0; i < rows; i++) {
    const t = from.getTime() + Math.floor((i / rows) * span)
    const k = i % keys
    const r = 100 + (i % 400)
    const error = i % 20 === 0
    const row: Record<string, unknown> = {
      id: benchUuid(50_000_000 + i),
      correlation_id: benchUuid(60_000_000 + Math.floor(i / 2)),
      attempt: (i % 2) + 1,
      api_key_id: benchUuid(k),
      account_id: benchUuid(10_000 + (k % 6)),
      pool_id: benchUuid(20_000 + (k % 3)),
      provider: "anthropic-oauth",
      model: MODELS[i % MODELS.length],
      upstream_model: MODELS[i % MODELS.length],
      ingress_dialect: "anthropic-messages",
      egress_mode: "passthrough",
      tokens_in: r * 50,
      tokens_out: r * 20,
      cache_read_tokens: r * 200,
      cache_write_tokens: r * 5,
      cost_estimate: (r * 0.002).toFixed(6),
      cost_basis: "metered",
      latency_ms: 100 + (i % 4000),
      ttfb_ms: 50 + (i % 800),
      router_overhead_ms: i % 30,
      streamed: i % 3 === 0,
      http_status: error ? 500 : 200,
      response_status: error ? 500 : 200,
      outcome: error ? "upstream_error" : "success",
      created_at: new Date(t).toISOString(),
    }
    for (const [ci, c] of columns.entries()) data[ci].push(row[c])
  }
  await insertBatches(sql, "usage_records", columns, types, data)
}

async function seedContributions(sql: SqlConnection, rows: number, lastFull: Date, keys: number) {
  const columns = ["id", "kind", "day", "source", "payload_hash", "payload", "ingested_at"]
  const types = ["uuid", "text", "date", "text", "text", "jsonb", "timestamptz"]
  const data: unknown[][] = columns.map(() => [])
  const day = new Date().toISOString().slice(0, 10)
  for (let i = 0; i < rows; i++) {
    const t = lastFull.getTime() + Math.floor(((i % 1000) / 1000) * DAY_MS)
    const k = i % keys
    const r = 100 + (i % 400)
    const row: Record<string, unknown> = {
      id: benchUuid(70_000_000 + i),
      kind: i % 3 === 0 ? "terminal" : "attempt",
      day,
      source: "live",
      payload_hash: benchUuid(80_000_000 + i),
      payload: JSON.stringify({
        apiKeyId: benchUuid(k),
        accountId: benchUuid(10_000 + (k % 6)),
        poolId: benchUuid(20_000 + (k % 3)),
        model: MODELS[i % MODELS.length],
        correlationId: benchUuid(60_000_000 + Math.floor(i / 2)),
        eventAt: new Date(t).toISOString(),
        attempts: 1,
        requests: i % 3 === 0 ? 1 : 0,
        errors: i % 20 === 0 ? 1 : 0,
        tokensIn: r * 50,
        tokensOut: r * 20,
        cacheReadTokens: r * 200,
        cacheWriteTokens: r * 5,
        costMetered: (r * 0.002).toFixed(6),
        costNotional: (r * 0.001).toFixed(6),
        unpricedAttempts: 0,
      }),
      ingested_at: new Date(t).toISOString(),
    }
    for (const [ci, c] of columns.entries()) data[ci].push(row[c])
  }
  await insertBatches(sql, "usage_contributions", columns, types, data)
}
