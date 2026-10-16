import { KeyOwnerKind } from "@multi-ai-router/core"
import { z } from "zod"
import type { WeeklyReport } from "./types"

/**
 * The stored `usage_reports.payload` jsonb, validated once at the delivery boundary (issue #229).
 * The builder writes this shape and its own tests pin it; delivery reads the column back as
 * `unknown`, and a corrupt or foreign payload must fail delivery with a clean reason rather than
 * render `undefined` into a webhook post. Loose at the object level: a future payload addition
 * never fails an old parse, and the inferred type is directly assignable to {@link WeeklyReport},
 * so the validated parse is the only conversion delivery performs — no cast on unvalidated data.
 */

const measures = z.object({
  requests: z.number(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  costMetered: z.string(),
  costNotional: z.string(),
  unpricedAttempts: z.number().nullable(),
})

const ownerKind = KeyOwnerKind.nullable()

const reportLine: z.ZodType<WeeklyReport["sections"]["people"]["lines"][number]> = measures.extend({
  owner: z.string(),
  ownerKind,
  tool: z.string().nullable(),
})

const section: z.ZodType<WeeklyReport["sections"]["people"]> = z.object({
  lines: z.array(reportLine),
  totals: measures,
})

export const weeklyReportPayload = z.looseObject({
  version: z.literal(1),
  period: z.object({ start: z.string(), end: z.string() }),
  generatedAt: z.string(),
  coverage: z.looseObject({
    timeBasis: z.literal("event-time"),
    requestsDatedBy: z.literal("settled-at"),
    attemptsDatedBy: z.literal("started-at"),
    upstreamTimeoutMs: z.number(),
    generatedAfterPeriodEndMinutes: z.number(),
    settleCoversUpstreamTimeout: z.boolean(),
    unpricedSince: z.string(),
    unpricedMeasured: z.enum(["none", "partial", "full"]),
  }),
  measureLabels: z.object({
    requests: z.string(),
    tokensIn: z.string(),
    tokensOut: z.string(),
    cacheReadTokens: z.string(),
    cacheWriteTokens: z.string(),
    costMetered: z.string(),
    costNotional: z.string(),
    unpricedAttempts: z.string(),
  }),
  totals: measures,
  sections: z.object({
    people: section,
    services: section,
    unknownKind: section,
  }),
  buckets: z.object({ unassigned: measures, deleted: measures, none: measures }),
  topModels: z.array(measures.extend({ model: z.string().nullable() })),
  overflow: z.array(
    z.object({
      keyName: z.string(),
      owner: z.string().nullable(),
      ownerKind,
      tool: z.string().nullable(),
      poolName: z.string(),
      provider: z.string().nullable(),
      overflowAttempts: z.number(),
      attempts: z.number(),
      share: z.number(),
    }),
  ),
  caveats: z.array(
    z.object({
      code: z.enum([
        "unpriced_share",
        "overflow_designation",
        "coverage",
        "dating",
        "settle_margin",
      ]),
      text: z.string(),
    }),
  ),
})
