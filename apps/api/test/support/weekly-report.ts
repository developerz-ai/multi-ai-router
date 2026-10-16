import type { ReportMeasures, WeeklyReport } from "../../src/services/usage-report/types"

/**
 * A stored-weekly-report fixture for delivery tests (issue #229). Hand-built to the payload
 * contract rather than run through the builder — delivery renders whatever #227 stored, and these
 * tests pin the renderer, not the aggregation. Names are generic; the overflow line is the only
 * place key and pool names legitimately appear, and no account label exists in the shape at all.
 */

export function measures(over: Partial<ReportMeasures> = {}): ReportMeasures {
  return {
    requests: 10,
    tokensIn: 100,
    tokensOut: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMetered: "1.000000",
    costNotional: "0.000000",
    unpricedAttempts: 0,
    ...over,
  }
}

const zero = measures({ requests: 0, tokensIn: 0, tokensOut: 0, costMetered: "0.000000" })

export function weeklyReportFixture(over: Partial<WeeklyReport> = {}): WeeklyReport {
  return {
    version: 1,
    period: { start: "2026-10-05", end: "2026-10-12" },
    generatedAt: "2026-10-12T00:30:00.000Z",
    coverage: {
      timeBasis: "event-time",
      requestsDatedBy: "settled-at",
      attemptsDatedBy: "started-at",
      upstreamTimeoutMs: 600_000,
      generatedAfterPeriodEndMinutes: 30,
      settleCoversUpstreamTimeout: true,
      unpricedSince: "2026-01-01",
      unpricedMeasured: "full",
    },
    measureLabels: {
      requests: "Requests",
      tokensIn: "Input tokens",
      tokensOut: "Output tokens",
      cacheReadTokens: "Cache read tokens",
      cacheWriteTokens: "Cache write tokens",
      costMetered: "METERED $ (billed per token)",
      costNotional: "NOTIONAL $ (attribution, never added to METERED)",
      unpricedAttempts: "Unpriced attempts (not measured when null)",
    },
    totals: measures({ requests: 30, tokensIn: 300, tokensOut: 150, costMetered: "3.000000" }),
    sections: {
      people: {
        lines: [
          { ...measures(), owner: "alice", ownerKind: "person", tool: "editor" },
          { ...measures({ requests: 5 }), owner: "carol", ownerKind: "person", tool: null },
        ],
        totals: measures({ requests: 15 }),
      },
      services: {
        lines: [{ ...measures({ requests: 8 }), owner: "build-bot", ownerKind: "service", tool: null }],
        totals: measures({ requests: 8 }),
      },
      unknownKind: { lines: [], totals: zero },
    },
    buckets: { unassigned: zero, deleted: zero, none: measures({ requests: 7 }) },
    topModels: [
      { ...measures({ requests: 20 }), model: "big-model" },
      { ...measures({ requests: 10 }), model: "small-model" },
    ],
    overflow: [
      {
        keyName: "build-bot-key",
        owner: "build-bot",
        ownerKind: "service",
        tool: null,
        poolName: "main",
        provider: "openai-oauth",
        overflowAttempts: 3,
        attempts: 8,
        share: 0.375,
      },
    ],
    caveats: [{ code: "dating", text: "Requests are dated by settlement." }],
    ...over,
  }
}

/**
 * A report that cannot fit any embed: `count` lines per owner section with `nameLength`-character
 * owner names, ten top models and ten overflow lines. The renderer's limit assertions run on this.
 */
export function oversizedWeeklyReport(count = 400, nameLength = 120): WeeklyReport {
  const longName = (i: number) => `owner-${i}-`.padEnd(nameLength, "x")
  const line = (i: number) => ({
    ...measures({ requests: i }),
    owner: longName(i),
    ownerKind: "person" as const,
    tool: "editor",
  })
  return weeklyReportFixture({
    sections: {
      people: { lines: Array.from({ length: count }, (_, i) => line(i)), totals: measures() },
      services: {
        lines: Array.from({ length: count }, (_, i) => ({
          ...line(i),
          ownerKind: "service" as const,
        })),
        totals: measures(),
      },
      unknownKind: { lines: Array.from({ length: 30 }, (_, i) => line(i)), totals: measures() },
    },
    topModels: Array.from({ length: 10 }, (_, i) => ({
      ...measures(),
      model: `model-${i}-${"y".repeat(60)}`,
    })),
    overflow: Array.from({ length: 10 }, (_, i) => ({
      keyName: `key-${i}-${"z".repeat(80)}`,
      owner: longName(i),
      ownerKind: "service" as const,
      tool: null,
      poolName: `pool-${i}-${"w".repeat(80)}`,
      provider: "openai-oauth",
      overflowAttempts: 4,
      attempts: 9,
      share: 0.44,
    })),
    caveats: Array.from({ length: 5 }, (_, i) => ({
      code: "coverage" as const,
      text: `A long caveat number ${i}: ${"c".repeat(300)}`,
    })),
  })
}

/** The fixture as the repository would hand it back: through a JSON round trip, typed unknown. */
export function storedPayload(report: WeeklyReport = weeklyReportFixture()): unknown {
  return JSON.parse(JSON.stringify(report))
}
