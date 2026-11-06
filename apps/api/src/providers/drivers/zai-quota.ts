import type { QuotaWindowKind, QuotaWindowState } from "@multi-ai-router/core"
import { z } from "zod"
import { advisoryWindow, epochMillis, type ProviderQuotaRead } from "../quota-read"
import type { RateLimitWindow } from "../types"

/**
 * The GLM Coding Plan's usage reading, off `GET /api/monitor/usage/quota/limit`. Sibling of
 * `zai.ts`. The reply:
 *
 *   {"code":200,"success":true,"data":{"level":"max","limits":[
 *     {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":0},
 *     {"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":100,"nextResetTime":<ms>},
 *     {"type":"TIME_LIMIT","unit":5,"number":1,"usage":4000,"remaining":4000,...}]}}
 *
 * Provenance: undocumented by z.ai — the path is the one the community usage tools read (openusage,
 * onWatch, the `quotas` crate's notes). Driven live from the production router with its Coding Max
 * key on 2026-11-06 23:02Z while that key answered `1310 … reset at 2026-11-10 10:02:31`: the weekly
 * entry read `percentage: 100`, `nextResetTime` 2026-11-10T02:02:31.996Z — the `1310` stamp read as
 * UTC+8 to the second, which is also the check on `zai.ts`'s offset. `unit` 3 is hours, 6 weeks,
 * 5 months; `percentage` is 0..100 consumed; a window not yet started carries no `nextResetTime`.
 *
 * `TIME_LIMIT` is the plan's monthly MCP tool-call allowance (web search, reader), not inference,
 * so it is not read: ranked on, it would steer requests by a quota no request here spends. A token
 * window of any other span travels as a limiter window under its own span name.
 *
 * Blast radius: every `zai` account's gauges, and how long a reset-less limit cools one. Nothing here
 * takes an Account out of rotation.
 */
const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit"

const TOKENS_LIMIT = "TOKENS_LIMIT"
const UNIT_WORDS: Readonly<Record<number, string>> = { 3: "hour", 5: "month", 6: "week" }

function namedKind(unit: number, number: number): QuotaWindowKind | null {
  if (unit === 3 && number === 5) return "five_hour"
  if (unit === 6 && number === 1) return "seven_day"
  return null
}

const Limit = z.looseObject({
  type: z.string(),
  unit: z.number(),
  number: z.number(),
  percentage: z.number().min(0).max(100),
  // A reset this cannot read costs the countdown, not the percentage beside it.
  nextResetTime: z.number().optional().catch(undefined),
})

const QuotaLimit = z.object({
  success: z.literal(true),
  data: z.looseObject({ limits: z.array(z.unknown()) }),
})

export const zaiQuotaRead: ProviderQuotaRead = {
  url: (account) => ((account.baseUrl ?? null) === null ? new URL(QUOTA_URL) : null),
  // Unobserved: what a key with no Coding Plan answers here.
  noPlanStatuses: new Set(),
  read: (body, at) => {
    const parsed = QuotaLimit.safeParse(body)
    if (!parsed.success) return null

    const quotaWindows: QuotaWindowState[] = []
    const windows: RateLimitWindow[] = []
    for (const raw of parsed.data.data.limits) {
      const limit = Limit.safeParse(raw)
      if (!limit.success || limit.data.type !== TOKENS_LIMIT) continue
      const { unit, number, percentage, nextResetTime } = limit.data
      const utilization = percentage / 100
      const resetsAt = epochMillis(nextResetTime)
      const kind = namedKind(unit, number)
      if (kind !== null) {
        quotaWindows.push(advisoryWindow(kind, utilization, resetsAt, at))
        continue
      }
      windows.push({
        limiter: `tokens-${number}-${UNIT_WORDS[unit] ?? `unit${unit}`}`,
        utilization,
        utilizationSource: "continuous",
        ...(resetsAt === undefined
          ? { resetSource: "unknown" as const }
          : { resetsAt, resetSource: "provider-reported" as const }),
      })
    }
    if (quotaWindows.length === 0 && windows.length === 0) return null

    return { limited: false, resetSource: "unknown", windows, quotaWindows }
  },
}
