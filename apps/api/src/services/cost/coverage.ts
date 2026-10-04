import type { AccountBilling, ProviderId } from "@multi-ai-router/core"
import type { RateLookup } from "./rates"

export interface PriceAccount {
  readonly id: string
  readonly label: string
  readonly provider: ProviderId
  readonly billing: AccountBilling
  readonly models: readonly string[]
}
export interface UnpricedModel {
  readonly accountId: string
  readonly provider: ProviderId
  readonly model: string | null
  readonly reason: "missing_rate" | "unknown_model_catalog"
}
/** Only known configured upstream models are assessed; no sibling price or model is invented. */
export function unpricedModels(
  accounts: readonly PriceAccount[],
  lookup: RateLookup,
): readonly UnpricedModel[] {
  const rows: UnpricedModel[] = []
  for (const account of accounts) {
    if (account.models.length === 0) {
      rows.push({
        accountId: account.id,
        provider: account.provider,
        model: null,
        reason: "unknown_model_catalog",
      })
      continue
    }
    for (const model of new Set(account.models)) {
      if (
        lookup(account.provider, model, {
          accountId: account.id,
          billing: account.billing,
          cacheWriteTokens: 0,
        }) === null
      )
        rows.push({
          accountId: account.id,
          provider: account.provider,
          model,
          reason: "missing_rate",
        })
    }
  }
  return rows
}
