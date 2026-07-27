import { z } from "zod"

/**
 * The six load-balancing policies a Pool can run. `sticky` is the default and the only one that
 * is unconditionally safe on pools holding Claude subscription accounts — `round-robin`,
 * `weighted`, and `least-used` ignore the Session → Account binding, which on the Agent-SDK path
 * breaks the conversation rather than merely costing a cold prompt cache.
 */
export const RoutingPolicy = z.enum([
  "sticky",
  "round-robin",
  "weighted",
  "least-used",
  "priority-failover",
  "quota-aware",
])
export type RoutingPolicy = z.infer<typeof RoutingPolicy>

/** The policy a Pool gets when the operator does not choose one. */
export const DEFAULT_ROUTING_POLICY: RoutingPolicy = "sticky"

/**
 * The two numbers the policies above read off a candidate, and the value each
 * carries before anyone tunes it.
 *
 * Both live on an Account *and* on each of its Pool memberships: the membership
 * value is what routing uses inside that pool, the account value is what a key
 * scoped to `all` or to an explicit account list uses, and what a fresh
 * membership starts from. They are stated once here because four places restate
 * them — two Postgres column defaults, the pool write path, and the console —
 * and a router where the schema and the form disagree about "unbiased" would
 * split traffic on a number nobody chose.
 */
export const DEFAULT_ACCOUNT_WEIGHT = 100
export const DEFAULT_ACCOUNT_PRIORITY = 0
