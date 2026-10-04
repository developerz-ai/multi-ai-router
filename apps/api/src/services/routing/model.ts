/**
 * Model resolution for one account: the client's model name mapped through the account's alias
 * map, then checked against the models the account declares.
 *
 * The client picks the model; the router only renames it where an operator said so. An account
 * with **no** declared model set falls back to its provider's model family (`model-family.ts`) —
 * a subscription serves only its vendor's names — and, for a provider that declares none, supports
 * everything: unknown means passthrough, not exclusion.
 *
 * **Two sides of one map, and the difference matters.** `supportedModels` is stated
 * **upstream-side** — the names the provider itself answers to, which is the side an alias map
 * points *at* and the side a provider's own `/v1/models` listing returns. `modelAliases` keys are
 * **requested-side** — what a client sends. {@link resolveModel} therefore maps first and checks
 * second, and {@link advertisedModels} exists so the catalog `GET /v1/models` publishes is the
 * requested-side inverse of that same check rather than a second, hand-kept opinion of it.
 *
 * **Context tags.** Claude Code appends a context-window tag (`[1m]`, `context-tag.ts`) to the model
 * name it sends. On an account whose provider does not declare `understandsContextTags`, a tagged
 * name the operator did not alias or list explicitly resolves as its base name, and the base name
 * is what goes upstream. Same model, hint dropped — not a substitution (non-negotiable 4).
 */

import { ownEntry } from "@multi-ai-router/core"
import { splitContextTag } from "./context-tag"
import { inModelFamily } from "./model-family"
import type { AccountSnapshot } from "./types"

export interface ModelResolution {
  /** The name to send upstream. Equal to the requested name unless an alias renamed it. */
  readonly upstreamModel: string
  /** True when the account's declared model set admits it (or declares nothing at all). */
  readonly supported: boolean
  /** True when an alias map entry renamed it. Recorded so a surprise rename is debuggable. */
  readonly aliased: boolean
  /**
   * The context tag removed from the requested name (`1m`), present only when it was. Like
   * {@link aliased}, recorded so the rename is debuggable; the usage row carries both names.
   */
  readonly strippedContextTag?: string
}

export function resolveModel(account: AccountSnapshot, requestedModel: string): ModelResolution {
  const exact = resolveExact(account, requestedModel)
  if (exact.aliased || account.understandsContextTags === true) return exact
  const tagged = splitContextTag(requestedModel)
  // An operator who listed the tagged spelling itself said this upstream answers to it.
  if (tagged === null || account.supportedModels?.includes(requestedModel) === true) return exact
  return { ...resolveExact(account, tagged.base), strippedContextTag: tagged.tag }
}

function resolveExact(account: AccountSnapshot, requestedModel: string): ModelResolution {
  const entry = ownEntry(account.modelAliases, requestedModel)
  const alias = typeof entry === "string" ? entry : undefined
  const upstreamModel = alias ?? requestedModel
  return { upstreamModel, supported: serves(account, upstreamModel), aliased: alias !== undefined }
}

/**
 * The operator's explicit list wins; with none, the provider's family decides; with neither, the
 * account is a passthrough. Checked upstream-side, after the alias map, on every branch.
 */
function serves(account: AccountSnapshot, upstreamModel: string): boolean {
  const declared = account.supportedModels
  if (declared !== undefined && declared.length > 0) return declared.includes(upstreamModel)
  if (account.modelFamily !== undefined) return inModelFamily(account.modelFamily, upstreamModel)
  return true
}

/**
 * Every model name a client may **send** this account, derived from the same check that decides
 * whether a request for one is served. This is what `GET /v1/models` enumerates.
 *
 * Defined as a filter over {@link resolveModel} rather than as a union of the two fields, and
 * deliberately so: the two disagree in both directions, and each disagreement is a real bug.
 *
 * - An alias whose *target* is not declared (`sonnet` -> `glm-4.7` on an account that serves only
 *   `glm-4.6`) would be advertised by a naive union and then filtered out as `model-unsupported`
 *   at selection — a listing that promises a 503.
 * - A declared name whose own alias entry points somewhere unserved (`glm-4.7` declared, and
 *   `glm-4.7` -> `retired-model` mapped) is not requestable under that name either, because the
 *   alias renames it on the way out.
 *
 * Writing it as `names.filter(supported)` makes both cases fall out of the one rule, and makes it
 * impossible for the listing and the router to drift as either side grows.
 *
 * An account declaring nothing is a passthrough: it serves any name, and therefore enumerates
 * only the alias keys an operator wrote down. A router of only such accounts lists nothing rather
 * than inventing a catalog it cannot stand behind.
 */
export function advertisedModels(account: AccountSnapshot): readonly string[] {
  const names = new Set([
    ...(account.supportedModels ?? []),
    ...Object.keys(account.modelAliases ?? {}),
  ])
  return [...names].filter((name) => resolveModel(account, name).supported)
}
