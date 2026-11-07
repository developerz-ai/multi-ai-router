import { ModelReasoning } from "@multi-ai-router/core"
import { z } from "zod"
import type { ListedModel, ProviderModelListing } from "../model-listing"

const size = z
  .unknown()
  .transform((value) =>
    typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null,
  )

// Loose: a catalog row carries dozens of fields this router never reads, and a new one must never
// fail the listing. `capabilities.reasoning` is shaped `{supported, toggle?, effort?}`; a reshaped
// block costs that one fact, not the row. Provenance: `GET /openai/v1/models`, read live 2026-11-06.
const Listing = z.object({
  data: z.array(
    z.looseObject({
      id: z.string().trim().min(1),
      api: z.record(z.string(), z.unknown()).optional().catch(undefined),
      limit: z.looseObject({ context: size.optional(), output: size.optional() }).optional(),
      capabilities: z
        .looseObject({ reasoning: ModelReasoning.optional().catch(undefined) })
        .optional()
        .catch(undefined),
    }),
  ),
})

/** The sizes sit under `limit` and thinking under `capabilities`; the stock reader knows neither. */
function listing(api?: string): ProviderModelListing {
  return {
    // Whatever surface the seat serves on: only the OpenAI listing states sizes and thinking modes.
    dialect: "openai-chat",
    query: () => ({}),
    read: (body): readonly ListedModel[] | null => {
      const parsed = Listing.safeParse(body)
      if (!parsed.success) return null
      return parsed.data.data
        .filter((model) => api === undefined || Object.hasOwn(model.api ?? {}, api))
        .map((model) => ({
          id: model.id,
          contextTokens: model.limit?.context ?? null,
          maxOutputTokens: model.limit?.output ?? null,
          ...(model.capabilities?.reasoning === undefined
            ? {}
            : { reasoning: model.capabilities.reasoning }),
        }))
    },
  }
}

export const opencodeModelListing = listing()
// Console advertises native Messages/Responses/GenAI models too; a chat account must not list them.
export const opencodeChatModelListing = listing("chat-completions")
