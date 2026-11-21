import type { AccountRow } from "@multi-ai-router/db"

/** One remembered removal, as `accounts.supported_models_removed` stores it. */
export type SupportedModelRemoval = NonNullable<AccountRow["supportedModelsRemoved"]>[number]

/**
 * **The rule for every write to an account's `supportedModels`, as one pure function.**
 *
 * The list is hand-maintained in part — pinned variants and ids a catalogue never lists — so the
 * one invariant is: **an id leaves the list only when the caller named it.** On 2026-11-15
 * "Discover models" replaced the whole list with the upstream's catalogue, a hand-added id the
 * catalogue does not carry vanished, and every request for it was refused `model-unsupported` for
 * 19 hours. Two edit shapes, and neither can remove an id implicitly:
 *
 * - `edit` — add these, remove these. Discovery is an `edit` with only `add`: it merges. Adding an
 *   id that is already there, or removing one that is not, changes nothing.
 * - `replace` — the full list, *and* the ids the caller means to remove. Every id the replacement
 *   would drop must be in `removing`, or the write is refused naming the ones that are not: a
 *   client holding a stale copy cannot drop an id it never saw.
 *
 * It runs inside the repository's row lock (`editSupportedModels`), against the row as it stands
 * after every earlier writer committed — so `current` is never a stale read.
 *
 * Every removal is remembered with its instant and actor for `memoryMs`
 * (`MODEL_REMOVAL_MEMORY_DAYS`), which is what lets a later `model-unsupported` refusal say
 * "removed at T by X" instead of leaving the next debugger to find the edit.
 */

export type SupportedModelsEdit =
  | {
      readonly kind: "edit"
      readonly add: readonly string[]
      readonly remove: readonly string[]
    }
  | {
      readonly kind: "replace"
      /** `null` (or `[]`) drops the declaration: the account returns to passthrough. */
      readonly models: readonly string[] | null
      /** Every id the replacement drops. Extra names are harmless; a missing one is a refusal. */
      readonly removing: readonly string[]
    }

export interface SupportedModelsState {
  readonly supportedModels: readonly string[] | null
  readonly supportedModelsRemoved: readonly SupportedModelRemoval[] | null
}

export interface SupportedModelsChange {
  readonly before: readonly string[]
  /** `null` when the result is empty: unknown is passthrough, and `[]` would mean the same. */
  readonly after: readonly string[] | null
  readonly added: readonly string[]
  readonly removed: readonly string[]
}

export type SupportedModelsRefusal =
  /** The same id asked to be both added and removed. */
  | { readonly kind: "contradictory_edit"; readonly models: readonly string[] }
  /** The replacement drops ids the caller did not name in `removing`. */
  | { readonly kind: "unacknowledged_removal"; readonly unnamed: readonly string[] }

export type SupportedModelsPlan =
  | {
      readonly ok: true
      readonly change: SupportedModelsChange
      /** The removal memory to store beside `after`; `null` when it holds nothing. */
      readonly removals: SupportedModelRemoval[] | null
    }
  | { readonly ok: false; readonly refusal: SupportedModelsRefusal }

export interface SupportedModelsContext {
  readonly now: Date
  /** The audit actor of this write. */
  readonly by: string
  /** How long a removal is remembered. */
  readonly memoryMs: number
}

export function planSupportedModelsEdit(
  current: SupportedModelsState,
  edit: SupportedModelsEdit,
  context: SupportedModelsContext,
): SupportedModelsPlan {
  const before = current.supportedModels ?? []
  const next = edit.kind === "edit" ? applyEdit(before, edit) : applyReplace(before, edit)
  if (!next.ok) return next

  const kept = new Set(next.after)
  const had = new Set(before)
  const added = next.after.filter((id) => !had.has(id))
  const removed = before.filter((id) => !kept.has(id))
  return {
    ok: true,
    change: { before, after: next.after.length === 0 ? null : next.after, added, removed },
    removals: rememberRemovals(current.supportedModelsRemoved ?? [], kept, removed, context),
  }
}

/** True when the plan changes nothing, so no row is written and no audit row is owed. */
export function isNoop(change: SupportedModelsChange): boolean {
  return change.added.length === 0 && change.removed.length === 0
}

type Next =
  | { readonly ok: true; readonly after: readonly string[] }
  | { readonly ok: false; readonly refusal: SupportedModelsRefusal }

function applyEdit(
  before: readonly string[],
  edit: Extract<SupportedModelsEdit, { kind: "edit" }>,
): Next {
  const removing = new Set(edit.remove)
  const both = unique(edit.add.filter((id) => removing.has(id)))
  if (both.length > 0) return { ok: false, refusal: { kind: "contradictory_edit", models: both } }
  // Existing order first, new ids after it: an edit never reorders what an operator wrote.
  return { ok: true, after: unique([...before.filter((id) => !removing.has(id)), ...edit.add]) }
}

function applyReplace(
  before: readonly string[],
  edit: Extract<SupportedModelsEdit, { kind: "replace" }>,
): Next {
  const after = unique(edit.models ?? [])
  const kept = new Set(after)
  const named = new Set(edit.removing)
  const unnamed = before.filter((id) => !kept.has(id) && !named.has(id))
  if (unnamed.length > 0)
    return { ok: false, refusal: { kind: "unacknowledged_removal", unnamed: unique(unnamed) } }
  return { ok: true, after }
}

/**
 * Prior removals still inside the window and not re-added, plus this write's. Pruned here — the
 * only writer — so the column never grows past one window of edits.
 */
function rememberRemovals(
  prior: readonly SupportedModelRemoval[],
  kept: ReadonlySet<string>,
  removed: readonly string[],
  context: SupportedModelsContext,
): SupportedModelRemoval[] | null {
  const horizon = context.now.getTime() - context.memoryMs
  const removedNow = new Set(removed)
  const carried = prior.filter(
    (entry) =>
      !kept.has(entry.model) &&
      !removedNow.has(entry.model) &&
      Date.parse(entry.removedAt) > horizon,
  )
  const fresh = removed.map((model) => ({
    model,
    removedAt: context.now.toISOString(),
    by: context.by,
  }))
  const all = [...carried, ...fresh]
  return all.length === 0 ? null : all
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)]
}
