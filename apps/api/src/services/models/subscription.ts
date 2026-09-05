import {
  CLAUDE_SUBSCRIPTION_ALIASES,
  CLAUDE_SUBSCRIPTION_MODELS,
  type ModelDescriptor,
  type ModelListingSource,
} from "@multi-ai-router/core"
import type { ModelCatalogEntry } from "@multi-ai-router/db"
import type { SdkModelInfo } from "../../providers"
import { lookupContextWindow } from "./windows"

/**
 * A Claude subscription's catalog rows, from whichever voice answered — pure functions, no I/O.
 *
 * Two sources, one shape. The Agent SDK's handshake (`providers/claude-sdk/model-list.ts`) is the
 * live answer and names aliases beside concrete ids, each with what it resolves to today. When that
 * answer is unavailable the shipped table stands in, labelled so a reader can tell the two apart
 * (`listingSource`). Neither states a context window — the SDK's `ModelInfo` has no size field —
 * so every row takes its numbers from the shipped window table, keyed by the **resolved** id: the
 * window of `sonnet` is the window of whatever `sonnet` is today.
 *
 * **Resolution precedence: the live `resolvedModel` wins.** The shipped alias map is what this
 * image believed on the day it was built; the SDK is what the subscription believes now. Only an
 * alias the SDK listed without resolving falls back to the shipped mapping.
 */

/** A live listing, as the SDK stated it. */
export function subscriptionCatalog(live: readonly SdkModelInfo[]): readonly ModelCatalogEntry[] {
  return live.map((model) =>
    row(model.id, model.resolvedModel ?? CLAUDE_SUBSCRIPTION_ALIASES[model.id] ?? null, "live"),
  )
}

/** The fallback: the shipped models plus the shipped alias map, in table order. */
export function shippedSubscriptionCatalog(): readonly ModelCatalogEntry[] {
  return [
    ...CLAUDE_SUBSCRIPTION_MODELS.map((id) => row(id, null, "shipped")),
    ...Object.entries(CLAUDE_SUBSCRIPTION_ALIASES).map(([alias, target]) =>
      row(alias, target, "shipped"),
    ),
  ]
}

/**
 * The same fallback as {@link shippedSubscriptionCatalog}, in the shape the warm store serves — for
 * a subscription the sweep has not reached yet. A freshly connected account must not list nothing
 * for up to an hour when this image already knows what a subscription serves.
 */
export function shippedSubscriptionModels(): readonly ModelDescriptor[] {
  return shippedSubscriptionCatalog().map((entry) => ({
    id: entry.modelId,
    contextTokens: entry.contextTokens,
    maxOutputTokens: entry.maxOutputTokens,
    contextSource: entry.contextSource,
    listingSource: entry.listingSource,
    resolvedModel: entry.resolvedModel,
  }))
}

function row(
  id: string,
  resolvedModel: string | null,
  listingSource: ModelListingSource,
): ModelCatalogEntry {
  const window = lookupContextWindow("anthropic-oauth", resolvedModel ?? id)
  return {
    modelId: id,
    contextTokens: window?.contextTokens ?? null,
    maxOutputTokens: window?.maxOutputTokens ?? null,
    // The numbers are the shipped table's whenever there are numbers at all — the SDK states none.
    contextSource: window === null ? null : "shipped",
    listingSource,
    resolvedModel,
  }
}
