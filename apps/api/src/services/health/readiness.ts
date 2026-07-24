/**
 * Readiness is what an orchestrator gates traffic on. Liveness is a different question and
 * deliberately checks neither the database nor the accounts —
 * docs/idea/08-observability.md#endpoints.
 *
 * **Only the database gates readiness, and that is a deliberate correction.** The obvious design
 * — "ready means the router can route, so require a healthy account" — deadlocks a fresh
 * deployment: a new install has zero accounts, so it is never ready, so an orchestrator never
 * sends it traffic, so nobody can reach the admin console *that this same process serves* to add
 * the first account. The router would be permanently not-ready with no way out.
 *
 * So the account dimension is **reported, not gated**. `/readyz` still answers "is anything
 * routable" honestly — `none` and `blocked` are distinct from `ok`, and each carries a reason an
 * operator can act on — but a router that can serve its console is ready, because serving the
 * console is how the account problem gets fixed.
 *
 * Probes are injected, so the service stays free of I/O and of any Hono type.
 */

export interface ReadinessProbes {
  /** True when the database answered. */
  readonly database: () => Promise<boolean>
  /** What the routing catalog and health store currently say about the account pool. */
  readonly accounts: () => Promise<AccountReadiness>
}

/**
 * The three states worth distinguishing, because each has a different remedy:
 *
 * - `ok` — at least one account can take a request.
 * - `none` — nothing configured yet. Expected on a fresh install; the operator adds an account.
 * - `blocked` — accounts exist but every one is disabled, exhausted, cooling down, or needs
 *   re-authenticating. This is the state that means something is wrong *right now*.
 */
export type AccountReadiness = "ok" | "none" | "blocked"

export type CheckState = "ok" | "fail" | AccountReadiness

export interface ReadinessReport {
  readonly ready: boolean
  readonly checks: { readonly database: CheckState; readonly accounts: CheckState }
  /**
   * Short operator-facing reason. Present whenever something is wrong, **including when the
   * router is still ready** — an account problem is worth saying out loud even though it does
   * not withhold traffic.
   */
  readonly reason: string | null
}

export async function checkReadiness(probes: ReadinessProbes): Promise<ReadinessReport> {
  const [database, accounts] = await Promise.all([
    settleDatabase(probes.database),
    settleAccounts(probes.accounts),
  ])

  const reasons: string[] = []
  if (!database) reasons.push("database unreachable")
  if (accounts === "none") reasons.push("no accounts configured")
  if (accounts === "blocked") reasons.push("every account is unavailable")

  return {
    ready: database,
    checks: { database: database ? "ok" : "fail", accounts },
    reason: reasons.length > 0 ? reasons.join("; ") : null,
  }
}

/** A probe that throws is a failed probe, never a failed request. */
async function settleDatabase(probe: () => Promise<boolean>): Promise<boolean> {
  try {
    return await probe()
  } catch {
    return false
  }
}

/** A probe that throws reports `blocked`: unknown is not the same as fine. */
async function settleAccounts(probe: () => Promise<AccountReadiness>): Promise<AccountReadiness> {
  try {
    return await probe()
  } catch {
    return "blocked"
  }
}
