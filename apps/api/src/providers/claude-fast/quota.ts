import { MODEL_SCOPED_WINDOWS } from "../claude-sdk/quota-reading"

const PREFIX = "anthropic-ratelimit-unified-"

/**
 * Unified HTTP quota headers into the same vocabulary the SDK quota store already consumes.
 *
 * Every response states the windows it names and, in `unified-status`, the verdict on the whole
 * request; `representative-claim` names the window that decided it. `requestAttributable` says the
 * refusal was the request's doing (`failure-rules-quota.ts`): the windows are still read, and the
 * verdict — which would cool the Account for it — is not.
 */
export function reportFastQuota(
  headers: Headers,
  report: ((info: unknown) => void) | undefined,
  options: { readonly requestAttributable?: boolean } = {},
): void {
  if (!report) return
  const overall = headers.get(`${PREFIX}status`)
  const overage = {
    overageStatus: headers.get(`${PREFIX}overage-status`),
    overageResetsAt: number(headers.get(`${PREFIX}overage-reset`)),
  }
  let windows = 0
  let rejected = false
  for (const [key, type] of [
    ["5h", "five_hour"],
    ["7d", "seven_day"],
  ] as const) {
    const status = headers.get(`${PREFIX}${key}-status`)
    if (status === null) continue
    windows++
    rejected ||= status === "rejected"
    report({
      status,
      rateLimitType: type,
      resetsAt: number(headers.get(`${PREFIX}${key}-reset`)),
      utilization: number(headers.get(`${PREFIX}${key}-utilization`)),
      ...overage,
      // Measured on every response, not raised near a limit (`claude-sdk/quota.ts` `ingest`).
      utilizationSource: "continuous",
      ...(overall === null ? {} : { requestStatus: overall }),
    })
  }
  if (overall === null || options.requestAttributable === true) return
  if (windows > 0 && (overall !== "rejected" || rejected)) return
  const claim = headers.get(`${PREFIX}representative-claim`)?.trim()
  report({
    status: overall,
    ...(claim === undefined || claim === "" ? {} : { rateLimitType: claim }),
    resetsAt: number(headers.get(`${PREFIX}reset`)),
    overageStatus: overage.overageStatus,
  })
}

/**
 * The model-scoped window a refusal names, with its reset — `null` for a refusal about the Account.
 * What makes a spent Opus week hold Opus on this Account instead of the Account
 * (docs/idea/05-routing-and-failover.md, T3).
 */
export function refusedModelClaim(
  headers: Headers,
): { readonly claim: string; readonly resetsAt: Date | undefined } | null {
  if (headers.get(`${PREFIX}status`) !== "rejected") return null
  const claim = headers.get(`${PREFIX}representative-claim`)?.trim() ?? ""
  if (!MODEL_SCOPED_WINDOWS.has(claim)) return null
  const reset = number(headers.get(`${PREFIX}reset`))
  return { claim, resetsAt: reset === undefined ? undefined : new Date(reset * 1_000) }
}

function number(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}
