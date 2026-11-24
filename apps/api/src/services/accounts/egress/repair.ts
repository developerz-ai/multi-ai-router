import { describeError } from "@multi-ai-router/core"
import type {
  AccountEgressHealthRepository,
  AccountRepository,
  EgressAccountRow,
  EgressHealthRow,
} from "@multi-ai-router/db"
import type { Logger } from "../../../logging/logger"
import type { AuditRecorder } from "../../admin/audit"
import type { CredentialCipher } from "../../crypto/cipher"
import { upstreamTarget } from "./assignment"
import { checkedOutcome, isProxyFailure, vendorVerdict } from "./decide"
import { repair } from "./move"
import type { ProxyProbe } from "./probe"
import { listOnce, type ProxyVendor } from "./vendor"
import { assignmentOf, currentHealth } from "./view"

/** Probes in flight at once. Each is one short TCP connection. */
const PROBE_CONCURRENCY = 4

export interface EgressSweepDeps {
  readonly accounts: Pick<AccountRepository, "listWithEgressProxy" | "swapEgressProxy">
  readonly health: AccountEgressHealthRepository
  readonly cipher: Pick<CredentialCipher, "encrypt" | "decrypt">
  readonly vendors: readonly ProxyVendor[]
  readonly probe: ProxyProbe
  readonly audit: AuditRecorder
  readonly refreshCatalog: () => Promise<void>
  readonly policy: {
    readonly batchSize: number
    readonly failureThreshold: number
    readonly swapCooldownMs: number
  }
}

export interface EgressSweepInput {
  readonly now: Date
  readonly logger: Pick<Logger, "info" | "warn">
  readonly signal: AbortSignal
}

export interface EgressSweepResult {
  readonly checked: number
  /** Accounts whose check or repair threw. Never the proxies that are down. */
  readonly failed: number
  readonly reseals: number
  readonly swaps: number
  readonly noCandidate: number
  /** Stopped early, more than one batch, or a vendor an `on-failure` account needs was unavailable. */
  readonly partial: boolean
}

/**
 * Dead-proxy repair, on a timer. Its only inputs are its own CONNECT probe and the vendor's list:
 * nothing the data plane or an AI provider answered reaches it, so it cannot rotate an address for
 * a `429`. A swap is a compare-and-swap on the sealed URL the decision was made against, so an
 * operator's edit made meanwhile wins.
 */
export function createEgressSweep(
  deps: EgressSweepDeps,
): (input: EgressSweepInput) => Promise<EgressSweepResult> {
  return async ({ now, logger, signal }) => {
    const all = await deps.accounts.listWithEgressProxy()
    const enabled = all.filter((row) => row.status !== "disabled")
    const rows = new Map(
      (await deps.health.listForAccounts(all.map((row) => row.id))).map((row) => [
        row.accountId,
        row,
      ]),
    )
    const due = oldestFirst(enabled, rows).slice(0, deps.policy.batchSize)
    const listing = listOnce(deps.vendors, signal)
    const held = new Map(all.map((row) => [row.id, row.egressProxy]))
    const tally = { checked: 0, failed: 0, reseals: 0, swaps: 0, noCandidate: 0 }
    let vendorMissing = false
    const dead: { row: EgressAccountRow; health: EgressHealthRow }[] = []

    const attempt = async (row: EgressAccountRow, work: () => Promise<void>): Promise<void> => {
      try {
        await work()
      } catch (error) {
        tally.failed += 1
        logger.warn("egress proxy check failed for an account", {
          accountId: row.id,
          reason: describeError(error, 200),
        })
      }
    }

    const check = async (row: EgressAccountRow): Promise<void> => {
      const proxy = row.egressProxy
      const url = deps.cipher.decrypt(proxy.sealed)
      const listed =
        proxy.vendor === undefined || proxy.vendorId === undefined
          ? null
          : await listing(proxy.vendor)
      const probed = await deps.probe(url, upstreamTarget(row), signal)
      // A probe cut short by shutdown says nothing about the proxy.
      if (signal.aborted) return
      const outcome = checkedOutcome(probed.outcome, vendorVerdict(proxy, listed))
      const health = await deps.health.recordCheck({
        accountId: row.id,
        assignment: assignmentOf(proxy),
        outcome,
        status: probed.status,
        latencyMs: probed.latencyMs,
        countsAsFailure: isProxyFailure(outcome),
        checkedAt: now,
      })
      tally.checked += 1
      if (health !== undefined && isProxyFailure(outcome)) dead.push({ row, health })
    }

    await mapBounded(due, PROBE_CONCURRENCY, async (row) => {
      if (!signal.aborted) await attempt(row, () => check(row))
    })

    // One at a time: each repair has to see the proxy the one before it took.
    for (const { row, health } of dead) {
      if (signal.aborted) break
      await attempt(row, async () => {
        const done = await repair(deps, { row, health, listing, held, now, logger, signal })
        if (done === "reseal") tally.reseals += 1
        if (done === "swap") tally.swaps += 1
        if (done === "no_candidate") tally.noCandidate += 1
        if (done === "vendor_unavailable") vendorMissing = true
      })
    }

    return {
      ...tally,
      partial: signal.aborted || vendorMissing || due.length < enabled.length,
    }
  }
}

function oldestFirst(
  accounts: readonly EgressAccountRow[],
  rows: ReadonlyMap<string, EgressHealthRow>,
): readonly EgressAccountRow[] {
  const at = (row: EgressAccountRow): number =>
    currentHealth(row.egressProxy, rows.get(row.id)).lastCheckedAt?.getTime() ?? 0
  return [...accounts].sort((a, b) => at(a) - at(b))
}

async function mapBounded<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) await run(items[next++] as T)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}
