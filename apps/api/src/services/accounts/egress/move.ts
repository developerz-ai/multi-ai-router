import type {
  EgressAccountRow,
  EgressHealthRow,
  EgressRepairState,
  StoredEgressProxy,
} from "@multi-ai-router/db"
import { AUDIT_KINDS, AUDIT_SUBJECTS } from "../../admin/audit"
import { upstreamTarget } from "./assignment"
import { decideRepair, type RepairFacts } from "./decide"
import type { EgressSweepDeps, EgressSweepInput } from "./repair"
import type { VendorListing, VendorProxy } from "./vendor"
import { assignmentOf, currentHealth } from "./view"

export interface RepairInput extends EgressSweepInput {
  readonly row: EgressAccountRow
  readonly health: EgressHealthRow
  readonly listing: (vendor: string) => Promise<VendorListing>
}

/** One dead proxy, decided and, when the decision says so, replaced. */
export async function repair(
  deps: EgressSweepDeps,
  input: RepairInput,
): Promise<"none" | "reseal" | "swap" | Exclude<EgressRepairState, "idle">> {
  const { row, health, now, signal } = input
  const proxy = row.egressProxy
  if (proxy.replace !== "on-failure" || proxy.vendor === undefined) return "none"
  // Not dead for long enough: nothing to decide, so nothing is read for it.
  if (health.consecutiveFailures < deps.policy.failureThreshold) return "none"
  const facts: RepairFacts = {
    proxy,
    url: deps.cipher.decrypt(proxy.sealed),
    consecutiveFailures: health.consecutiveFailures,
    repair: currentHealth(proxy, health).repair,
    lastSwapAt: health.lastSwapAt,
    listing: await input.listing(proxy.vendor),
    taken: takenBy(await deps.accounts.listHeldEgressProxies(row.id)),
    now,
    threshold: deps.policy.failureThreshold,
    cooldownMs: deps.policy.swapCooldownMs,
  }
  const alive = async (candidate: VendorProxy): Promise<boolean> =>
    (await deps.probe(candidate.url, upstreamTarget(row), signal)).outcome === "ok"

  let step = decideRepair(facts)
  if (step.kind === "reseal") {
    if (await alive(step.proxy))
      return (await commit(deps, input, step.proxy, false)) ? "reseal" : "none"
    step = decideRepair({ ...facts, resealFailed: true })
  }
  if (step.kind === "swap") {
    for (const candidate of step.candidates) {
      if (signal.aborted) return "none"
      if (!(await alive(candidate))) continue
      return (await commit(deps, input, candidate, true)) ? "swap" : "none"
    }
    // Cut short, the probes proved nothing about the candidates.
    if (signal.aborted) return "none"
    step = { kind: "hold", repair: "no_candidate" }
  }
  if (step.kind !== "hold") return "none"
  if (step.repair !== currentHealth(proxy, health).repair) {
    await deps.health.recordRepair({
      accountId: row.id,
      assignment: assignmentOf(proxy),
      repair: step.repair,
    })
    if (step.repair === "no_candidate") {
      // Alert line, once per transition: the account stays on a dead proxy until a person acts.
      input.logger.warn("egress proxy has no replacement", {
        accountId: row.id,
        label: row.label,
        vendor: proxy.vendor,
        from: proxy.address,
        reason: health.lastOutcome,
      })
    }
  }
  return step.repair
}

/** Stores `next` over the proxy the decision was about. False: an operator changed it meanwhile. */
async function commit(
  deps: EgressSweepDeps,
  input: RepairInput,
  chosen: VendorProxy,
  swap: boolean,
): Promise<boolean> {
  const { row, health, now, logger } = input
  const before = row.egressProxy
  const next: StoredEgressProxy = {
    ...before,
    address: chosen.address,
    sealed: deps.cipher.encrypt(chosen.url),
    vendor: chosen.vendor,
    vendorId: chosen.id,
    country: chosen.country,
  }
  const written = await deps.accounts.swapEgressProxy({
    id: row.id,
    expectedSealed: before.sealed,
    next,
    exclusive: swap,
    actor: "sweep",
    // The candidate was probed towards this endpoint and says nothing about another.
    expectedUpstream: { baseUrl: row.baseUrl, dialect: row.dialect },
    // One write with the swap: a swap that stands without its cooldown could be followed by another.
    recorded: { assignment: assignmentOf(next), ...(swap ? { swappedAt: now } : {}) },
    now,
  })
  if (written === undefined) return false

  const change = {
    vendor: chosen.vendor,
    from: before.address,
    to: next.address,
    reason: swap ? health.lastOutcome : "credentials_refreshed",
  }
  await deps.audit.record({
    kind: swap ? AUDIT_KINDS.accountEgressProxyReplaced : AUDIT_KINDS.accountUpdated,
    subjectType: AUDIT_SUBJECTS.account,
    subjectId: row.id,
    detail: {
      label: row.label,
      ...(swap
        ? { ...change, failures: health.consecutiveFailures, country: chosen.country }
        : { fields: ["egressProxy"], egressProxy: next.address, ...change }),
    },
  })
  // Alert line: an operator hears about every address an account was moved to.
  logger.warn(swap ? "egress proxy replaced" : "egress proxy credentials refreshed", {
    accountId: row.id,
    label: row.label,
    ...change,
  })
  // Last: a reload that fails leaves requests on the old proxy until the catalog's own refresh.
  await deps.refreshCatalog()
  return true
}

function takenBy(
  held: readonly { address: string; vendor: string | null; vendorId: string | null }[],
): RepairFacts["taken"] {
  return {
    addresses: new Set(held.map((proxy) => proxy.address)),
    ids: new Set(
      held.flatMap(({ vendor, vendorId }) => (vendorId === null ? [] : `${vendor}/${vendorId}`)),
    ),
  }
}
