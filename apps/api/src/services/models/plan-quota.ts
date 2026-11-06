import { describeError } from "@multi-ai-router/core"
import { httpDriver } from "../../providers"
import type { CredentialCipher } from "../crypto/cipher"
import { type FetchLike, type HealthStore, type RoutableAccount, runAttempt } from "../dataplane"
import { accountHealthFacts } from "../dataplane/health-observation"

/**
 * **Ask one Account's upstream how much of its plan is spent.** One GET, one credential, one answer,
 * for the providers that declare a usage endpoint (`ProviderDriver.quotaRead`). No provider is named
 * here. Beside `listing.ts` because it is the same kind of work: a free read that describes an
 * Account, off the request path, through `runAttempt` so its headers and credential handling are a
 * real request's.
 *
 * The answer goes in through `HealthStore.applyRateLimit`, the one door a reading has: from there
 * the warm state holds it and the quota writer persists it. An advisory window never blocks routing.
 * `quota-aware` does rank on it, as it does on Codex's gauge.
 *
 * **A failed read says nothing about the Account.** No breaker strike, no status: a `401` here is a
 * credential the request path will hear about itself, and a stale gauge beats a cooled-down account.
 */

export type PlanQuotaOutcome =
  | { readonly kind: "read" }
  /** Nothing to read here: not a failure. A key with no plan answers this on every tick. */
  | { readonly kind: "skipped"; readonly reason: string }
  /** `reason` is a classification signal or a stable code, never a response body. */
  | { readonly kind: "failed"; readonly reason: string }

export interface PlanQuotaDeps {
  readonly cipher: Pick<CredentialCipher, "decrypt">
  /** Bounds the one outbound call — the same ceiling a normal attempt gets. */
  readonly timeoutMs: number
  readonly fetch: FetchLike
  readonly health: Pick<HealthStore, "captureAttempt" | "applyRateLimit">
  readonly now: () => Date
}

/**
 * Whether the sweep asks this Account at all. `disabled` is the operator's own switch, and a
 * `needs_reauth` key is known dead: asking it again learns nothing and logs a failure every tick.
 * `exhausted` is asked: the read is free and only ever records, so it cannot revive the Account.
 */
export function isPlanQuotaReadable(account: RoutableAccount): boolean {
  const { status } = account.snapshot
  if (status === "disabled" || status === "needs_reauth") return false
  return (httpDriver(account.snapshot.provider)?.quotaRead?.url(account.driver) ?? null) !== null
}

export async function readPlanQuota(
  deps: PlanQuotaDeps,
  account: RoutableAccount,
): Promise<PlanQuotaOutcome> {
  const driver = httpDriver(account.snapshot.provider)
  const url = driver?.quotaRead?.url(account.driver) ?? null
  if (driver === null || driver.quotaRead === undefined || url === null)
    return { kind: "skipped", reason: "quota:no-endpoint" }

  // Before the call, so a reading that outlives a credential rotation is dropped, not installed.
  const observation = deps.health.captureAttempt(account.id, accountHealthFacts(account))
  try {
    const outcome = await runAttempt({
      plan: {
        account,
        driver,
        dialect: driver.resolveDialect(account.driver),
        url,
        // A usage read names no model. `runAttempt` never reads this field.
        upstreamModel: "",
      },
      method: "GET",
      clientHeaders: new Headers(),
      body: null,
      fetch: deps.fetch,
      cipher: deps.cipher,
      timeoutMs: deps.timeoutMs,
    })

    if (outcome.kind === "admission-refused")
      return { kind: "skipped", reason: "quota:admission-refused" }
    if (outcome.kind === "failure") {
      const status = outcome.upstream?.status
      if (status !== undefined && driver.quotaRead.noPlanStatuses.has(status))
        return { kind: "skipped", reason: "quota:no-plan" }
      return {
        kind: "failed",
        reason: outcome.classification?.signal ?? `attempt:${outcome.failure.kind}`,
      }
    }

    const at = deps.now()
    const signal = driver.quotaRead.read(await readJson(outcome.response), at)
    if (signal === null) return { kind: "failed", reason: "quota:unreadable" }
    deps.health.applyRateLimit(account.id, signal, at, observation)
    return { kind: "read" }
  } catch (error) {
    // A credential that will not decrypt, chiefly. One account's fault must not end the sweep.
    return { kind: "failed", reason: describeError(error, Number.POSITIVE_INFINITY) }
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

/**
 * Which Accounts this tick reads: the longest-unread first, capped at the batch. Pure.
 *
 * Each replica runs its own timer and the advisory lock only stops two runs overlapping, so an
 * Account another replica read a moment ago is dropped: `freshForMs` against the durable stamps in
 * `lastReadAt`. `lastLookAt` is this process's own memory, and it is what rotates an Account with
 * no durable stamp at all — a key with no plan never gets a row, and without it would sort first
 * on every tick and, a batch's worth of them later, be all the sweep ever asked.
 */
export function selectForPlanQuotaRead<T extends { readonly id: string }>(
  accounts: readonly T[],
  lastReadAt: ReadonlyMap<string, Date>,
  lastLookAt: ReadonlyMap<string, Date>,
  now: Date,
  freshForMs: number,
): readonly T[] {
  const askedAt = (id: string): number =>
    Math.max(lastReadAt.get(id)?.getTime() ?? 0, lastLookAt.get(id)?.getTime() ?? 0)
  return accounts
    .filter((account) => now.getTime() - askedAt(account.id) >= freshForMs)
    .sort((a, b) => askedAt(a.id) - askedAt(b.id) || a.id.localeCompare(b.id))
}
