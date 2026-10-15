import type { UsageTotals } from "@multi-ai-router/db"

/** The zero reading of a window nothing touched; `unpriced` stays unmeasured, never 0. */
export const EMPTY_TOTALS: UsageTotals = {
  requests: 0,
  attempts: 0,
  errors: 0,
  tokensIn: 0,
  tokensOut: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMetered: "0",
  costNotional: "0",
  unpriced: { attempts: null, since: "infinity" },
}
