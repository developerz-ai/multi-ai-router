import type { QuotaWindowState } from "@multi-ai-router/core"
import { z } from "zod"
import { advisoryWindow, type ProviderQuotaRead } from "../quota-read"

/**
 * The Kimi coding plan's usage reading, off `GET /coding/v1/usages`. Sibling of `kimi.ts`. The
 * reply carries three spellings of the same two windows; this reads the plainest:
 *
 *   {"usage":{...},"limits":[...],
 *    "usages":{"limit_5h":{"used_ratio":0,"reset_time":"2026-11-07T03:31:49Z"},
 *              "limit_7d":{"used_ratio":1,"reset_time":"2026-11-12T14:31:49Z"}}}
 *
 * Provenance: undocumented in Kimi's coding docs. Driven live from the production router with
 * its key on 2026-11-06 23:02Z while that key was refused with Kimi's weekly-limit `403`: `limit_7d`
 * read `used_ratio: 1`, `limit_5h` `0`. `used_ratio` is consumed, 0..1, by its name and those two
 * values; the sibling `usage` block (`limit: "100"`, `used: "100"`, the same weekly reset) agrees.
 *
 * This is what gives a Kimi limit its real reset. The `403` names no instant, so the driver's rules
 * carry only an estimated re-test cadence (`kimi.ts`); with this reading held, a refused request
 * cools until the provider's own reset (`routing/quota.ts`, `spentPlanReset`).
 *
 * Blast radius: every `kimi` account's gauges, and how long a weekly or 5-hour refusal cools one.
 * Nothing here takes an Account out of rotation.
 */
const USAGES_URL = "https://api.kimi.com/coding/v1/usages"

const instant = z
  .string()
  .transform((value) => new Date(value))
  .refine((date) => !Number.isNaN(date.getTime()))

const Window = z.looseObject({
  used_ratio: z.number().min(0).max(1),
  // A reset this cannot read costs the countdown, not the ratio beside it.
  reset_time: instant.optional().catch(undefined),
})

const Usages = z.object({
  usages: z.looseObject({
    limit_5h: Window.optional(),
    limit_7d: Window.optional(),
  }),
})

export const kimiQuotaRead: ProviderQuotaRead = {
  url: (account) => ((account.baseUrl ?? null) === null ? new URL(USAGES_URL) : null),
  // Unobserved: what a key with no coding plan answers here.
  noPlanStatuses: new Set(),
  read: (body, at) => {
    const parsed = Usages.safeParse(body)
    if (!parsed.success) return null
    const { limit_5h: fiveHour, limit_7d: weekly } = parsed.data.usages

    const quotaWindows: QuotaWindowState[] = []
    if (fiveHour !== undefined)
      quotaWindows.push(advisoryWindow("five_hour", fiveHour.used_ratio, fiveHour.reset_time, at))
    if (weekly !== undefined)
      quotaWindows.push(advisoryWindow("seven_day", weekly.used_ratio, weekly.reset_time, at))
    if (quotaWindows.length === 0) return null

    return { limited: false, resetSource: "unknown", windows: [], quotaWindows }
  },
}
