/**
 * The per-pool request counter `round-robin`, `weighted`, and `quota-aware`'s tiebreak rotate on.
 *
 * Selection is pure and reads the counter off the snapshot (`PoolSnapshot.rotationCounter`, "owned
 * by the caller"); this is the caller's half. Until it existed nothing set the field, so every
 * rotation policy ran at counter `0` on every request — a fixed head, indistinguishable from the
 * pool's declared order. Twenty new sessions on a six-account `round-robin` pool all landed on the
 * same account.
 *
 * Two properties decide the shape:
 *
 * - **Keyed per pool, advanced only when that pool placed something.** A single router-wide counter
 *   would let another key's traffic on another pool stride this pool's rotation — at a 6:1 ratio a
 *   six-member pool would see `0, 6, 12, …` and never move off its first member.
 * - **Advanced only for a placement the policy made.** A honored Session → Account binding chose
 *   nothing: the bound account is the head whatever the counter says (`routing/policies/index.ts`).
 *   Counting those turns would leave the rotation for *new* sessions at whatever offset the bound
 *   traffic happened to stop on — random, not round-robin. So on a Claude subscription pool the
 *   counter is exactly "how many unbound sessions this pool has placed", and consecutive new sessions
 *   land on consecutive accounts. On the plain HTTP path no binding is ever honored, so every request
 *   advances it, which is the per-request rotation the policy documents.
 *
 * In memory and per replica, like the health store: two replicas rotate independently, which is
 * still an even spread in aggregate. Nothing here is persisted or takes a lock — this sits inside the
 * overhead budget on every request.
 */

export interface RotationCounters {
  /** The counter a pool's policy reads for this request. `null` is the unpooled (flat) scope group. */
  current(poolId: string | null): number
  /** One placement happened in this pool: the next unbound session sees the next head. */
  advance(poolId: string | null): void
}

/** The map key for the flat group a key scoped `all` or to explicit accounts resolves to. */
const UNPOOLED = ""

export function createRotationCounters(): RotationCounters {
  const counters = new Map<string, number>()
  const keyOf = (poolId: string | null): string => poolId ?? UNPOOLED

  return {
    current: (poolId) => counters.get(keyOf(poolId)) ?? 0,
    advance: (poolId) => {
      const key = keyOf(poolId)
      // Wraps long before precision matters: the policies reduce it modulo the candidate count.
      const next = (counters.get(key) ?? 0) + 1
      counters.set(key, next === Number.MAX_SAFE_INTEGER ? 0 : next)
    },
  }
}
