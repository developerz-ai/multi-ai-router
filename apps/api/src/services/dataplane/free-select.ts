import { ownEntry } from "@multi-ai-router/core"
import { type FreeModelRow, ownsFreeId } from "../models"
import {
  type AccountSnapshot,
  type Candidate,
  type RoutingSnapshot,
  type SelectionOptions,
  type SelectionRequest,
  type SelectionResult,
  selectAccounts,
} from "../routing"

/**
 * The one model name the router itself resolves to several: **`free`**, the smartest free model the
 * presenting key can reach, then the next, until one answers.
 *
 * A client that names it has picked "whatever costs nothing, best first" — the same thing
 * `openrouter/free` is — so nothing is substituted: a request naming any other model is never moved
 * onto a free one (non-negotiable 4, amended 2026-11-23). The model that served is on the response
 * and on the usage row's `upstream_model`, beside `free` as the requested name.
 */
export const FREE_MODEL = "free"

/** Asked for, and not a name an operator gave an account: an alias they wrote is theirs. */
export function isFreeRequest(snapshot: RoutingSnapshot, model: string): boolean {
  return (
    model === FREE_MODEL &&
    !snapshot.accounts.some((account) => ownEntry(account.modelAliases ?? {}, model) !== undefined)
  )
}

/**
 * One ordinary selection per ranked id, concatenated smartest first. Scope, health, policy and
 * per-model holds are the ones every request gets; only the accounts that serve the id for nothing
 * are in front of it. An account may appear once per model — `free-walk.ts` cuts the list back into
 * chains of distinct accounts.
 */
export function selectFree(
  snapshot: RoutingSnapshot,
  request: SelectionRequest,
  options: SelectionOptions | undefined,
  ranking: readonly FreeModelRow[],
): SelectionResult {
  const candidates: Candidate[] = []
  let chosen: SelectionResult | undefined
  let refused: SelectionResult | undefined

  for (const row of ranking) {
    for (const id of idsOf(row)) {
      const result = selectAccounts(
        {
          ...snapshot,
          accounts: snapshot.accounts.map((account) =>
            gives(row, account, id) ? account : withheld(account),
          ),
        },
        { ...request, model: id },
        options,
      )
      if (result.ok) {
        chosen ??= result
        candidates.push(...result.candidates)
        continue
      }
      // A free account that is cooling says more than one that never served the id.
      const waits = result.decision.rejected.some((entry) => entry.reason !== "model-unsupported")
      if (refused === undefined || (waits && !waitsOn(refused))) refused = result
    }
  }

  if (chosen?.ok === true) return { ...chosen, candidates }
  // An empty ranking is the only way to reach the fallback: say so in the ordinary way.
  return refused ?? selectAccounts(snapshot, request, options)
}

/**
 * An account that does not give this id away, left in scope serving nothing: dropping it instead
 * would empty the scope and answer `403` for what is an unserved model (`404`).
 */
function withheld(account: AccountSnapshot): AccountSnapshot {
  return { ...account, supportedModels: [NO_MODEL], modelAliases: {} }
}

/** No request names the empty model (`body/preflight.ts`), so no request is served by it. */
const NO_MODEL = ""

function waitsOn(result: SelectionResult): boolean {
  return result.decision.rejected.some((entry) => entry.reason !== "model-unsupported")
}

function idsOf(row: FreeModelRow): readonly string[] {
  return [...new Set(Object.values(row.ids).flat())]
}

/**
 * The account serves this id for nothing **under this name**. An alias that renames it may point at
 * a billed model, and an account that declares neither models nor a family accepts every name, so
 * its silence is no evidence that it carries this one.
 */
function gives(row: FreeModelRow, account: AccountSnapshot, id: string): boolean {
  if (!ownsFreeId(row, account.provider, id)) return false
  if (ownEntry(account.modelAliases ?? {}, id) !== undefined) return false
  return (account.supportedModels?.length ?? 0) > 0 || account.modelFamily !== undefined
}
