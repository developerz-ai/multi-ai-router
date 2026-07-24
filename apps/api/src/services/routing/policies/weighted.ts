/**
 * `weighted` — round-robin biased by each account's membership `weight`. Weight 3 gets roughly
 * three times the share of weight 1.
 *
 * The head is picked by walking the cumulative weights at `rotationCounter mod totalWeight`, so
 * the distribution over a run of counters is exactly proportional rather than approximately so.
 * The failover tail behind it is ordered by descending weight: if the biggest account cannot
 * serve, the next-biggest is the obvious second choice.
 *
 * Weights are a static guess — they react to neither live load nor quota. Same cache-affinity
 * loss as round-robin, and the same binding caveat: `runPolicy` pins a bound session first.
 */

import { accountIds, compareDeclared, type Policy, rotate, sortDeclared } from "./order"

export const weighted: Policy = ({ candidates, rotationCounter }) => {
  const sorted = sortDeclared(candidates)
  const weights = sorted.map((candidate) => Math.max(0, Math.trunc(candidate.weight)))
  const total = weights.reduce((sum, weight) => sum + weight, 0)

  if (total === 0) {
    // Every weight is zero or negative: there is no bias to apply, and pretending otherwise
    // would silently concentrate the pool on whichever account happened to sort first.
    return {
      ordered: rotate(sorted, rotationCounter),
      notes: [{ kind: "weights-absent", accountIds: accountIds(sorted) }],
    }
  }

  const headIndex = pickIndex(weights, total, rotationCounter)
  const head = sorted[headIndex]
  const tail = sorted
    .filter((_, index) => index !== headIndex)
    .sort((left, right) => right.weight - left.weight || compareDeclared(left, right))

  return { ordered: head === undefined ? tail : [head, ...tail], notes: [] }
}

function pickIndex(weights: readonly number[], total: number, counter: number): number {
  const target = ((Math.trunc(counter) % total) + total) % total
  let cumulative = 0
  for (let index = 0; index < weights.length; index += 1) {
    cumulative += weights[index] ?? 0
    if (target < cumulative) return index
  }
  return weights.length - 1
}
