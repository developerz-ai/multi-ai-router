/** Unified HTTP quota headers into the same vocabulary the SDK quota store already consumes. */
export function reportFastQuota(headers: Headers, report?: (info: unknown) => void): void {
  if (!report) return
  const prefix = "anthropic-ratelimit-unified-"
  let windows = 0
  let rejected = false
  for (const [key, type] of [
    ["5h", "five_hour"],
    ["7d", "seven_day"],
  ] as const) {
    const status = headers.get(`${prefix}${key}-status`)
    if (status === null) continue
    windows++
    rejected ||= status === "rejected"
    report({
      status,
      rateLimitType: type,
      resetsAt: number(headers.get(`${prefix}${key}-reset`)),
      utilization: number(headers.get(`${prefix}${key}-utilization`)),
      overageStatus: headers.get(`${prefix}overage-status`),
      overageResetsAt: number(headers.get(`${prefix}overage-reset`)),
    })
  }
  const status = headers.get(`${prefix}status`)
  if (status !== null && (windows === 0 || (status === "rejected" && !rejected)))
    report({
      status,
      resetsAt: number(headers.get(`${prefix}reset`)),
      overageStatus: headers.get(`${prefix}overage-status`),
    })
}
function number(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}
