/**
 * Model resolution for one account: the client's model name mapped through the account's alias
 * map, then checked against the models the account declares.
 *
 * The client picks the model; the router only renames it where an operator said so. An account
 * with **no** declared model set supports everything — unknown means passthrough, not exclusion.
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
