import type { QuotaWindowKind, QuotaWindowState } from "@multi-ai-router/core"
import { z } from "zod"
import type { ProviderQuotaRead } from "../quota-read"
import type { RateLimitWindow } from "../types"

/**
 * The Go plan's usage reading, off `GET /zen/go/v1/usage`. Sibling of `opencode-go.ts`, as
 * `openai-oauth-quota.ts` is of its driver. The reply:
 *
 *   {"usage":{"rolling":{"status":"ok","percent":0,"resetsAt":"..."},"weekly":{...},"monthly":{...}}}
 *
 * Provenance: driven live with a real key on 2026-11-06. **Only `percent: 0` has been seen**, so that
 * `percent` runs 0..100 rather than 0..1 is read from its name, and `resetsAt` as a date string is
 * unconfirmed beyond parsing. A key with no Go plan answers `403 EntitlementError`. Blast radius:
 * every `opencode-go` account's gauges; nothing else, because every window here is advisory.
 *
 * `rolling` and `weekly` map onto `five_hour` and `seven_day`. `monthly` has no `QuotaWindowKind`,
 * so it travels as a limiter window under the provider's own word, the rule for a window the
 * router's vocabulary does not name (`RateLimitWindow`). It is ranked on and not persisted.
 *
 * Every named window is `advisory: true`. The plan's limits are per model and these readings are
 * per account, so one spent window says nothing certain about the model a request asks for: the
 * upstream's own `429` stays the only thing that takes an Account out of rotation.
 */
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage"

const NAMED_WINDOWS = {
  rolling: "five_hour",
  weekly: "seven_day",
} as const satisfies Readonly<Record<string, QuotaWindowKind>>

/** Provenance: the one status beside `ok` observed or documented, 2026-11-06. */
const RATE_LIMITED = "rate-limited"

const resetInstant = z
  .string()
  .transform((value) => new Date(value))
  .refine((date) => !Number.isNaN(date.getTime()))

const Window = z.looseObject({
  status: z.string().optional(),
  percent: z.number().nonnegative(),
  // A reset this cannot read costs the countdown, not the percentage beside it.
  resetsAt: resetInstant.optional().catch(undefined),
})

const Usage = z.object({
  usage: z.looseObject({
    rolling: Window.optional(),
    weekly: Window.optional(),
    monthly: Window.optional(),
  }),
})

type Reading = z.infer<typeof Window>

/**
 * The plan's own verdict outranks the arithmetic: an upstream saying a window is limited has no
 * headroom there, whatever percentage it printed beside that.
 */
function utilization(reading: Reading): number {
  if (reading.status === RATE_LIMITED) return 1
  return Math.min(reading.percent / 100, 1)
}

function resetFacts(reading: Reading): Pick<RateLimitWindow, "resetsAt" | "resetSource"> {
  return reading.resetsAt === undefined
    ? { resetSource: "unknown" }
    : { resetsAt: reading.resetsAt, resetSource: "provider-reported" }
}

function namedWindow(window: QuotaWindowKind, reading: Reading, at: Date): QuotaWindowState {
  return {
    window,
    utilization: utilization(reading),
    utilizationSource: "continuous",
    ...resetFacts(reading),
    lastCheckedAt: at,
    advisory: true,
  }
}

export const opencodeGoQuotaRead: ProviderQuotaRead = {
  url: (account) => ((account.baseUrl ?? null) === null ? new URL(USAGE_URL) : null),
  noPlanStatuses: new Set([403]),
  read: (body, at) => {
    const parsed = Usage.safeParse(body)
    if (!parsed.success) return null
    const { rolling, weekly, monthly } = parsed.data.usage

    const quotaWindows: QuotaWindowState[] = []
    if (rolling !== undefined) quotaWindows.push(namedWindow(NAMED_WINDOWS.rolling, rolling, at))
    if (weekly !== undefined) quotaWindows.push(namedWindow(NAMED_WINDOWS.weekly, weekly, at))
    const windows: RateLimitWindow[] =
      monthly === undefined
        ? []
        : [
            {
              limiter: "monthly",
              utilization: utilization(monthly),
              utilizationSource: "continuous",
              ...resetFacts(monthly),
            },
          ]
    if (quotaWindows.length === 0 && windows.length === 0) return null

    return { limited: false, resetSource: "unknown", windows, quotaWindows }
  },
}
