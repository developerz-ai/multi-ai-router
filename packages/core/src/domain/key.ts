import { z } from "zod"

/**
 * What a router key may reach.
 *
 * - `all` — every active Account, skipping Pools entirely.
 * - `pools` — the members of the named Pools, inheriting each pool's routing policy.
 * - `accounts` — an explicit account list, ignoring pool membership.
 *
 * Scope is enforced as an intersection at selection time: candidates are always pool members ∩
 * key scope. An empty intersection is an error naming the cause, never a widening.
 */
export const KeyScope = z.enum(["all", "pools", "accounts"])
export type KeyScope = z.infer<typeof KeyScope>

/**
 * What kind of entity a key's `owner` label names. Attribution only — it exists
 * so usage views can group person-issued keys apart from service-issued ones;
 * it is not a login, a role, or any kind of principal the router authenticates.
 */
export const KeyOwnerKind = z.enum(["person", "service"])
export type KeyOwnerKind = z.infer<typeof KeyOwnerKind>
