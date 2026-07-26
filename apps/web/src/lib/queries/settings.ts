import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import type { Accessor } from "solid-js"
import { type AuditQuery, fetchAuditLog } from "../api/audit"
import { fetchSettings, type PriceRate, savePriceOverrides } from "../api/settings"
import { fetchTasks } from "../api/tasks"
import { queryKeys } from "./query-keys"

// Server state for the settings screen: router configuration, scheduled-task
// health, audit log. Three endpoints, one screen.

export function useSettings() {
  return useQuery(() => ({
    queryKey: queryKeys.settings.detail(),
    queryFn: () => fetchSettings(),
  }))
}

/**
 * Scheduled-task health, polled — one of the two reads in the console with a
 * `refetchInterval` (the other is the live request feed, for the same reason).
 *
 * The failure this surface exists to catch is a task that **silently stopped**
 * (docs/idea/08-observability.md#scheduled-task-visibility). A tab left open on
 * this screen must show that happening without the operator reloading, so the
 * data refreshes on its own. Thirty seconds is far below the shortest task
 * cadence and the response is a handful of rows, so the poll can never be the
 * reason a stall goes unnoticed and never the reason the router is busy.
 */
export function useTasks() {
  return useQuery(() => ({
    queryKey: queryKeys.tasks.list(),
    queryFn: () => fetchTasks(),
    refetchInterval: 30_000,
  }))
}

export function useAuditLog(query: Accessor<AuditQuery>) {
  return useQuery(() => ({
    queryKey: queryKeys.audit.list(query()),
    queryFn: () => fetchAuditLog(query()),
  }))
}

/**
 * Saving replaces the whole stored override table with the array sent, and the
 * response is the new settings body. The settings **root** is invalidated rather
 * than the response being written into the cache: the server owns `updatedAt`
 * and the clamped values, and a hand-placed copy is how a table starts showing
 * numbers nobody stored.
 */
export function useSavePriceOverrides() {
  const client = useQueryClient()
  return useMutation(() => ({
    mutationFn: (overrides: readonly PriceRate[]) => savePriceOverrides(overrides),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.settings.root() }),
  }))
}
