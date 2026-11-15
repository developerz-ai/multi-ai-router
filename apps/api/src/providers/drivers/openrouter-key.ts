import { z } from "zod"
import { advisoryWindow, type ProviderQuotaRead } from "../quota-read"

/**
 * An OpenRouter key's own spend cap, off `GET /api/v1/key`. Sibling of `openrouter.ts`.
 *
 *   {"data":{"label":"sk-or-v1-…","limit":30,"limit_reset":"daily","limit_remaining":0,
 *            "usage":41.2,"usage_daily":30.0,…}}
 *
 * Provenance: openrouter.ai/docs/api-reference/limits, read 2026-11-14 — `limit` is the key's credit
 * limit or null when unlimited, `limit_reset` the reset type (`daily` | `weekly` | `monthly`) or null
 * when it never resets, `limit_remaining` what is left of the current period; spend windows are UTC,
 * a daily one resets at 00:00 UTC, a weekly one on Monday 00:00 UTC, a monthly one on the 1st at
 * 00:00 UTC. The reply names no reset instant, so it is computed here from those documented
 * boundaries — the provider's own rule, which is why it reads as `provider-reported`.
 *
 * This is what gives a key cap its end. The refusal (`402`, or `403 Key limit exceeded`) names no
 * instant and reads as `credits-exhausted`; with this reading held and spent, the same refusal cools
 * the account until the boundary instead of parking it `exhausted` (`routing/plan-reset.ts`). A cap
 * that never resets carries no reset, so it still needs a human.
 *
 * Blast radius: every `openrouter` account's key-cap gauge, and whether a capped key comes back on
 * its own. Nothing here takes an Account out of rotation.
 */
const KEY_URL = "https://openrouter.ai/api/v1/key"

const LimitReset = z.enum(["daily", "weekly", "monthly"])
type LimitReset = z.infer<typeof LimitReset>

const Key = z.object({
  data: z.looseObject({
    limit: z.number().nonnegative().nullable(),
    limit_reset: LimitReset.nullable().optional(),
    limit_remaining: z.number().nullable().optional(),
  }),
})

const DAY_MS = 24 * 60 * 60 * 1_000

/** The first reset boundary strictly after `at`. Pure. */
export function nextKeyLimitReset(reset: LimitReset, at: Date): Date {
  const midnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())
  if (reset === "daily") return new Date(midnight + DAY_MS)
  if (reset === "weekly") {
    // getUTCDay: Sunday 0 … Saturday 6. Days until the next Monday, never zero.
    const ahead = (8 - at.getUTCDay()) % 7 || 7
    return new Date(midnight + ahead * DAY_MS)
  }
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1))
}

export const openRouterKeyRead: ProviderQuotaRead = {
  url: (account) => ((account.baseUrl ?? null) === null ? new URL(KEY_URL) : null),
  // Unobserved: a key the endpoint refuses is the request path's to hear about.
  noPlanStatuses: new Set(),
  // An uncapped key is the normal case for a pay-as-you-go balance: nothing to read, not a failure.
  noPlan: (body) => Key.safeParse(body).data?.data.limit === null,
  read: (body, at) => {
    const parsed = Key.safeParse(body)
    if (!parsed.success) return null
    const { limit, limit_reset: reset, limit_remaining: remaining } = parsed.data.data
    if (limit === null || remaining === null || remaining === undefined) return null
    const utilization = limit === 0 ? 1 : 1 - remaining / limit
    const resetsAt =
      reset === null || reset === undefined ? undefined : nextKeyLimitReset(reset, at)
    return {
      limited: false,
      resetSource: "unknown",
      windows: [],
      quotaWindows: [advisoryWindow("spend_limit", utilization, resetsAt, at)],
    }
  },
}
