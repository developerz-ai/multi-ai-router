import type { AccountBilling } from "@multi-ai-router/core"

/**
 * How an Account's billing mode is worded wherever the console shows it.
 *
 * One place, because the same two words appear on the add form, the edit dialog and the accounts
 * table, and the distinction they carry is the whole point: a `subscription` account's cost figure
 * is an attribution rather than a bill, and a table that called it "spend" in one column and
 * "notional" in another would be describing two things.
 */

/** What the operator picks between. `metered` is the default an unstated account holds. */
export const BILLING_OPTIONS: readonly { value: AccountBilling; label: string }[] = [
  { value: "metered", label: "Metered — billed per token" },
  { value: "subscription", label: "Subscription — flat fee for the period" },
]

/** One word for a dense table cell. */
export function billingLabel(billing: AccountBilling): string {
  return billing === "subscription" ? "subscription" : "metered"
}

/**
 * What pricing an account this way does to its usage figures — the consequence, not the setting.
 * Shown beside the control, because "metered vs subscription" only means something to an operator
 * who knows which column it moves.
 */
export function billingConsequence(billing: AccountBilling): string {
  return billing === "subscription"
    ? "A flat fee has no per-request charge, so this account's usage is valued at the vendor's public API rate and reported as notional — an attribution, shown apart from metered spend and never summed with it."
    : "Priced per token at the vendor's published rate and reported as real spend."
}
