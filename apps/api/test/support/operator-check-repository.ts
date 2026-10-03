import type { AccountRow } from "@multi-ai-router/db"
import type { OperatorRecoveryRepository } from "../../src/services/accounts/recheck"
/** A service fixture adapter. Real SQL reservation/exclusion is covered by PG integration. */
export function operatorCheckRepository(input: {
  begin: OperatorRecoveryRepository["beginOperatorRecovery"]
  find: (id: string) => AccountRow | undefined
  read?: OperatorRecoveryRepository["readOperatorCooldown"]
}): OperatorRecoveryRepository {
  return {
    beginOperatorRecovery: input.begin,
    readOperatorCooldown: input.read ?? (async () => undefined),
    reserveOperatorCheck: async ({ accountId, claimToken, leaseMs }) => {
      const held = await input.read?.(accountId)
      if (held !== undefined)
        return {
          kind: "cooldown",
          account: held.account,
          recovery: held.recovery,
          retryAt: held.recovery.nextAllowedAt,
        }
      const account = input.find(accountId)
      return account === undefined
        ? undefined
        : { kind: "acquired", account, claimToken, leaseUntil: new Date(Date.now() + leaseMs) }
    },
    finalizeOperatorCheck: async (inputValue) => {
      const result = await input.begin(inputValue)
      return result === undefined ? undefined : { kind: "committed", result }
    },
    releaseOperatorCheck: async () => {},
  }
}
