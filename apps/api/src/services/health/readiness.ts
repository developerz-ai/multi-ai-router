/**
 * Readiness is what an orchestrator gates traffic on: the database must be reachable **and**
 * at least one Account must be healthy, because a router with nothing to route to can serve
 * nothing useful. Liveness is a different question and deliberately checks neither —
 * docs/idea/08-observability.md#endpoints.
 *
 * Probes are injected, so the service stays free of I/O and of any Hono type.
 */

export interface ReadinessProbes {
  /** True when the database answered. */
  readonly database: () => Promise<boolean>
  /** True when at least one Account is in a healthy state. */
  readonly healthyAccounts: () => Promise<boolean>
}

export type CheckState = "ok" | "fail"

export interface ReadinessReport {
  readonly ready: boolean
  readonly checks: { readonly database: CheckState; readonly accounts: CheckState }
  /** Short operator-facing reason when not ready; null when ready. */
  readonly reason: string | null
}

export async function checkReadiness(probes: ReadinessProbes): Promise<ReadinessReport> {
  const [database, accounts] = await Promise.all([
    settle(probes.database),
    settle(probes.healthyAccounts),
  ])

  const reasons: string[] = []
  if (!database) reasons.push("database unreachable")
  if (!accounts) reasons.push("no healthy accounts")

  return {
    ready: database && accounts,
    checks: { database: state(database), accounts: state(accounts) },
    reason: reasons.length > 0 ? reasons.join("; ") : null,
  }
}

/**
 * TODO(M2): replace with a real check against the account health cache once Accounts exist.
 * Until then readiness reports the account dimension as satisfied — the database check below
 * it is real, so `/readyz` is never a mere alias of `/healthz`.
 */
export function assumeHealthyAccounts(): Promise<boolean> {
  return Promise.resolve(true)
}

/** A probe that throws is a failed probe, never a failed request. */
async function settle(probe: () => Promise<boolean>): Promise<boolean> {
  try {
    return await probe()
  } catch {
    return false
  }
}

function state(ok: boolean): CheckState {
  return ok ? "ok" : "fail"
}
