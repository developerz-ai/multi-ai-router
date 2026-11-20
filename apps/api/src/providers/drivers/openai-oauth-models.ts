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
 * `ModelInfo.slug`, `context_window`, `max_context_window`; `default_reasoning_level` and
 * `supported_reasoning_levels: [{effort, description}]` read @ 4360c5f8, 2026-11-20). Blast radius:
 * "Discover models", the hourly catalog sweep for ChatGPT accounts, and the `reasoning` block those
 * rows carry on `/v1/catalog` and `/v1/models`; routing and live requests do not read it.
 */

// `client_version_to_whole()` is the running Codex CLI's `MAJOR.MINOR.PATCH`; the backend gates
// newer models on it (each `ModelInfo` names a `minimal_client_version`; `gpt-6.2-sol` /
// `gpt-6.2-astra` say `0.166.0` in codex-rs/models-manager/models.json, main 2026-11-20), so it
// names a released CLI: `rust-v0.171.0`, the newest stable tag of openai/codex on 2026-11-20 (the
// first release defaulting to `gpt-6.2-sol`). The value feeds this query parameter only: the
// router sends no Codex `version` or user-agent header. A stale value lists fewer models, never an
// error. "Discover models" writes the listing into `supportedModels` (the hourly sweep writes only
// `model_catalog`, which routing never reads), so a model the listing omitted at the last discover
// is refused `model_not_found` before any request leaves. Measured 2026-11-19: the account
// discovered at `0.160.0` held exactly the four gpt-6 slugs of that CLI's bundled models.json, so
// `gpt-6.1-terra` and `gpt-6.2-*` were unreachable. When a model ships: bump this pin, release,
// then re-run "Discover models" on each ChatGPT account that declares `supportedModels`;
// `docs/idea/03-providers.md` names the check.
export const CODEX_CLIENT_VERSION = "0.171.0"

const size = z
  .unknown()
  .transform((value) =>
    typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null,
  )

// `ultra` and `persistent` are Codex UI selections, never wire efforts: codex-rs
// `protocol/src/openai_models/reasoning_effort.rs` `resolve_reasoning_effort` rewrites `ultra` to
// the model's multi-agent effort or its top level and `persistent` to `disabled` before a request
// is sent. Stated as levels, a client that took one would send a word the backend never sees from
// Codex itself.
const CLIENT_SIDE_EFFORTS: ReadonlySet<string> = new Set(["ultra", "persistent"])

const effortWord = z.string().trim().min(1)

// Each a lenient read: a reshaped level block costs the reasoning fact, never the row.
const levels = z
  .array(z.looseObject({ effort: effortWord }))
  .optional()
  .catch(undefined)

// Loose: `ModelInfo` carries dozens of fields this router never reads, and a new one must never
// fail the listing.
const Listing = z.object({
  models: z.array(
    z.looseObject({
      slug: z.string().trim().min(1),
      context_window: size.optional(),
      max_context_window: size.optional(),
      default_reasoning_level: effortWord.optional().catch(undefined),
      supported_reasoning_levels: levels,
    }),
  ),
})

type ListingModel = z.infer<typeof Listing>["models"][number]

/**
 * `supported_reasoning_levels` → the levels a request may name, in the listing's order, with
 * `default_reasoning_level` beside them. No wire level stated is "nobody said", never "does not
 * think": absent, not `supported: false`.
 */
function reasoningOf(model: ListingModel): Pick<ListedModel, "reasoning"> {
  const effort = (model.supported_reasoning_levels ?? [])
    .map((level) => level.effort)
    .filter((word) => !CLIENT_SIDE_EFFORTS.has(word))
  if (effort.length === 0) return {}
  const stated = model.default_reasoning_level
  const fallback =
    stated === undefined || CLIENT_SIDE_EFFORTS.has(stated) ? {} : { default: stated }
  return { reasoning: { supported: true, effort, ...fallback } }
}

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
      ...reasoningOf(model),
    }))
  },
}

/**
 * Names a ChatGPT/Codex account answers to when the Account declares no `supportedModels`. From
 * codex-rs models-manager/models.json slugs plus o3 / o4-mini (openai/codex de3721a7, 2026-10-04).
 * Blast radius: a name outside these is never routed to an undeclared ChatGPT account.
 */
export const CODEX_MODEL_FAMILY: ModelFamily = { patterns: [/^gpt-/, /^codex-/, /^o\d/] }
