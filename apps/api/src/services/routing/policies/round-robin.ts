/**
 * `round-robin` — even rotation across the eligible candidates, one request at a time, ignoring
 * session identity.
 *
 * The flattest possible spread, and it **destroys cache affinity**: a multi-turn conversation
 * hits a different account every turn and pays a cold cache each time. On a Claude subscription
 * pool a hop is not a cold cache, it is an unresumable conversation — which is why `runPolicy`
 * pins an existing Session -> Account binding ahead of this ordering. Rotation only ever chooses
 * for a session that has no binding.
 */

import { type Policy, rotate, sortDeclared } from "./order"

export const roundRobin: Policy = ({ candidates, rotationCounter }) => ({
  ordered: rotate(sortDeclared(candidates), rotationCounter),
  notes: [],
})
