import { RoutingPolicy } from "@multi-ai-router/core"
import { z } from "zod"

/**
 * The pool write contract.
 *
 * `policy` is core's `RoutingPolicy` schema itself, never a restated list of six
 * strings: the Postgres enum is built from the same `.options` array, so the
 * validated value and the column can only ever agree (docs/reusable-code.md,
 * "Things that must never be duplicated").
 *
 * Membership is sent as a whole set rather than patched member by member. The
 * console edits a pool as one object, and a partial membership edit has no
 * meaningful intermediate state — a pool that is briefly missing a member is a
 * pool that briefly routes somewhere else.
 */

const POOL_NAME = z.string().trim().min(1).max(120)
const WEIGHT = z.number().int().min(1).max(10_000)
const PRIORITY = z.number().int().min(0).max(10_000)

export const poolMemberInput = z
  .object({
    accountId: z.uuid(),
    /** Bias for `weighted`, within this pool only. Absent inherits the account's own. */
    weight: WEIGHT.optional(),
    /** Order for `priority-failover`, within this pool only. Lower is tried first. */
    priority: PRIORITY.optional(),
  })
  .strict()

export type PoolMemberInputBody = z.infer<typeof poolMemberInput>

export const createPoolBody = z
  .object({
    name: POOL_NAME,
    policy: RoutingPolicy.optional(),
    members: z.array(poolMemberInput).max(200).optional(),
    /**
     * The member of last resort — one of `members`, held back from the policy until the pool
     * filters empty. `null` is the same as absent: no overflow.
     */
    overflowAccountId: z.uuid().nullable().optional(),
  })
  .strict()

export type CreatePoolBody = z.infer<typeof createPoolBody>

export const updatePoolBody = z
  .object({
    name: POOL_NAME.optional(),
    policy: RoutingPolicy.optional(),
    members: z.array(poolMemberInput).max(200).optional(),
    /** `null` clears the overflow account; an absent key leaves it alone. */
    overflowAccountId: z.uuid().nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: "no fields to update" })

export type UpdatePoolBody = z.infer<typeof updatePoolBody>
