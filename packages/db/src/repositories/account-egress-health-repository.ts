import { inArray, sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import {
  type AccountEgressHealthRow,
  accountEgressHealth,
  type EgressProxyOutcome,
  type EgressRepairState,
} from "../schema/account-egress-health"

export type { EgressProxyOutcome, EgressRepairState } from "../schema/account-egress-health"
export { EGRESS_PROXY_OUTCOMES, EGRESS_REPAIR_STATES } from "../schema/account-egress-health"

/** One account's proxy health, without the row's own bookkeeping stamp. */
export type EgressHealthRow = Omit<AccountEgressHealthRow, "updatedAt">

export interface EgressCheckInput {
  readonly accountId: string
  /** sha256 hex of the checked proxy's `sealed` value: which proxy this outcome is about. */
  readonly assignment: string
  readonly outcome: EgressProxyOutcome
  readonly status: number | null
  readonly latencyMs: number | null
  /** False for an operator's own test: shown, never counted. `ok` and `refused` never count. */
  readonly countsAsFailure: boolean
  readonly checkedAt: Date
}

export interface EgressRepairInput {
  readonly accountId: string
  readonly assignment: string
  readonly repair: EgressRepairState
  /** Set when a swap committed: stamps the cooldown clock and counts the swap. */
  readonly swappedAt?: Date
}

/**
 * Proxy health per account. Repositories own SQL; this file is the only place that knows
 * `account_egress_health` is a table. Written by `egress_proxy_check` (one replica, under its
 * advisory lock) and by an operator's test, so each write is one atomic upsert, never a
 * read-then-write.
 */
export interface AccountEgressHealthRepository {
  listForAccounts(ids: readonly string[]): Promise<EgressHealthRow[]>
  /**
   * Records one check and returns the row after it, or `undefined` when the account is gone.
   * A live proxy (`ok`, or `refused`: it answered and declined the target) or a changed assignment
   * restarts the count at 0, so failures are consecutive; otherwise `countsAsFailure` adds one and
   * an uncounted check (an operator's own test) leaves it. A live proxy also returns `repair` to
   * `idle`: a hold is about a dead proxy. Only `ok` stamps `last_ok_at`. A changed assignment forgets the old
   * proxy's `last_ok_at` and `repair` and keeps `last_swap_at` and `swaps`.
   */
  recordCheck(input: EgressCheckInput): Promise<EgressHealthRow | undefined>
  /**
   * Records where repair stands. `swappedAt` stamps `last_swap_at` and counts the swap. A changed
   * assignment restarts the failure count and forgets the old proxy's last outcome.
   */
  recordRepair(input: EgressRepairInput): Promise<void>
}

const columns = {
  accountId: accountEgressHealth.accountId,
  assignment: accountEgressHealth.assignment,
  lastOutcome: accountEgressHealth.lastOutcome,
  lastStatus: accountEgressHealth.lastStatus,
  latencyMs: accountEgressHealth.latencyMs,
  consecutiveFailures: accountEgressHealth.consecutiveFailures,
  lastCheckedAt: accountEgressHealth.lastCheckedAt,
  lastOkAt: accountEgressHealth.lastOkAt,
  repair: accountEgressHealth.repair,
  lastSwapAt: accountEgressHealth.lastSwapAt,
  swaps: accountEgressHealth.swaps,
}

type RawRow = {
  account_id: string
  assignment: string
  last_outcome: EgressProxyOutcome | null
  last_status: number | null
  latency_ms: number | null
  consecutive_failures: number
  last_checked_at: Date | string | null
  last_ok_at: Date | string | null
  repair: EgressRepairState
  last_swap_at: Date | string | null
  swaps: number
}

const instant = (value: Date | string | null): Date | null =>
  value === null ? null : value instanceof Date ? value : new Date(value)

export function createAccountEgressHealthRepository(
  db: DatabaseExecutor,
): AccountEgressHealthRepository {
  return {
    listForAccounts: async (ids) => {
      if (ids.length === 0) return []
      return db
        .select(columns)
        .from(accountEgressHealth)
        .where(inArray(accountEgressHealth.accountId, [...new Set(ids)]))
    },

    // `insert … select from accounts`: an account deleted between the sweep's read and this write
    // yields no row instead of a foreign-key error that fails the tick. Values in a raw template
    // have no column encoder, so every one is cast and dates cross as ISO strings.
    recordCheck: async (input) => {
      const ok = input.outcome === "ok"
      // `refused` is the proxy answering: alive, so the run of failures ends there too.
      const alive = ok || input.outcome === "refused"
      const failure = !alive && input.countsAsFailure ? 1 : 0
      const at = sql`${input.checkedAt.toISOString()}::timestamptz`
      const rows = await db.execute<RawRow>(sql`
        insert into account_egress_health as h
          (account_id, assignment, last_outcome, last_status, latency_ms, consecutive_failures,
           last_checked_at, last_ok_at, repair, updated_at)
        select a.id, ${input.assignment}::text, ${input.outcome}::text, ${input.status}::int,
          ${input.latencyMs}::int, ${failure}::int, ${at}, case when ${ok}::boolean then ${at} end,
          'idle', now()
        from accounts a where a.id = ${input.accountId}::uuid
        on conflict (account_id) do update set
          assignment = excluded.assignment,
          last_outcome = excluded.last_outcome,
          last_status = excluded.last_status,
          latency_ms = excluded.latency_ms,
          consecutive_failures = case
            when ${alive}::boolean or h.assignment <> excluded.assignment then ${failure}::int
            else h.consecutive_failures + ${failure}::int end,
          last_checked_at = excluded.last_checked_at,
          last_ok_at = case
            when ${ok}::boolean then excluded.last_checked_at
            when h.assignment <> excluded.assignment then null
            else h.last_ok_at end,
          repair = case
            when ${alive}::boolean or h.assignment <> excluded.assignment then 'idle'
            else h.repair end,
          updated_at = now()
        returning h.account_id, h.assignment, h.last_outcome, h.last_status, h.latency_ms,
          h.consecutive_failures, h.last_checked_at, h.last_ok_at, h.repair, h.last_swap_at, h.swaps`)
      const row = rows[0]
      if (row === undefined) return undefined
      return {
        accountId: row.account_id,
        assignment: row.assignment,
        lastOutcome: row.last_outcome,
        lastStatus: row.last_status,
        latencyMs: row.latency_ms,
        consecutiveFailures: row.consecutive_failures,
        lastCheckedAt: instant(row.last_checked_at),
        lastOkAt: instant(row.last_ok_at),
        repair: row.repair,
        lastSwapAt: instant(row.last_swap_at),
        swaps: row.swaps,
      }
    },

    recordRepair: async (input) => {
      const swapped = input.swappedAt !== undefined
      const at = sql`${input.swappedAt?.toISOString() ?? null}::timestamptz`
      await db.execute(sql`
        insert into account_egress_health as h (account_id, assignment, repair, last_swap_at, swaps, updated_at)
        select a.id, ${input.assignment}::text, ${input.repair}::text, ${at},
          ${swapped ? 1 : 0}::int, now()
        from accounts a where a.id = ${input.accountId}::uuid
        on conflict (account_id) do update set
          assignment = excluded.assignment,
          repair = excluded.repair,
          consecutive_failures = case
            when h.assignment <> excluded.assignment then 0 else h.consecutive_failures end,
          last_outcome = case
            when h.assignment <> excluded.assignment then null else h.last_outcome end,
          last_status = case
            when h.assignment <> excluded.assignment then null else h.last_status end,
          latency_ms = case
            when h.assignment <> excluded.assignment then null else h.latency_ms end,
          last_ok_at = case
            when h.assignment <> excluded.assignment then null else h.last_ok_at end,
          last_swap_at = coalesce(excluded.last_swap_at, h.last_swap_at),
          swaps = h.swaps + excluded.swaps,
          updated_at = now()`)
    },
  }
}
