import type { RoutingPolicy } from "@multi-ai-router/core"
import { request } from "./client"
import type { DeletedView, PoolView } from "./types"

// `/api/admin/pools`. Request shapes mirror `services/pools/schemas.ts`.
//
// There is no membership endpoint, deliberately: a pool is edited as one object
// and `members` **replaces** the whole set in a single transaction. A pool is
// therefore never briefly half-populated, and routing never reads a membership
// list mid-edit. Sending a partial array here removes everything not in it.

export interface PoolMemberInput {
  readonly accountId: string
  /** Overrides the account's own weight, within this pool only. */
  readonly weight?: number
  readonly priority?: number
}

export interface CreatePoolInput {
  readonly name: string
  readonly policy?: RoutingPolicy
  readonly members?: readonly PoolMemberInput[]
  /** Must be one of `members`. `null` is the same as absent: no overflow. */
  readonly overflowAccountId?: string | null
}

export interface UpdatePoolInput {
  readonly name?: string
  readonly policy?: RoutingPolicy
  /** Replaces the membership set. Absent leaves it alone; `[]` empties it. */
  readonly members?: readonly PoolMemberInput[]
  /** `null` clears the overflow account. */
  readonly overflowAccountId?: string | null
}

export function listPools(): Promise<readonly PoolView[]> {
  return request<readonly PoolView[]>({ method: "GET", path: "/pools" })
}

export function createPool(input: CreatePoolInput): Promise<PoolView> {
  return request<PoolView>({ method: "POST", path: "/pools", body: input })
}

export function updatePool(args: {
  readonly id: string
  readonly patch: UpdatePoolInput
}): Promise<PoolView> {
  return request<PoolView>({ method: "PATCH", path: `/pools/${args.id}`, body: args.patch })
}

/** 409s naming every key scoped to this pool — deleting it would narrow them silently. */
export function deletePool(id: string): Promise<DeletedView> {
  return request<DeletedView>({ method: "DELETE", path: `/pools/${id}` })
}
