/**
 * Rendezvous (highest-random-weight) hashing — the arithmetic behind `sticky`.
 *
 * Score every candidate as `hash(sessionKey || accountId)` and take the highest. Deterministic,
 * restart-safe with nothing stored, and minimally disruptive: adding an account moves only the
 * sessions that hash to it, removing one reassigns only that account's sessions.
 *
 * **This function is pinned.** `test/unit/routing/hash.test.ts` asserts hard-coded score literals
 * and placements. Changing the mix reshuffles every unbound session onto a cold cache on upgrade —
 * a breaking change that ships with a migration note, never a test casually updated.
 *
 * Allocation-light on purpose: the session key is folded once into a seed, then each account id is
 * mixed into that seed in place. No concatenated strings, no arrays beyond the ranking itself.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

/** Two independent 32-bit lanes are combined into one 53-bit score, so ties are vanishingly rare. */
const LANE_A = 0x9e3779b1
const LANE_B = 0x85ebca6b

const LANE_A_SHIFT = 2097152 // 2^21
const SCORE_SPACE = 9007199254740992 // 2^53

/** FNV-1a over UTF-16 code units, seeded. Deterministic across engines and platforms. */
function fnv1a(input: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}

/** MurmurHash3's 32-bit finalizer: avalanches the low-entropy tail FNV-1a leaves behind. */
function fmix32(value: number): number {
  let hash = value >>> 0
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35)
  hash ^= hash >>> 16
  return hash >>> 0
}

/**
 * Folds a session key into a reusable seed. Compute once per selection, then score every
 * candidate against it.
 */
export function sessionSeed(sessionKey: string): number {
  return fnv1a(sessionKey, FNV_OFFSET_BASIS)
}

/** The rendezvous score of one account under a pre-folded session seed. In `[0, 1)`. */
export function scoreWithSeed(seed: number, accountId: string): number {
  const laneA = fmix32(fnv1a(accountId, (seed ^ LANE_A) >>> 0))
  const laneB = fmix32(fnv1a(accountId, (seed ^ LANE_B) >>> 0))
  return (laneA * LANE_A_SHIFT + (laneB >>> 11)) / SCORE_SPACE
}

/** The rendezvous score of `(sessionKey, accountId)`. In `[0, 1)`. Pinned by test vectors. */
export function rendezvousScore(sessionKey: string, accountId: string): number {
  return scoreWithSeed(sessionSeed(sessionKey), accountId)
}

/**
 * Ranks account ids by descending rendezvous score. Ties break on the id, so the order is total
 * and reproducible even in the (astronomically unlikely) event two accounts collide.
 */
export function rendezvousRank(
  sessionKey: string,
  accountIds: readonly string[],
): readonly string[] {
  const seed = sessionSeed(sessionKey)
  return [...accountIds].sort((left, right) => {
    const delta = scoreWithSeed(seed, right) - scoreWithSeed(seed, left)
    if (delta !== 0) return delta
    return left < right ? -1 : left > right ? 1 : 0
  })
}
