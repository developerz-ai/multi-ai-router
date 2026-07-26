/**
 * Model resolution for one account: the client's model name mapped through the account's alias
 * map, then checked against the models the account declares.
 *
 * The client picks the model; the router only renames it where an operator said so. An account
 * with **no** declared model set supports everything — unknown means passthrough, not exclusion.
 *
 * **Two sides of one map, and the difference matters.** `supportedModels` is stated
 * **upstream-side** — the names the provider itself answers to, which is the side an alias map
 * points *at* and the side a provider's own `/v1/models` listing returns. `modelAliases` keys are
 * **requested-side** — what a client sends. {@link resolveModel} therefore maps first and checks
 * second, and {@link advertisedModels} exists so the catalog `GET /v1/models` publishes is the
 * requested-side inverse of that same check rather than a second, hand-kept opinion of it.
 */

import type { AccountSnapshot } from "./types"

export interface ModelResolution {
  /** The name to send upstream. Equal to the requested name unless an alias renamed it. */
  readonly upstreamModel: string
  /** True when the account's declared model set admits it (or declares nothing at all). */
  readonly supported: boolean
  /** True when an alias map entry renamed it. Recorded so a surprise rename is debuggable. */
  readonly aliased: boolean
}

export function resolveModel(account: AccountSnapshot, requestedModel: string): ModelResolution {
  const alias = account.modelAliases?.[requestedModel]
  const upstreamModel = alias ?? requestedModel
  const declared = account.supportedModels

  if (declared === undefined || declared.length === 0) {
    return { upstreamModel, supported: true, aliased: alias !== undefined }
  }

  return {
    upstreamModel,
    supported: declared.includes(upstreamModel),
    aliased: alias !== undefined,
  }
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
