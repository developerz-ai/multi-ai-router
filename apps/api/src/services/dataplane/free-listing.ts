import type { ProviderId } from "@multi-ai-router/core"
import { type FreeModelRow, ownsFreeId } from "../models"
import type { CatalogModel } from "./catalog-listing"

/**
 * `GET /v1/free-models`: the models the presenting key can reach **for nothing**, smartest first.
 *
 * A pure projection of the catalog listing, so scope is enforced by the one implementation that
 * already does it and a free list can never name something the key cannot use. It picks nothing: a
 * client walks the order and names each model itself (non-negotiable 4).
 */
export interface FreeModel {
  readonly id: string
  /** Null for a free id the shipped ranking has not judged yet. */
  readonly intelligenceIndex: number | null
  readonly ranked: boolean
  /** In-scope providers that serve this id for nothing. */
  readonly providers: readonly ProviderId[]
  readonly contextTokens: number | null
  readonly maxOutputTokens: number | null
}

/**
 * Free by the id's own spelling, on the two gateways that spell it: what lets a variant that
 * appeared since the last ranking be offered, last, instead of hidden for a week.
 */
const FREE_VARIANT = /:free$/
const VARIANT_PROVIDERS: ReadonlySet<ProviderId> = new Set(["openrouter", "kilo"])

export function freeListing(
  models: readonly CatalogModel[],
  ranking: readonly FreeModelRow[],
): readonly FreeModel[] {
  const placed = models.flatMap((model) => {
    const at = ranking.findIndex((row) =>
      model.offers.some((offer) => ownsFreeId(row, offer.provider, model.id)),
    )
    const row = ranking[at]
    const free = model.offers.filter((offer) =>
      row === undefined
        ? VARIANT_PROVIDERS.has(offer.provider) && FREE_VARIANT.test(model.id)
        : ownsFreeId(row, offer.provider, model.id),
    )
    // One paid source behind the same name and the router may route the request there: not free.
    if (free.length === 0 || free.length < model.offers.length) return []
    return [
      {
        order: row === undefined ? ranking.length : at,
        entry: {
          id: model.id,
          intelligenceIndex: row?.intelligenceIndex ?? null,
          ranked: row !== undefined,
          providers: free.map((offer) => offer.provider),
          contextTokens: smallest(free.map((offer) => offer.contextTokens)),
          maxOutputTokens: smallest(free.map((offer) => offer.maxOutputTokens)),
        },
      },
    ]
  })
  return placed
    .sort((a, b) => a.order - b.order || a.entry.id.localeCompare(b.entry.id))
    .map(({ entry }) => entry)
}

/** The size every free source can take; unknown only when none states one. */
function smallest(sizes: readonly (number | null)[]): number | null {
  const known = sizes.filter((size): size is number => size !== null)
  return known.length === 0 ? null : Math.min(...known)
}
