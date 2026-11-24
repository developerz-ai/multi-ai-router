import { z } from "zod"
import type { ListedModel, ProviderModelListing } from "../model-listing"

/**
 * Gemini's model listing on the OpenAI-compatibility surface. Sibling of `gemini.ts`.
 *
 * Provenance: prod 2026-11-23/24, the stock `GET …/models?limit=1000` answered `400` on every sweep,
 * with keys that served inference: Google refuses a query parameter it does not declare. Ids are
 * listed under their resource name (`models/gemini-2.5-flash`) while a request and an alias map name
 * the bare one, so the prefix is dropped. The surface states no sizes. Blast radius: the catalog sweep
 * and Discover for `gemini`; routing and live requests do not read it.
 */
const RESOURCE_PREFIX = /^models\//

const Listing = z.object({ data: z.array(z.looseObject({ id: z.string().trim().min(1) })) })

export const geminiModelListing: ProviderModelListing = {
  query: () => ({}),
  read: (body): readonly ListedModel[] | null => {
    const parsed = Listing.safeParse(body)
    if (!parsed.success) return null
    return parsed.data.data.map((model) => ({
      id: model.id.replace(RESOURCE_PREFIX, ""),
      contextTokens: null,
      maxOutputTokens: null,
    }))
  },
}
