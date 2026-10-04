import { z } from "zod"
import type { ModelFamily } from "../../services/routing/model-family"
import type { ListedModel, ProviderModelListing } from "../model-listing"

/**
 * The ChatGPT/Codex model listing — `GET {codex base}/models?client_version=…`, answering
 * `{models: [{slug, context_window, …}]}` rather than the stock `{data: [{id}]}`. Without
 * `client_version` the backend answers `400` (production, 2026-10-04: `http-status:400`).
 *
 * Provenance: openai/codex @ de3721a7be07054c8c2a41102b5a501f34155361 —
 * `codex-rs/codex-api/src/endpoint/models.rs` (`path()` = `models`, `append_client_version_query`),
 * `codex-rs/model-provider/src/models_endpoint.rs` (`list_models`, `request_url`), and
 * `codex-rs/protocol/src/openai_models.rs` (`ModelsResponse { models: Vec<ModelInfo> }`,
 * `ModelInfo.slug`, `context_window`, `max_context_window`). Blast radius: "Discover models" and
 * the hourly catalog sweep for ChatGPT accounts; routing and live requests do not read it.
 */

// `client_version_to_whole()` is the running Codex CLI's `MAJOR.MINOR.PATCH`; the backend may gate
// newer models on it, so it names a released CLI. The newest `rust-v*` tag of openai/codex on
// 2026-10-04. A stale value lists fewer models, never an error; bump it with the other pins.
export const CODEX_CLIENT_VERSION = "0.160.0"

const size = z
  .unknown()
  .transform((value) =>
    typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null,
  )

// Loose: `ModelInfo` carries dozens of fields this router never reads, and a new one must never
// fail the listing.
const Listing = z.object({
  models: z.array(
    z.looseObject({
      slug: z.string().trim().min(1),
      context_window: size.optional(),
      max_context_window: size.optional(),
    }),
  ),
})

export const codexModelListing: ProviderModelListing = {
  query: () => ({ client_version: CODEX_CLIENT_VERSION }),
  read: (body): readonly ListedModel[] | null => {
    const parsed = Listing.safeParse(body)
    if (!parsed.success) return null
    return parsed.data.models.map((model) => ({
      id: model.slug,
      // The default window is what a request gets; the max is an opt-in larger tier.
      contextTokens: model.context_window ?? model.max_context_window ?? null,
      maxOutputTokens: null,
    }))
  },
}

/**
 * Names a ChatGPT/Codex account answers to when the Account declares no `supportedModels`. From
 * codex-rs models-manager/models.json slugs plus o3 / o4-mini (openai/codex de3721a7, 2026-10-04).
 * Blast radius: a name outside these is never routed to an undeclared ChatGPT account.
 */
export const CODEX_MODEL_FAMILY: ModelFamily = { patterns: [/^gpt-/, /^codex-/, /^o\d/] }
