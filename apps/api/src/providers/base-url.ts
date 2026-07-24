import { NoHealthyAccountError } from "@multi-ai-router/core"
import type { DriverAccount } from "./types"

/**
 * Where an Account's requests go: its own override first, the driver's pinned default second.
 * The override is what makes a self-hosted, proxied, or regional endpoint work without a new
 * driver, and it is the *only* input the `*-compatible` escape hatches have.
 *
 * An Account that resolves to no usable endpoint cannot serve anything, so it fails as
 * `NoHealthyAccountError` rather than a generic throw — the account id names the offender and no
 * credential material is involved.
 */
export function resolveBaseUrl(account: DriverAccount, pinnedDefault: string | null): URL {
  const candidate = account.baseUrl?.trim() || pinnedDefault

  if (!candidate) {
    throw new NoHealthyAccountError(
      `account ${account.id} (${account.provider}) has no base URL: this provider requires an operator-supplied endpoint`,
    )
  }

  try {
    return new URL(candidate)
  } catch {
    throw new NoHealthyAccountError(
      `account ${account.id} (${account.provider}) has an unusable base URL`,
    )
  }
}
