/**
 * `sticky` (the default) — session affinity by rendezvous hashing.
 *
 * Score every candidate as `hash(sessionKey || accountId)` and take the highest. Deterministic,
 * restart-safe with no stored map, and minimally disruptive: adding an account moves only the
 * sessions that hash to it; removing one reassigns only that account's sessions.
 *
 * It is the default for **correctness**, not economics. On the Claude subscription path an SDK
 * session id is resumable only on the account that created it, so spreading a conversation
 * evenly does not cost a cache — it breaks the conversation. The cache argument is real and
 * secondary.
 *
 * Placement is all this computes. Where a binding already exists, the binding is the truth and
 * `runPolicy` pins it ahead of whatever this returns.
 */

import { scoreWithSeed, sessionSeed } from "../hash"
import { compareDeclared, type Policy } from "./order"

export const sticky: Policy = ({ candidates, sessionKey }) => {
  const seed = sessionSeed(sessionKey)
  const ordered = [...candidates].sort((left, right) => {
    const delta = scoreWithSeed(seed, right.account.id) - scoreWithSeed(seed, left.account.id)
    return delta !== 0 ? delta : compareDeclared(left, right)
  })
  return { ordered, notes: [] }
}
