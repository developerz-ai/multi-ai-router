import type { AccountListFilter } from "../api/accounts"
import type { AuditQuery } from "../api/audit"
import type { UsageWindow } from "../api/usage"

// Every cache key in the console, built here and nowhere else.
//
// Structured, not stringly-typed: each resource has a `root` that is a **prefix
// of every key beneath it**, which is what makes `invalidateQueries({ queryKey:
// root })` invalidate the list, the filtered lists and the details in one call.
// A hand-written `["accounts", "list"]` at a call site is how a mutation ends up
// invalidating nothing and the table silently goes stale.
//
// `as const` throughout so a typo in a key is a type error rather than a cache
// miss that looks like a loading spinner.

export const queryKeys = {
  session: () => ["session"] as const,

  accounts: {
    root: () => ["accounts"] as const,
    list: (filter: AccountListFilter) =>
      ["accounts", "list", filter.status ?? null, filter.provider ?? null] as const,
    detail: (id: string) => ["accounts", "detail", id] as const,
    /** Last re-check per account. Written by the mutation, read by the row. */
    recheck: (id: string) => ["accounts", "recheck", id] as const,
  },

  pools: {
    root: () => ["pools"] as const,
    list: () => ["pools", "list"] as const,
    detail: (id: string) => ["pools", "detail", id] as const,
  },

  keys: {
    root: () => ["keys"] as const,
    list: () => ["keys", "list"] as const,
    detail: (id: string) => ["keys", "detail", id] as const,
  },

  providers: {
    root: () => ["providers"] as const,
    list: () => ["providers", "list"] as const,
  },

  usage: {
    root: () => ["usage"] as const,
    summary: (window: UsageWindow) => ["usage", "summary", window] as const,
  },

  /** One body carries retention, log level and the price table, so one detail key holds all of it. */
  settings: {
    root: () => ["settings"] as const,
    detail: () => ["settings", "detail"] as const,
  },

  tasks: {
    root: () => ["tasks"] as const,
    list: () => ["tasks", "list"] as const,
  },

  audit: {
    root: () => ["audit"] as const,
    list: (query: AuditQuery) =>
      ["audit", "list", query.limit, query.kind ?? null, query.subjectId ?? null] as const,
  },
} as const
