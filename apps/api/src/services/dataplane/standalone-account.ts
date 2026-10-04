import type { AccountRow } from "@multi-ai-router/db"
import type { DriverAccount } from "../../providers"
import type { RoutableAccount } from "./types"

/**
 * One account row dressed as the routing view `runAttempt` expects, for the admin plane's single
 * off-path calls (Test now, Discover models). Only `.id` and `.authMaterial` are read on that path
 * (`egress/credential.ts`); the rest exists to satisfy the shape and is never inspected.
 */
export function routableStandIn(
  account: AccountRow,
  driverAccount: DriverAccount,
): RoutableAccount {
  return {
    id: account.id,
    snapshot: {
      id: account.id,
      label: account.label,
      provider: account.provider,
      status: account.status,
      weight: account.weight,
      priority: account.priority,
      health: { consecutiveFailures: 0, inFlight: 0, recentTokens: 0 },
    },
    driver: driverAccount,
    billing: account.billing,
    authMaterial: account.authMaterial,
    lifecycleVersion: account.lifecycleVersion,
    healthRecoveryVersion: account.healthRecoveryVersion,
    authRecoveryVersion: account.authRecoveryVersion,
    configDir: account.configDir,
  }
}
