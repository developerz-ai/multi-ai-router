import { usageCoverage } from "./usage-coverage"

/**
 * A complete `GET /api/admin/usage` body, built field by field from the API's own shape
 * (`services/usage-read/types.ts`), for tests that mount the whole Usage page.
 */

export interface WireTotalsOptions {
  readonly requests?: number
  readonly metered?: string
  readonly notional?: string
  readonly unpricedAttempts?: number | null
}

export function wireTotals(options: WireTotalsOptions = {}) {
  const requests = options.requests ?? 10
  return {
    requests,
    attempts: requests,
    errors: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMetered: options.metered ?? "0",
    costNotional: options.notional ?? "0",
    unpriced: {
      attempts: options.unpricedAttempts === undefined ? 0 : options.unpricedAttempts,
      since: "2026-01-01",
    },
  }
}

export function wireRow<Extra extends object>(
  id: string | null,
  label: string | null,
  note: "deleted" | "none" | "unassigned" | null,
  extra: Extra,
  totals: WireTotalsOptions = {},
) {
  return {
    id,
    label,
    note,
    totals: wireTotals(totals),
    latencyP50Ms: null,
    latencyP95Ms: null,
    routerOverheadP95Ms: null,
    series: [],
    ...extra,
  }
}

type WireRowLike = ReturnType<typeof wireRow>

export interface WireSummaryOptions {
  readonly totals?: WireTotalsOptions
  readonly byKey?: readonly WireRowLike[]
  readonly byOwner?: readonly WireRowLike[]
  readonly byTool?: readonly WireRowLike[]
  readonly byModel?: readonly WireRowLike[]
}

export function wireSummary(options: WireSummaryOptions = {}) {
  return {
    window: "7d",
    bucket: "day",
    from: "2026-07-18T00:00:00.000Z",
    to: "2026-07-25T00:00:00.000Z",
    totals: wireTotals(options.totals),
    coverage: usageCoverage(10),
    latency: { p50Ms: 1, p95Ms: 2, routerOverheadP95Ms: 1, ttfbP95Ms: 1 },
    failures: { attempts: 10, errors: 0, partial: false, byOutcome: [] },
    axis: [],
    series: [],
    byKey: options.byKey ?? [],
    byAccount: [],
    byPool: [],
    byModel: options.byModel ?? [],
    byOwner: options.byOwner ?? [],
    byTool: options.byTool ?? [],
  }
}

export function wireReport(
  periodStart: string,
  periodEnd: string,
  deliveryStatus: string,
  overrides: object = {},
) {
  return {
    periodStart,
    periodEnd,
    generatedAt: `${periodEnd}T01:00:00.000Z`,
    deliveryStatus,
    deliveryAttempts: 0,
    deliveredAt: null,
    lastError: null,
    ...overrides,
  }
}
