import type { CliSource } from "../../providers"

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
 * The `claude` CLI is reported on the same terms, and for a second reason: it matters only to
 * Claude *subscription* accounts, so a deployment with none — or with API-key accounts only — is
 * fully functional without it. What it reports is *which rung of the resolution ladder won*,
 * because "the wrong `claude` got picked" is otherwise indistinguishable from any other Agent SDK
 * failure (docs/idea/11-anthropic-agent-sdk.md#9-operational-notes).
 *
 * **A draining router is the one case that gates without probing.** Once a shutdown has been
 * accepted the answer is already no, and it is no before the listener stops accepting rather than
 * after — see `services/shutdown/lifecycle.ts`. Asking the database at that point would only add a
 * query to a pool that is about to close, so nothing is probed and the report says so.
 *
 * Probes are injected, so the service stays free of I/O and of any Hono type.
 */

export interface ReadinessProbes {
  /** True when the database answered. */
  readonly database: () => Promise<boolean>
  /** What the routing catalog and health store currently say about the account pool. */
  readonly accounts: () => Promise<AccountReadiness>
  /** Which rung of the `claude` CLI resolution ladder won, or `missing` when none did. */
  readonly claudeCli: () => Promise<ClaudeCliReadiness>
  /** True once a shutdown was accepted — `Lifecycle.shuttingDown` in production. */
  readonly shuttingDown: () => boolean
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

/**
 * The winning rung's name, or `missing`. Naming the rung rather than answering yes/no is the whole
 * point: two hosts can both say "found it" and be running different binaries.
 *
 * The resolved *path* is deliberately not here. `/readyz` is unauthenticated, so it reports which
 * rung won and the boot log carries where — see `claudeCliProbe.ts`.
 */
export type ClaudeCliReadiness = CliSource | "missing"

export type CheckState = "ok" | "fail" | AccountReadiness | ClaudeCliReadiness

export interface ReadinessChecks {
  readonly database: CheckState
  readonly accounts: CheckState
  readonly claudeCli: CheckState
}

export interface ReadinessReport {
  readonly ready: boolean
  /** True once a shutdown was accepted. Never ready, and nothing below was asked. */
  readonly shuttingDown: boolean
  /** `null` exactly when shutting down: no probe ran, so there is nothing honest to report. */
  readonly checks: ReadinessChecks | null
  /**
   * Short operator-facing reason. Present whenever something is wrong, **including when the
   * router is still ready** — an account problem is worth saying out loud even though it does
   * not withhold traffic.
   */
  readonly reason: string | null
}

export async function checkReadiness(probes: ReadinessProbes): Promise<ReadinessReport> {
  // First, and before anything is awaited: this is what makes the endpoint fail *before* the drain
  // begins rather than once the pool is already going.
  if (probes.shuttingDown()) {
    return {
      ready: false,
      shuttingDown: true,
      checks: null,
      reason: "shutting down — draining in-flight requests",
    }
  }

  const [database, accounts, claudeCli] = await Promise.all([
    settleDatabase(probes.database),
    settleAccounts(probes.accounts),
    settleClaudeCli(probes.claudeCli),
  ])

  const reasons: string[] = []
  if (!database) reasons.push("database unreachable")
  if (accounts === "none") reasons.push("no accounts configured")
  if (accounts === "blocked") reasons.push("every account is unavailable")
  if (claudeCli === "missing") reasons.push("claude cli not found")

  return {
    ready: database,
    shuttingDown: false,
    checks: { database: database ? "ok" : "fail", accounts, claudeCli },
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

/** Same rule: a resolver that threw has not told us which binary would be spawned. */
async function settleClaudeCli(
  probe: () => Promise<ClaudeCliReadiness>,
): Promise<ClaudeCliReadiness> {
  try {
    return await probe()
  } catch {
    return "missing"
  }
}
