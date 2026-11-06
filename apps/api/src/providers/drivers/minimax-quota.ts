import type { QuotaWindowState } from "@multi-ai-router/core"
import { z } from "zod"
import { advisoryWindow, epochMillis, type ProviderQuotaRead } from "../quota-read"

/**
 * The Token Plan's usage reading, off `GET /v1/token_plan/remains`. Sibling of `minimax.ts`, as
 * `opencode-go-quota.ts` is of its driver. The reply, one entry per model bucket:
 *
 *   {"model_remains":[{"model_name":"general","end_time":<ms>,"current_interval_status":1,
 *     "current_interval_remaining_percent":100,"weekly_end_time":<ms>,"current_weekly_status":2,
 *     "current_weekly_remaining_percent":0,...},{"model_name":"video",...}],
 *    "base_resp":{"status_code":0,"status_msg":"success"}}
 *
 * Provenance: platform.minimax.io/docs/token-plan/faq ("Use the API Endpoint", read 2026-11-06)
 * names the URL and the `Authorization: Bearer <Token Plan key>` call; it documents no reply. The
 * shape above was driven live from the production router with its Token Plan key on 2026-11-06
 * 23:02Z, while that key answered `429 … Token Plan usage limit reached … (2056)`: the `general`
 * bucket read weekly `status: 2`, `remaining_percent: 0`, interval `status: 1`, `100`. So `2` is
 * read as "spent", and `remaining_percent` as 0..100 of what is left. `api.minimax.io` (the
 * inference host) and the FAQ's `www.minimax.io` answered the same body.
 *
 * Only `general` is read: the FAQ puts text, image and audio models in it, under a 5-hour (here:
 * `interval`) and a weekly window. `video` has windows of its own and nothing this router serves.
 * The `*_usage_count` fields are not read: the legacy `coding_plan/remains` path answers the same
 * name with the count *remaining*, this one with zero on a plan billed in credits, and a field
 * that means opposite things on two paths is not a reading.
 *
 * Blast radius: every `minimax` account's gauges, and how long a reset-less `2056` cools one
 * (`routing/quota.ts`, `spentPlanReset`). Nothing here takes an Account out of rotation.
 */
const REMAINS_URL = "https://api.minimax.io/v1/token_plan/remains"

/** Provenance: the live reading above. Every other value reads from the percentage. */
const SPENT_STATUS = 2

const TEXT_BUCKET = "general"

const Bucket = z.looseObject({
  model_name: z.string(),
  end_time: z.number().optional(),
  current_interval_status: z.number().optional(),
  current_interval_remaining_percent: z.number().min(0).max(100).optional(),
  weekly_end_time: z.number().optional(),
  current_weekly_status: z.number().optional(),
  current_weekly_remaining_percent: z.number().min(0).max(100).optional(),
})

const Remains = z.object({
  base_resp: z.object({ status_code: z.literal(0) }),
  model_remains: z.array(Bucket),
})

function utilization(status: number | undefined, remainingPercent: number): number {
  return status === SPENT_STATUS ? 1 : 1 - remainingPercent / 100
}

export const miniMaxQuotaRead: ProviderQuotaRead = {
  url: (account) => ((account.baseUrl ?? null) === null ? new URL(REMAINS_URL) : null),
  // Unobserved: what a pay-as-you-go key answers here. A refusal of it lands as a logged failure.
  noPlanStatuses: new Set(),
  read: (body, at) => {
    const parsed = Remains.safeParse(body)
    if (!parsed.success) return null
    const text = parsed.data.model_remains.find((bucket) => bucket.model_name === TEXT_BUCKET)
    if (text === undefined) return null

    const quotaWindows: QuotaWindowState[] = []
    if (text.current_interval_remaining_percent !== undefined) {
      quotaWindows.push(
        advisoryWindow(
          "five_hour",
          utilization(text.current_interval_status, text.current_interval_remaining_percent),
          epochMillis(text.end_time),
          at,
        ),
      )
    }
    if (text.current_weekly_remaining_percent !== undefined) {
      quotaWindows.push(
        advisoryWindow(
          "seven_day",
          utilization(text.current_weekly_status, text.current_weekly_remaining_percent),
          epochMillis(text.weekly_end_time),
          at,
        ),
      )
    }
    if (quotaWindows.length === 0) return null

    return { limited: false, resetSource: "unknown", windows: [], quotaWindows }
  },
}
