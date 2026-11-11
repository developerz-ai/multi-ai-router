import type { AccountObservation, AccountRow } from "@multi-ai-router/db"
import type { RecoveryCapability, RecoveryCoordinatorDeps, RecoveryRow } from "./types"

export function observation(row: AccountRow): AccountObservation {
  return {
    lifecycleVersion: row.lifecycleVersion,
    authMaterial: row.authMaterial,
    status: row.status,
  }
}

/** A standing block no permit may be issued or exposed for. */
export function standingBlock(account: AccountRow | undefined): boolean {
  return (
    account === undefined ||
    account.status === "disabled" ||
    account.status === "needs_reauth" ||
    account.status === "exhausted"
  )
}

/**
 * One read for many demanded accounts: a tick touching N accounts issued N `findById`s per phase
 * (plan 101, 03.11). Missing ids are simply absent from the map.
 */
export async function readAccounts(
  accounts: RecoveryCoordinatorDeps["accounts"],
  ids: readonly string[],
): Promise<ReadonlyMap<string, AccountRow>> {
  if (ids.length === 0) return new Map()
  const rows = await accounts.findByIds([...new Set(ids)])
  return new Map(rows.map((row) => [row.id, row]))
}

export interface ExposeDeps {
  readonly deps: RecoveryCoordinatorDeps
  readonly bootId: string
  /** Last offered permit per account, retained across stop/start. */
  readonly offered: Map<string, string>
  readonly stopped: () => boolean
  readonly coherent: () => Promise<boolean>
  readonly markDirty: () => void
  readonly satisfied: (accountId: string) => void
}

/**
 * Installs an issued permit this boot owns as a local capability, once. The account is read by the
 * caller (batched per tick) and passed in; the hydrate below fences it against the row anyway.
 */
export function createExposer(ctx: ExposeDeps) {
  const { deps, bootId, offered } = ctx
  return async (row: RecoveryRow, account: AccountRow | undefined): Promise<void> => {
    if (ctx.stopped() || row.state !== "issued" || row.ownerBootId !== bootId) return
    if (row.permitId === null || offered.get(row.accountId) === row.permitId) return
    if (ctx.stopped() || account === undefined || standingBlock(account)) return
    const hydrated = await deps.repository.hydrateIssued({
      accountId: row.accountId,
      generation: row.generation,
      permitId: row.permitId,
      ownerBootId: bootId,
      expectedEpoch: row.ownershipEpoch,
      expected: observation(account),
      maximumOutcomeAgeMs: deps.config.maximumOutcomeMs,
    })
    if (hydrated === undefined || !(await ctx.coherent()) || ctx.stopped()) return
    const capability: RecoveryCapability = {
      revision: hydrated.revision,
      accountId: row.accountId,
      generation: row.generation,
      permitId: row.permitId,
      ownerBootId: bootId,
      ownershipEpoch: row.ownershipEpoch,
      expected: observation(account),
      quotaRevisions: { ...row.quotaRevisions },
    }
    // Install is synchronous and must be idempotent; a consumed permit cannot be reset.
    if (!deps.install(capability)) {
      ctx.markDirty()
      return
    }
    offered.set(row.accountId, row.permitId)
    ctx.satisfied(row.accountId)
  }
}
