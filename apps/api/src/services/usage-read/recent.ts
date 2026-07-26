import type { Dialect, EgressMode, ProviderId, UsageFault } from "@multi-ai-router/core"
import { isSuccessOutcome, UsageOutcome, usageOutcomeFault } from "@multi-ai-router/core"
import type { RecentAttemptRow } from "@multi-ai-router/db"
import { z } from "zod"
import type { UsageLabelSets } from "./service"

/**
 * The live request feed's contract: what the console may ask for, and what one
 * attempt looks like on the wire.
 *
 * This is the *"why did my request fail"* surface. Everything else on the usage
 * screen aggregates — it can say 3% of attempts failed and whose fault that
 * class of failure is, but not which request, on which account, with which
 * error class. Until now that answer existed only in the process logs, which an
 * operator running a container cannot grep.
 *
 * **`fault` rides along with `outcome`, resolved here.** It is derived — one call
 * to `usageOutcomeFault`, core's single definition of whose problem a failure is
 * — and the console could in principle call the same function. It does not, for a
 * measured reason: core's vocabulary is Zod-backed, so a runtime import of it
 * pulled Zod into the console's usage chunk and took it from 12 kB to 72 kB. One
 * short string per row on an admin response with no latency budget is the
 * cheaper half of that trade, and the definition stays in exactly one place
 * either way.
 *
 * **Nothing here can carry credential material.** The columns are named
 * individually by the repository, `errorClass` is a class name rather than a
 * message, and no request or response body is stored at all — see
 * docs/idea/07-security.md.
 */

export const RECENT_LIMIT_DEFAULT = 50
export const RECENT_LIMIT_MIN = 1
export const RECENT_LIMIT_MAX = 200

/**
 * Query params arrive as strings, so `limit` is coerced and `failed` is parsed
 * from the words a query string can hold. Out of range is a 400 rather than a
 * silent clamp, exactly as the audit feed does it: a console that asked for
 * 1000 rows and got 200 without being told would render a truncated page as a
 * complete one.
 *
 * `failed` is a **filter on the boolean, not a switch that is only ever on**:
 * `true` narrows to every non-success outcome, `false` to successes, and absent
 * to both. `outcome` says the same thing more precisely, so asking for both is
 * rejected rather than silently resolved in one of their favours.
 */
export const recentQuery = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(RECENT_LIMIT_MIN)
      .max(RECENT_LIMIT_MAX)
      .default(RECENT_LIMIT_DEFAULT),
    outcome: UsageOutcome.optional(),
    failed: z.stringbool().optional(),
    /**
     * The same charset and ceiling `requestId()` accepts on the way in, because
     * this looks up a value that middleware wrote — a longer or odder string
     * cannot be on any row, so accepting it would only widen what reaches SQL.
     */
    requestId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_.:-]+$/, "a request id is [A-Za-z0-9_.:-], 1 to 128 characters")
      .optional(),
  })
  .refine((query) => !(query.outcome !== undefined && query.failed !== undefined), {
    message: "pass either a specific outcome or failed, not both",
  })

export type RecentQuery = z.infer<typeof recentQuery>

/**
 * Which outcomes the repository should keep, or `undefined` for all of them.
 *
 * Derived from `UsageOutcome.options` rather than from a hand-written list, so
 * an outcome added to core is filtered correctly here without anyone
 * remembering to come back — the failure mode being a "failures only" view that
 * quietly hides the newest kind of failure.
 */
export function outcomesFor(query: RecentQuery): readonly UsageOutcome[] | undefined {
  if (query.outcome !== undefined) return [query.outcome]
  if (query.failed === undefined) return undefined
  return UsageOutcome.options.filter((outcome) => isSuccessOutcome(outcome) !== query.failed)
}

/**
 * A named subject on one attempt — the key that presented, the account that
 * served, the pool it was drawn from.
 *
 * Same three fields and same rules as a breakdown row: a label may be missing
 * because the subject was deleted (usage rows outlive what they name) or because
 * the dimension did not apply (a key scoped `all` was placed by no pool), and
 * the reason is on the row so the console never has to guess which.
 */
export interface RecentSubject {
  readonly id: string | null
  readonly label: string | null
  readonly note: "deleted" | "none" | null
}

export interface RecentAttemptView {
  readonly id: string
  /** Shared by every attempt of one client request. Groups a failover chain. */
  readonly correlationId: string
  /** The caller's own `x-request-id`, when it sent one. */
  readonly clientRequestId: string | null
  /** 1-based position in the failover chain. */
  readonly attempt: number
  readonly key: RecentSubject
  readonly account: RecentSubject
  readonly pool: RecentSubject
  readonly provider: ProviderId | null
  /** What the client asked for. Never substituted — CLAUDE.md non-negotiable 4. */
  readonly model: string
  /** What went on the wire after the account's alias map. Null when nothing was sent. */
  readonly upstreamModel: string | null
  readonly ingressDialect: Dialect | null
  readonly egressMode: EgressMode | null
  readonly outcome: UsageOutcome
  /**
   * Whose problem the outcome is — `none` | `client` | `capacity` | `upstream` |
   * `router`. Derived from `outcome` by core, never decided here.
   */
  readonly fault: UsageFault
  /** The upstream's status when it answered. Null means we never reached it. */
  readonly httpStatus: number | null
  /** The thrown class's name. Never a message, never a body. */
  readonly errorClass: string | null
  readonly latencyMs: number
  /** Time to first relayed byte. Null when no byte was ever relayed. */
  readonly ttfbMs: number | null
  readonly routerOverheadMs: number
  readonly streamed: boolean
  readonly tokensIn: number
  readonly tokensOut: number
  readonly at: string
}

export interface RecentView {
  readonly attempts: readonly RecentAttemptView[]
  /** Echoed back so the console can say how deep the page it is showing goes. */
  readonly limit: number
}

export function toRecentAttemptView(
  row: RecentAttemptRow,
  labels: UsageLabelSets,
): RecentAttemptView {
  return {
    id: row.id,
    correlationId: row.correlationId,
    clientRequestId: row.clientRequestId,
    attempt: row.attempt,
    key: subject(row.apiKeyId, labels.keys),
    account: subject(row.accountId, labels.accounts),
    pool: subject(row.poolId, labels.pools),
    provider: row.provider,
    model: row.model,
    upstreamModel: row.upstreamModel,
    ingressDialect: row.ingressDialect,
    egressMode: row.egressMode,
    outcome: row.outcome,
    fault: usageOutcomeFault(row.outcome),
    httpStatus: row.httpStatus,
    errorClass: row.errorClass,
    latencyMs: row.latencyMs,
    ttfbMs: row.ttfbMs,
    routerOverheadMs: row.routerOverheadMs,
    streamed: row.streamed,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    at: row.createdAt.toISOString(),
  }
}

function subject(id: string | null, names: ReadonlyMap<string, string>): RecentSubject {
  if (id === null) return { id: null, label: null, note: "none" }
  const found = names.get(id)
  return found === undefined
    ? { id, label: null, note: "deleted" }
    : { id, label: found, note: null }
}
