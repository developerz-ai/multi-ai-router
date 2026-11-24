import type {
  AccountEgressHealthRepository,
  AccountRepository,
  AccountRow,
  EgressHealthRow,
} from "@multi-ai-router/db"
import { assignmentOf } from "../../src/services/accounts/egress/view"

/** The account methods and the health table of 0059, over the same rows a memory store holds. */
export function memoryEgress(accounts: AccountRow[]) {
  const health = new Map<string, EgressHealthRow>()
  /** The row's `updated_at`: which account was attempted longest ago. */
  const touched = new Map<string, number>()
  let writes = 0
  const touch = (id: string) => void touched.set(id, ++writes)
  const current = (id: string, assignment: string) => {
    const proxy = accounts.find((row) => row.id === id)?.egressProxy
    return proxy != null && assignmentOf(proxy) === assignment
  }
  const methods: Pick<
    AccountRepository,
    | "assignEgressProxy"
    | "listDueEgressChecks"
    | "listHeldEgressProxies"
    | "listWithEgressProxy"
    | "swapEgressProxy"
  > = {
    listDueEgressChecks: async ({ limit }) =>
      (await methods.listWithEgressProxy())
        .filter((row) => row.status !== "disabled")
        .sort((a, b) => (touched.get(a.id) ?? 0) - (touched.get(b.id) ?? 0))
        .slice(0, limit),
    listHeldEgressProxies: async (exceptId) =>
      accounts.flatMap(({ id, egressProxy: held }) =>
        id === exceptId || held == null
          ? []
          : [
              {
                address: held.address,
                vendor: held.vendor ?? null,
                vendorId: held.vendorId ?? null,
              },
            ],
      ),
    assignEgressProxy: async ({ id, next, inheritReplace, now }) => {
      const row = accounts.find((candidate) => candidate.id === id)
      if (row === undefined) return undefined
      const kept = inheritReplace ? row.egressProxy?.replace : undefined
      row.egressProxy =
        next === null ? null : { ...next, ...(kept === undefined ? {} : { replace: kept }) }
      row.updatedAt = now
      return { ...row }
    },
    listWithEgressProxy: async () =>
      accounts.flatMap((row) =>
        row.egressProxy === null ? [] : [{ ...row, egressProxy: row.egressProxy }],
      ),
    swapEgressProxy: async (input) => {
      const { id, expectedSealed, next, exclusive, actor, now, recorded, expectedUpstream } = input
      const row = accounts.find((candidate) => candidate.id === id)
      if (row === undefined || row.egressProxy?.sealed !== expectedSealed) return undefined
      if (actor === "sweep" && row.egressProxy.replace !== "on-failure") return undefined
      if (
        expectedUpstream !== undefined &&
        (row.baseUrl !== expectedUpstream.baseUrl || row.dialect !== expectedUpstream.dialect)
      )
        return undefined
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
      const before = row.egressProxy
      row.egressProxy = next
      if (recorded !== undefined) {
        try {
          await repository.recordRepair({ accountId: id, repair: "idle", ...recorded })
        } catch (error) {
          // One transaction: a failed health write leaves the account as it was.
          row.egressProxy = before
          throw error
        }
      }
      row.updatedAt = now
      return { ...row }
    },
  }
  const repository: AccountEgressHealthRepository = {
    listForAccounts: async (ids) => ids.flatMap((id) => health.get(id) ?? []),
    recordAttempt: async ({ accountId, assignment }) => {
      if (!current(accountId, assignment)) return
      touch(accountId)
      if (health.has(accountId)) return
      health.set(accountId, {
        accountId,
        assignment,
        lastOutcome: null,
        lastStatus: null,
        latencyMs: null,
        consecutiveFailures: 0,
        lastCheckedAt: null,
        lastOkAt: null,
        repair: "idle",
        lastSwapAt: null,
        swaps: 0,
      })
    },
    recordCheck: async (input) => {
      if (!current(input.accountId, input.assignment)) return undefined
      touch(input.accountId)
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
      if (!current(input.accountId, input.assignment)) return
      touch(input.accountId)
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
