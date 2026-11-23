import { isRouterError } from "@multi-ai-router/core"
import { type Candidate, REQUEST_WALL_AFTER, type SelectionResult } from "../routing"
import type { ServableCandidate } from "./plan"

/**
 * A plan that offers one account under several models (`free-select.ts`) as consecutive chains of
 * distinct accounts, in the plan's order — the chain's own rule ("each attempt is a distinct
 * account", `routing/failover.ts`) holds inside every leg. A plan with no repeat is one leg, which
 * is every request that names a real model.
 */
export function legsOf(
  plan: readonly ServableCandidate[],
): readonly (readonly ServableCandidate[])[] {
  const legs: ServableCandidate[][] = []
  let seen = new Set<string>()
  for (const entry of plan) {
    const id = entry.account.id
    const current = legs.at(-1)
    if (current === undefined || seen.has(id)) {
      legs.push([entry])
      seen = new Set([id])
      continue
    }
    current.push(entry)
    seen.add(id)
  }
  return legs
}

/** `400`s about the request's own content. Another model may still take it; two refusals say not. */
const REQUEST_SHAPED: ReadonlySet<number> = new Set([400, 413, 422])

/**
 * Walks the legs until one answers. A leg's failure is final when the client is gone, when it is the
 * last one, or when {@link REQUEST_WALL_AFTER} legs refused the request itself. Nothing has reached
 * the client in any other case: a chain that streamed returns the `2xx` it started.
 *
 * `reselect` runs before each later leg, so an account that an earlier leg cooled is not asked again.
 */
export async function walkLegs(
  plan: readonly ServableCandidate[],
  run: (leg: readonly ServableCandidate[]) => Promise<Response>,
  reselect: () => SelectionResult,
  signal: AbortSignal,
): Promise<Response> {
  const legs = legsOf(plan)
  let refusals = 0
  let settle: () => Response = unreachable

  for (const [at, leg] of legs.entries()) {
    const live = at === 0 ? leg : stillLive(leg, reselect())
    if (live.length === 0) continue
    try {
      const response = await run(live)
      if (response.ok) return response
      if (REQUEST_SHAPED.has(response.status)) refusals += 1
      settle = () => response
    } catch (error) {
      // A router verdict about this leg; anything else is a bug or the client leaving.
      if (signal.aborted || !isRouterError(error)) throw error
      if (REQUEST_SHAPED.has(error.status)) refusals += 1
      settle = () => {
        throw error
      }
    }
    if (refusals >= REQUEST_WALL_AFTER) break
  }
  return settle()
}

function unreachable(): never {
  throw new Error("a chain with no legs was walked")
}

function stillLive(
  leg: readonly ServableCandidate[],
  selection: SelectionResult,
): readonly ServableCandidate[] {
  if (!selection.ok) return []
  const live = new Set(selection.candidates.map(keyOf))
  return leg.filter((entry) => live.has(keyOf(entry.candidate)))
}

const keyOf = (candidate: Candidate): string =>
  `${candidate.account.id}\n${candidate.upstreamModel}`
