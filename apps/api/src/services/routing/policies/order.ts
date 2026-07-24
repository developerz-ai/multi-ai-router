/**
 * Shared ordering primitives for the six policies.
 *
 * Every policy produces a **total** order over the same candidates: no policy may leave two
 * accounts in an engine-dependent order, or the same snapshot would route differently on two
 * replicas. The pool's declared order is the universal last tiebreak, and the account id backs
 * even that up.
 */

import type { PolicyNote } from "../result"
import type { Candidate } from "../types"

export interface PolicyInput {
  /** Already scope-intersected and filtered. Never empty when a policy runs. */
  readonly candidates: readonly Candidate[]
  readonly sessionKey: string
  /** The caller's per-pool request counter. The only state `round-robin` and `weighted` need. */
  readonly rotationCounter: number
  readonly options: PolicyOptions
}

export interface PolicyOptions {
  readonly leastUsedMeasure?: "in-flight" | "recent-tokens"
}

export interface PolicyOutput {
  readonly ordered: readonly Candidate[]
  /** Declared in `result.ts` — the admin surface owns the shape of what it renders. */
  readonly notes: readonly PolicyNote[]
}

export type Policy = (input: PolicyInput) => PolicyOutput

/** The pool's declared order, then the account id. Deterministic on every engine. */
export function compareDeclared(left: Candidate, right: Candidate): number {
  if (left.order !== right.order) return left.order - right.order
  return left.account.id < right.account.id ? -1 : left.account.id > right.account.id ? 1 : 0
}

export function sortDeclared(candidates: readonly Candidate[]): readonly Candidate[] {
  return [...candidates].sort(compareDeclared)
}

/**
 * Rotates a list by a counter. Negative and huge counters behave; the caller's counter is only
 * ever required to be an integer that moves.
 */
export function rotate(candidates: readonly Candidate[], counter: number): readonly Candidate[] {
  if (candidates.length === 0) return candidates
  const size = candidates.length
  const offset = ((Math.trunc(counter) % size) + size) % size
  return [...candidates.slice(offset), ...candidates.slice(0, offset)]
}

export function accountIds(candidates: readonly Candidate[]): readonly string[] {
  return candidates.map((candidate) => candidate.account.id)
}
