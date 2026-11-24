import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import {
  type EgressOverview,
  fetchEgressOverview,
  type ProxyCheck,
  type ProxyHealthView,
  setEgressProxy,
  setReplaceMode,
  testAccountProxy,
  testProxy,
} from "../api/egress"
import { invalidateAccountReaders } from "./account-readers"
import { queryKeys } from "./query-keys"

/** Longer than the console default: one read asks each proxy vendor for its whole list. */
const OVERVIEW_STALE_MS = 60_000

/** Every proxy the router can name and every account behind one. */
export function useEgressOverview() {
  return useQuery(() => ({
    queryKey: queryKeys.egress.overview(),
    queryFn: () => fetchEgressOverview(),
    staleTime: OVERVIEW_STALE_MS,
    retry: false,
  }))
}

// The account row carries its proxy's address and the overview carries who uses which, so a change
// to either side refetches both, and the audit log with them.
async function invalidateEgressReaders(client: ReturnType<typeof useQueryClient>): Promise<void> {
  await Promise.all([
    invalidateAccountReaders(client),
    client.invalidateQueries({ queryKey: queryKeys.egress.root() }),
  ])
}

export function useSetEgressProxy() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: setEgressProxy,
    // A pasted proxy URL carries its password; it must not outlive the form.
    gcTime: 0,
    onSuccess: () => invalidateEgressReaders(client),
  }))
}

export function useSetReplaceMode() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: setReplaceMode,
    onSuccess: () => invalidateEgressReaders(client),
  }))
}

export function useTestProxy() {
  return useMutation(() => ({
    mutationFn: testProxy,
    gcTime: 0,
  }))
}

export function useTestAccountProxy() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (tested: TestedProxy) => testAccountProxy(tested.accountId),
    // Into the row it is about. Refetching would ask every vendor for its whole list, per press.
    onSuccess: (check: ProxyCheck, tested) => {
      client.setQueryData<EgressOverview>(queryKeys.egress.overview(), (held) =>
        held === undefined ? held : withCheck(held, tested, check),
      )
    },
  }))
}

export interface TestedProxy {
  readonly accountId: string
  readonly address: string
}

/** The overview with one check recorded the way the router records it: shown, never counted. */
function withCheck(held: EgressOverview, tested: TestedProxy, check: ProxyCheck): EgressOverview {
  const alive = check.outcome === "ok" || check.outcome === "refused"
  const record = (health: ProxyHealthView): ProxyHealthView => ({
    ...health,
    outcome: check.outcome,
    status: check.status,
    latencyMs: check.latencyMs,
    lastCheckedAt: check.checkedAt,
    // Either answer proves the proxy alive, so nothing is left to repair.
    ...(alive ? { consecutiveFailures: 0, repair: "idle" as const } : {}),
    ...(check.outcome === "ok" ? { lastOkAt: check.checkedAt } : {}),
  })
  return {
    ...held,
    assigned: held.assigned.map((row) =>
      row.account.id === tested.accountId && row.address === tested.address
        ? { ...row, health: record(row.health) }
        : row,
    ),
  }
}
