/**
 * Snapshot builders for the routing unit tests.
 *
 * Selection is a pure function over an injected snapshot, so every test here is a literal in,
 * an assertion out — no mocks, no fakes, no clock, no network, no database.
 */

import type { QuotaWindowKind, QuotaWindowState } from "@multi-ai-router/core"
import type {
  AccountHealth,
  AccountSnapshot,
  Candidate,
  PoolSnapshot,
  RoutingSnapshot,
  ScopedAccount,
} from "../../../src/services/routing"

export const NOW = new Date("2026-01-01T12:00:00.000Z")

export function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs)
}

export function health(overrides: Partial<AccountHealth> = {}): AccountHealth {
  return { consecutiveFailures: 0, inFlight: 0, recentTokens: 0, ...overrides }
}

export function account(id: string, overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    id,
    label: id,
    provider: "anthropic-api",
    status: "active",
    weight: 100,
    priority: 0,
    health: health(),
    ...overrides,
  }
}

/** An `anthropic-oauth` account: the SDK path, where the session binding is load-bearing. */
export function subscription(
  id: string,
  overrides: Partial<AccountSnapshot> = {},
): AccountSnapshot {
  return account(id, { provider: "anthropic-oauth", ...overrides })
}

export function pool(
  id: string,
  memberIds: readonly string[],
  overrides: Partial<PoolSnapshot> = {},
): PoolSnapshot {
  return {
    id,
    name: id,
    policy: "sticky",
    members: memberIds.map((accountId) => ({ accountId })),
    ...overrides,
  }
}

export function snapshot(
  accounts: readonly AccountSnapshot[],
  pools: readonly PoolSnapshot[] = [],
  now: Date = NOW,
): RoutingSnapshot {
  return { accounts, pools, now }
}

export function window(
  kind: QuotaWindowKind,
  overrides: Partial<QuotaWindowState> = {},
): QuotaWindowState {
  return {
    window: kind,
    utilizationSource: "none",
    resetSource: "unknown",
    lastCheckedAt: NOW,
    ...overrides,
  }
}

/** A continuous reading — the only kind `quota-aware` may rank on. */
export function continuous(
  utilization: number,
  kind: QuotaWindowKind = "five_hour",
): QuotaWindowState {
  return window(kind, { utilization, utilizationSource: "continuous" })
}

/** A threshold-triggered reading — an alarm, not a gauge. */
export function alarm(utilization: number, kind: QuotaWindowKind = "five_hour"): QuotaWindowState {
  return window(kind, { utilization, utilizationSource: "threshold-triggered" })
}

export function scoped(
  snapshotAccount: AccountSnapshot,
  order = 0,
  overrides: Partial<ScopedAccount> = {},
): ScopedAccount {
  return {
    account: snapshotAccount,
    poolId: null,
    weight: snapshotAccount.weight,
    priority: snapshotAccount.priority,
    order,
    ...overrides,
  }
}

export function candidate(
  snapshotAccount: AccountSnapshot,
  order = 0,
  overrides: Partial<Candidate> = {},
): Candidate {
  return {
    ...scoped(snapshotAccount, order),
    upstreamModel: "sonnet",
    halfOpen: false,
    ...overrides,
  }
}

export function candidates(...accounts: readonly AccountSnapshot[]): readonly Candidate[] {
  return accounts.map((entry, order) => candidate(entry, order))
}

export function ids(list: readonly Candidate[]): readonly string[] {
  return list.map((entry) => entry.account.id)
}
