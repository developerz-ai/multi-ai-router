import type {
  AccountEgressHealthRepository,
  AccountRepository,
  AccountRow,
  EgressHealthRow,
} from "@multi-ai-router/db"

/** The two account methods and the health table of 0059, over the same rows a memory store holds. */
export function memoryEgress(accounts: AccountRow[]) {
  const health = new Map<string, EgressHealthRow>()
  const methods: Pick<AccountRepository, "listWithEgressProxy" | "swapEgressProxy"> = {
    listWithEgressProxy: async () =>
      accounts.flatMap((row) =>
        row.egressProxy === null ? [] : [{ ...row, egressProxy: row.egressProxy }],
      ),
    swapEgressProxy: async ({ id, expectedSealed, next, exclusive, actor, now, recorded }) => {
      const row = accounts.find((candidate) => candidate.id === id)
      if (row === undefined || row.egressProxy?.sealed !== expectedSealed) return undefined
      if (actor === "sweep" && row.egressProxy.replace !== "on-failure") return undefined
      const taken = accounts.some(
        ({ id: other, egressProxy: held }) =>
          other !== id &&
          held != null &&
          (held.address === next.address ||
            (next.vendorId !== undefined &&
              held.vendor === next.vendor &&
              held.vendorId === next.vendorId)),
      )
      if (exclusive && taken) return undefined
      // First, so a failed health write leaves the account as it was: one transaction.
      if (recorded !== undefined)
        await repository.recordRepair({ accountId: id, repair: "idle", ...recorded })
      row.egressProxy = next
      row.updatedAt = now
      return { ...row }
    },
  }
  const repository: AccountEgressHealthRepository = {
    listForAccounts: async (ids) => ids.flatMap((id) => health.get(id) ?? []),
    recordCheck: async (input) => {
      const held = health.get(input.accountId)
      const same = held?.assignment === input.assignment ? held : undefined
      const ok = input.outcome === "ok"
      const row: EgressHealthRow = {
        accountId: input.accountId,
        assignment: input.assignment,
        lastOutcome: input.outcome,
        lastStatus: input.status,
        latencyMs: input.latencyMs,
        // `refused` is a proxy that answered: the run of failures is over, without an `ok` stamp.
        consecutiveFailures:
          ok || input.outcome === "refused"
            ? 0
            : (same?.consecutiveFailures ?? 0) + (input.countsAsFailure ? 1 : 0),
        lastCheckedAt: input.checkedAt,
        lastOkAt: ok ? input.checkedAt : (same?.lastOkAt ?? null),
        repair: ok ? "idle" : (same?.repair ?? "idle"),
        lastSwapAt: held?.lastSwapAt ?? null,
        swaps: held?.swaps ?? 0,
      }
      health.set(input.accountId, row)
      return row
    },
    recordRepair: async (input) => {
      const held = health.get(input.accountId)
      const same = held?.assignment === input.assignment ? held : undefined
      health.set(input.accountId, {
        accountId: input.accountId,
        assignment: input.assignment,
        lastOutcome: same?.lastOutcome ?? null,
        lastStatus: same?.lastStatus ?? null,
        latencyMs: same?.latencyMs ?? null,
        consecutiveFailures: same?.consecutiveFailures ?? 0,
        lastCheckedAt: held?.lastCheckedAt ?? null,
        lastOkAt: same?.lastOkAt ?? null,
        repair: input.repair,
        lastSwapAt: input.swappedAt ?? held?.lastSwapAt ?? null,
        swaps: (held?.swaps ?? 0) + (input.swappedAt === undefined ? 0 : 1),
      })
    },
  }
  return { methods, repository, health }
}
