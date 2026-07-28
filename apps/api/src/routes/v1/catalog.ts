import type { Context } from "hono"
import type { RouterKeyEnv } from "../../middleware/routerKeyAuth"
import type { CatalogModel, CatalogProvider } from "../../services/dataplane"
import { CONTEXT_TABLE_AS_OF } from "../../services/models"

/**
 * `GET /v1/catalog` and `GET /v1/providers` — this router's **own** listings.
 *
 * Shaped after OpenRouter's models endpoint in what it answers, not byte-for-byte in how it spells
 * it, and the difference is deliberate rather than laziness. Copying that shape exactly would mean
 * publishing `pricing.prompt` as a per-*token* decimal string, a `top_provider` block naming an
 * upstream this router chooses per request, and `architecture` fields nothing here can verify —
 * a listing that looks like an aggregator's while being unable to stand behind half of it. So:
 * per-million-token numbers, the unit every price in this system already uses; a provider *list*
 * rather than a winner, because pooling is the product and the depth behind a name is the useful
 * fact; and no field this router cannot source.
 *
 * `null` means **unknown** in every numeric field here, never zero and never unlimited. A client
 * that read a missing context window as "no limit" would build a request its upstream rejects.
 *
 * Neither path is a passthrough surface, so neither has a dialect to answer in — unlike
 * `GET /v1/models`, which serves two ecosystems and picks its shape from the credential style. This
 * is one shape for one router.
 */

interface CatalogBody {
  readonly object: "catalog"
  readonly data: readonly CatalogEntry[]
  /**
   * When the shipped context table was last checked against its vendors. A window labelled
   * `shipped` is only as current as this date, and a listing that could not age visibly is one a
   * reader has no way to judge.
   */
  readonly context_table_as_of: string
}

interface CatalogEntry {
  readonly id: string
  readonly providers: readonly string[]
  /** In-scope accounts serving this model — the pooling depth behind the name. */
  readonly accounts: number
  readonly context_length: number | null
  readonly max_output_tokens: number | null
  /** `upstream` (the provider's own listing) or `shipped` (this image's table). Null with no size. */
  readonly context_source: string | null
  readonly pricing: PricingBody | null
}

/** US dollars per million tokens. The unit every price in this system is stated in. */
interface PricingBody {
  readonly currency: "USD"
  readonly input_per_mtok: number
  readonly output_per_mtok: number
  readonly cache_read_per_mtok: number
  readonly cache_write_per_mtok: number
}

export function renderCatalog(c: Context<RouterKeyEnv>, models: readonly CatalogModel[]): Response {
  const body: CatalogBody = {
    object: "catalog",
    data: models.map(toEntry),
    context_table_as_of: CONTEXT_TABLE_AS_OF,
  }
  return c.json(body)
}

export function renderProviders(
  c: Context<RouterKeyEnv>,
  providers: readonly CatalogProvider[],
): Response {
  return c.json({
    object: "list",
    data: providers.map((provider) => ({
      id: provider.id,
      accounts: provider.accounts,
      available: provider.available,
    })),
  })
}

function toEntry(model: CatalogModel): CatalogEntry {
  return {
    id: model.id,
    providers: model.providers,
    accounts: model.accounts,
    context_length: model.contextTokens,
    max_output_tokens: model.maxOutputTokens,
    context_source: model.contextSource,
    pricing:
      model.pricing === null
        ? null
        : {
            currency: "USD",
            input_per_mtok: model.pricing.inputPerMtok,
            output_per_mtok: model.pricing.outputPerMtok,
            cache_read_per_mtok: model.pricing.cacheReadPerMtok,
            cache_write_per_mtok: model.pricing.cacheWritePerMtok,
          },
  }
}
