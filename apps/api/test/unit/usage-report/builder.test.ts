import { describe, expect, test } from "bun:test"
import type { UsageWeekRow } from "@multi-ai-router/db"
import { buildWeeklyReport } from "../../../src/services/usage-report/builder"
import type { ReportPeriod } from "../../../src/services/usage-report/types"

/**
 * The pure builder: rows, key labels and pools in, a report out. No database and no clock, so
 * every figure below is hand-summed from the fixture.
 */
const PERIOD: ReportPeriod = {
  start: new Date("2026-10-05T00:00:00.000Z"),
  end: new Date("2026-10-12T00:00:00.000Z"),
  generatedAt: new Date("2026-10-12T00:30:00.000Z"),
  settleMinutes: 30,
  upstreamTimeoutMs: 600_000,
  unpricedSince: "2026-01-01",
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const KEY = {
  alicePerson: id(1),
  aliceService: id(2),
  carol: id(3),
  bobKindless: id(4),
  noOwner: id(5),
  retired: id(6),
  gone: id(7),
}
const ACCOUNT = { a: id(11), overflow: id(12), other: id(13) }
const POOL = { p1: id(21), p2: id(22) }

const labels = new Map([
  [KEY.alicePerson, { name: "alice-editor", owner: "alice", ownerKind: "person", tool: "editor" }],
  [KEY.aliceService, { name: "alice-bot", owner: "alice", ownerKind: "service", tool: null }],
  [KEY.carol, { name: "carol-cli", owner: "carol", ownerKind: "person", tool: "cli" }],
  [KEY.bobKindless, { name: "bob-key", owner: "bob", ownerKind: null, tool: "cli" }],
  [KEY.noOwner, { name: "orphan-key", owner: null, ownerKind: null, tool: null }],
  [
    KEY.retired,
    { name: "old-bot", owner: "carol", ownerKind: "person", tool: "cli", retired: true },
  ],
] as const)

const pools = [
  { id: POOL.p1, name: "main", overflowAccountId: ACCOUNT.overflow },
  { id: POOL.p2, name: "side", overflowAccountId: null },
]

function row(over: Partial<UsageWeekRow>): UsageWeekRow {
  return {
    apiKeyId: null,
    accountId: null,
    poolId: null,
    model: "m1",
    requests: 0,
    attempts: 0,
    errors: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMetered: "0.000000",
    costNotional: "0.000000",
    unpricedAttempts: 0,
    ...over,
  }
}

const FIXTURE: UsageWeekRow[] = [
  row({
    apiKeyId: KEY.alicePerson,
    requests: 10,
    attempts: 12,
    tokensIn: 100,
    tokensOut: 50,
    costMetered: "1.100000",
    costNotional: "0.250000",
    unpricedAttempts: 1,
  }),
  row({
    apiKeyId: KEY.alicePerson,
    model: "m2",
    requests: 4,
    attempts: 4,
    tokensIn: 40,
    tokensOut: 20,
    costMetered: "0.200000",
    costNotional: "0.000001",
    unpricedAttempts: 0,
  }),
  row({
    apiKeyId: KEY.aliceService,
    requests: 3,
    attempts: 3,
    tokensIn: 30,
    tokensOut: 10,
    costMetered: "0.300000",
    costNotional: "0.000000",
    unpricedAttempts: 2,
  }),
  row({
    apiKeyId: KEY.carol,
    requests: 5,
    attempts: 5,
    tokensIn: 7,
    tokensOut: 3,
    costNotional: "2.000000",
  }),
  row({
    apiKeyId: KEY.retired,
    requests: 2,
    attempts: 2,
    tokensIn: 2,
    tokensOut: 1,
    costMetered: "0.100000",
  }),
  row({ apiKeyId: KEY.bobKindless, requests: 6, attempts: 6, tokensIn: 60, tokensOut: 6 }),
  row({
    apiKeyId: KEY.noOwner,
    requests: 7,
    attempts: 7,
    tokensIn: 70,
    tokensOut: 7,
    costMetered: "0.700000",
    unpricedAttempts: 3,
  }),
  row({
    apiKeyId: KEY.gone,
    requests: 8,
    attempts: 8,
    tokensIn: 80,
    tokensOut: 8,
    costNotional: "0.800000",
  }),
  row({ apiKeyId: null, requests: 9, attempts: 9, tokensIn: 0, tokensOut: 0, unpricedAttempts: 4 }),
]

const MEASURES = [
  "requests",
  "tokensIn",
  "tokensOut",
  "costMetered",
  "costNotional",
  "unpricedAttempts",
] as const

const micros = (value: string) => BigInt(value.replace(".", ""))

/** Sums one measure across sections and buckets, money as exact micro-units. */
function summed(report: ReturnType<typeof buildWeeklyReport>, measure: (typeof MEASURES)[number]) {
  const parts = [
    ...[report.sections.people, report.sections.services, report.sections.unknownKind].map(
      (section) => section.totals,
    ),
    report.buckets.unassigned,
    report.buckets.deleted,
    report.buckets.none,
  ]
  if (measure === "costMetered" || measure === "costNotional")
    return parts.reduce((n, part) => n + micros(part[measure]), 0n)
  return parts.reduce((n, part) => n + (part[measure] ?? 0), 0)
}

describe("sections by owner and tool", () => {
  const report = buildWeeklyReport(FIXTURE, labels, pools, PERIOD)

  test("a person and a service sharing a slug land in different sections", () => {
    const person = report.sections.people.lines.filter((line) => line.owner === "alice")
    const service = report.sections.services.lines.filter((line) => line.owner === "alice")
    expect(person).toHaveLength(1)
    expect(service).toHaveLength(1)
    expect(service[0]).toMatchObject({ owner: "alice", ownerKind: "service", tool: null })
  })

  test("two rows of one owner and tool fold into one line with hand-summed measures", () => {
    const line = report.sections.people.lines.find(
      (l) => l.owner === "alice" && l.tool === "editor",
    )
    expect(line).toEqual({
      owner: "alice",
      ownerKind: "person",
      tool: "editor",
      requests: 14,
      tokensIn: 140,
      tokensOut: 70,
      costMetered: "1.300000",
      costNotional: "0.250001",
      unpricedAttempts: 1,
    })
  })

  test("an owner with no kind goes to the unknown-kind section", () => {
    expect(report.sections.unknownKind.lines).toHaveLength(1)
    expect(report.sections.unknownKind.lines[0]).toMatchObject({
      owner: "bob",
      ownerKind: null,
      tool: "cli",
      requests: 6,
    })
    expect(report.sections.people.lines.some((l) => l.owner === "bob")).toBe(false)
  })

  test("a retired (tombstoned) key still attributes to its owner", () => {
    const line = report.sections.people.lines.find((l) => l.owner === "carol" && l.tool === "cli")
    expect(line?.requests).toBe(7)
    expect(line?.costMetered).toBe("0.100000")
    expect(line?.costNotional).toBe("2.000000")
  })

  test("section totals are the sum of their lines", () => {
    expect(report.sections.people.totals).toMatchObject({
      requests: 21,
      tokensIn: 149,
      tokensOut: 74,
      costMetered: "1.400000",
      costNotional: "2.250001",
    })
  })
})

describe("the three non-owner buckets", () => {
  const report = buildWeeklyReport(FIXTURE, labels, pools, PERIOD)

  test("unassigned (labelled key, no owner), deleted (no label) and none (null key) each total separately", () => {
    expect(report.buckets.unassigned).toMatchObject({
      requests: 7,
      tokensIn: 70,
      tokensOut: 7,
      costMetered: "0.700000",
      costNotional: "0.000000",
      unpricedAttempts: 3,
    })
    expect(report.buckets.deleted).toMatchObject({
      requests: 8,
      tokensIn: 80,
      tokensOut: 8,
      costMetered: "0.000000",
      costNotional: "0.800000",
    })
    expect(report.buckets.none).toMatchObject({ requests: 9, unpricedAttempts: 4 })
  })

  test("sections plus buckets equal the week totals, per measure", () => {
    expect(report.totals.requests).toBe(54)
    for (const measure of MEASURES) {
      const total =
        measure === "costMetered" || measure === "costNotional"
          ? micros(report.totals[measure])
          : (report.totals[measure] ?? 0)
      expect(summed(report, measure)).toEqual(total)
    }
  })
})

describe("NOTIONAL is labelled and never summed with METERED", () => {
  const report = buildWeeklyReport(FIXTURE, labels, pools, PERIOD)

  test("the payload names the two money measures apart and carries no combined cost", () => {
    expect(report.measureLabels.costMetered).toContain("METERED")
    expect(report.measureLabels.costNotional).toContain("NOTIONAL")
    for (const part of [report.totals, ...report.sections.people.lines]) {
      const keys = Object.keys(part)
      expect(keys).toContain("costMetered")
      expect(keys).toContain("costNotional")
      expect(keys.some((k) => /^(cost|total|spend)$/i.test(k))).toBe(false)
    }
  })
})

describe("unpriced attempts", () => {
  test("a week before the measure started reads unmeasured (null), never 0", () => {
    const unmeasured = FIXTURE.map((r) => ({ ...r, unpricedAttempts: null }))
    const report = buildWeeklyReport(unmeasured, labels, pools, PERIOD)
    expect(report.totals.unpricedAttempts).toBeNull()
    expect(report.sections.people.lines.every((l) => l.unpricedAttempts === null)).toBe(true)
    expect(report.buckets.none.unpricedAttempts).toBeNull()
    expect(report.caveats.find((c) => c.code === "unpriced_share")?.text).toContain("not measured")
  })

  test("a measured week states the unpriced share of attempts", () => {
    const report = buildWeeklyReport(FIXTURE, labels, pools, PERIOD)
    expect(report.totals.unpricedAttempts).toBe(10)
    const caveat = report.caveats.find((c) => c.code === "unpriced_share")
    expect(caveat?.text).toContain("10")
    expect(caveat?.text).toContain("56")
  })
})

describe("top models", () => {
  test("are ranked by tokens, with the null model kept as its own row", () => {
    const report = buildWeeklyReport(
      [
        row({ apiKeyId: KEY.carol, model: "big", tokensIn: 900, tokensOut: 100, requests: 1 }),
        row({ apiKeyId: KEY.carol, model: "small", tokensIn: 1, tokensOut: 1, requests: 1 }),
        row({ apiKeyId: KEY.carol, model: null, tokensIn: 50, tokensOut: 0, requests: 1 }),
      ],
      labels,
      pools,
      PERIOD,
    )
    expect(report.topModels.map((m) => m.model)).toEqual(["big", null, "small"])
    expect(report.topModels[0]).toMatchObject({ requests: 1, tokensIn: 900, tokensOut: 100 })
  })
})

describe("overflow share", () => {
  /** K: 6 on members + 2 on the overflow account in P1; 5 in P2; one null-pool preflight failure. */
  const rows = [
    row({ apiKeyId: KEY.aliceService, poolId: POOL.p1, accountId: ACCOUNT.a, attempts: 6 }),
    row({ apiKeyId: KEY.aliceService, poolId: POOL.p1, accountId: ACCOUNT.overflow, attempts: 2 }),
    row({ apiKeyId: KEY.aliceService, poolId: POOL.p2, accountId: ACCOUNT.a, attempts: 5 }),
    row({ apiKeyId: KEY.aliceService, poolId: null, accountId: null, attempts: 1 }),
    // A person key in the same pool, on the overflow account: it must produce no line.
    row({ apiKeyId: KEY.alicePerson, poolId: POOL.p1, accountId: ACCOUNT.overflow, attempts: 4 }),
  ]
  const report = buildWeeklyReport(rows, labels, pools, PERIOD)

  test("2 of 8 attempts is 25% for (K, P1)", () => {
    expect(report.overflow).toEqual([
      {
        keyName: "alice-bot",
        owner: "alice",
        ownerKind: "service",
        tool: null,
        poolName: "main",
        overflowAttempts: 2,
        attempts: 8,
        share: 0.25,
      },
    ])
  })

  test("there is no line for P2 (no overflow account), for the null pool, or for a person key", () => {
    expect(report.overflow.some((l) => l.poolName === "side")).toBe(false)
    expect(report.overflow.some((l) => l.keyName === "alice-editor")).toBe(false)
    expect(report.overflow).toHaveLength(1)
  })

  test("the caveat says the designation is the pool's as of generation time", () => {
    const caveat = report.caveats.find((c) => c.code === "overflow_designation")
    expect(caveat?.text).toContain("when this report was generated")
  })
})

describe("caveats", () => {
  test("carry the generation instant, the coverage and the dating basis", () => {
    const report = buildWeeklyReport(FIXTURE, labels, pools, PERIOD)
    expect(report.generatedAt).toBe("2026-10-12T00:30:00.000Z")
    expect(report.period).toEqual({ start: "2026-10-05", end: "2026-10-12" })
    expect(report.coverage.unpricedSince).toBe("2026-01-01")
    const codes = report.caveats.map((c) => c.code)
    expect(codes).toContain("coverage")
    expect(codes).toContain("dating")
    expect(codes).toContain("settle_margin")
  })

  test("a settle margin shorter than the upstream timeout is flagged", () => {
    const long = buildWeeklyReport(FIXTURE, labels, pools, {
      ...PERIOD,
      settleMinutes: 30,
      upstreamTimeoutMs: 3_600_000,
    })
    expect(long.coverage.settleCoversUpstreamTimeout).toBe(false)
    const short = buildWeeklyReport(FIXTURE, labels, pools, PERIOD)
    expect(short.coverage.settleCoversUpstreamTimeout).toBe(true)
  })
})

describe("what the payload never carries", () => {
  test("no account label or id, even when an account label is an email address", () => {
    const report = buildWeeklyReport(
      [
        row({
          apiKeyId: KEY.aliceService,
          poolId: POOL.p1,
          accountId: ACCOUNT.overflow,
          attempts: 3,
        }),
      ],
      labels,
      pools,
      PERIOD,
    )
    const text = JSON.stringify(report)
    expect(text).not.toContain(ACCOUNT.overflow)
    expect(text).not.toContain(ACCOUNT.a)
    expect(text).not.toContain("@")
  })
})
