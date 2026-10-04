import type { SdkQuotaStore } from "../../providers"
import { accountHealthFacts, type HealthAccountFacts, sameAccountFacts } from "./health-observation"
import type { RoutableAccount } from "./types"

/** A new account intent must not inherit SDK buckets reported for the previous intent. */
export function quotaCatalogReconciler(quota: Pick<SdkQuotaStore, "forget">) {
  let held = new Map<string, HealthAccountFacts>()
  return (accounts: readonly RoutableAccount[]) => {
    const next = new Map<string, HealthAccountFacts>()
    for (const account of accounts) {
      const facts = accountHealthFacts(account)
      const previous = held.get(account.id)
      if (previous !== undefined && !sameAccountFacts(previous, facts)) quota.forget(account.id)
      next.set(account.id, facts)
    }
    for (const id of held.keys()) if (!next.has(id)) quota.forget(id)
    held = next
  }
}
