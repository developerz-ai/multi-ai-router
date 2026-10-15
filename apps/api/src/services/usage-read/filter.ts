import type { UsageFilter } from "@multi-ai-router/db"
import { z } from "zod"
import type { KeyLabel } from "./types"
import { usageWindowQuery } from "./window"

/**
 * The usage filters, as they arrive on the wire: owner, tool, model, keyId, poolId and accountId,
 * each a list. Composed apart from `usageWindowQuery`, whose refinements make zod 4 refuse
 * `.pick`, `.omit` and key-overwriting `.extend` on it.
 *
 * Ids are validated as uuids (and lowercased) here so a malformed one is a 400 at the boundary,
 * never a Postgres cast error. `owner` and `tool` are matched exactly against the stored lowercase slug (no
 * trimming, no case folding, no wildcard); `model` is matched exactly against the recorded
 * client-facing model name. Lists are capped so one request cannot ship an unbounded array.
 */
const LIST_MAX = 500
const text = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !value.includes("\u0000"), "must not contain a NUL character")
// Postgres renders uuids lowercase, so a pasted uppercase id is folded here rather than missed.
const id = z.uuid().transform((value) => value.toLowerCase())
const list = <T extends z.ZodType>(item: T) => z.array(item).min(1).max(LIST_MAX).optional()

export const usageFilterQuery = z.object({
  owner: list(text),
  tool: list(text),
  model: list(text),
  keyId: list(id),
  poolId: list(id),
  accountId: list(id),
})

export type UsageFilterQuery = z.output<typeof usageFilterQuery>

/** The six filter parameter names, in one place for the route to read as repeated params. */
export const USAGE_FILTER_PARAMS = Object.keys(usageFilterQuery.shape) as readonly string[]

/**
 * Every query key `GET /api/admin/usage` understands: the window keys (read off the window schema,
 * so a new window key cannot be forgotten here) plus the six filters. Anything else is a `400`,
 * because a misspelled filter would otherwise be dropped and answer with unfiltered totals.
 * Exported so the sibling export route can apply the same check.
 */
export const USAGE_QUERY_PARAMS: ReadonlySet<string> = new Set([
  ...Object.keys(usageWindowQuery.shape),
  ...USAGE_FILTER_PARAMS,
])

/** Names the first query key outside `USAGE_QUERY_PARAMS`, truncated so a long key is not echoed. */
export function unknownQueryParam(names: Iterable<string>): string | undefined {
  for (const name of names) if (!USAGE_QUERY_PARAMS.has(name)) return name.slice(0, 64)
  return undefined
}

/**
 * Resolves the wire filter to the repository's. Pure: the key label map is injected.
 *
 * `owner` and `tool` become a key-id set from the label map (live keys plus tombstones). A key
 * without that label never matches. Owner, tool and keyId combine as an intersection, so the
 * result can only narrow. "No key filter" (`apiKeyIds` absent) and "a key filter that resolved to
 * nothing" (`apiKeyIds: []`) stay distinct: the second reads as zeros, never as unfiltered.
 */
export function resolveUsageFilter(
  query: UsageFilterQuery,
  keys: ReadonlyMap<string, KeyLabel>,
): UsageFilter {
  let apiKeyIds: string[] | undefined
  const narrow = (ids: string[]) => {
    apiKeyIds = apiKeyIds === undefined ? ids : apiKeyIds.filter((id) => ids.includes(id))
  }
  const byLabel = (field: "owner" | "tool", wanted: readonly string[]) =>
    [...keys]
      .filter(([, key]) => key[field] !== null && wanted.includes(key[field]))
      .map(([id]) => id)
  if (query.owner !== undefined) narrow(byLabel("owner", query.owner))
  if (query.tool !== undefined) narrow(byLabel("tool", query.tool))
  if (query.keyId !== undefined) narrow([...new Set(query.keyId)])
  return {
    ...(apiKeyIds === undefined ? {} : { apiKeyIds }),
    ...(query.accountId === undefined ? {} : { accountIds: query.accountId }),
    ...(query.poolId === undefined ? {} : { poolIds: query.poolId }),
    ...(query.model === undefined ? {} : { models: query.model }),
  }
}
