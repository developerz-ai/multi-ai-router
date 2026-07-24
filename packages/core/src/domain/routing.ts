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
