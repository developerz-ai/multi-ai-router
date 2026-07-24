/**
 * `priority-failover` — strict order by each account's membership `priority`, lower first.
 * Always take the highest-priority eligible account; descend **only** when everything above it
 * has been filtered out. Ties fall back to the pool's declared order.
 *
 * Deliberately *not* load balancing: account #1 absorbs everything until it is exhausted or
 * cooling down. That concentrates load and concentrates blast radius, and it is the point —
 * "burn the subscription first, fall back to the paid API".
 *
 * Session affinity here is incidental: the top account holds a session simply because it holds
 * everything. Once it is filtered out, the binding rules decide the session's fate, not this
 * ordering.
 */

import { compareDeclared, type Policy } from "./order"

export const priorityFailover: Policy = ({ candidates }) => {
  const ordered = [...candidates].sort(
    (left, right) => left.priority - right.priority || compareDeclared(left, right),
  )
  return { ordered, notes: [] }
}
