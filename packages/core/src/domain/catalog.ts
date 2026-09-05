import { z } from "zod"

/**
 * What the router knows about a **model**, as opposed to about an Account or a request.
 *
 * The vocabulary is small on purpose. A model's context window and output ceiling are the two
 * numbers a client actually needs before it can decide what to send, and they are the two this
 * router can state without inventing anything: either the upstream said them or a pinned table
 * did. Everything else an aggregator publishes — modality, tokenizer, moderation flags — this
 * router has no way to verify, so it does not claim it.
 */

/**
 * Where a context window came from, carried on every row and rendered wherever the number is.
 *
 * The two differ in exactly the way a reader cares about. `upstream` was in the provider's own
 * listing for this account's endpoint, so it is current and specific. `shipped` came from the
 * table this image was built with, because the provider's listing carries no such field at all —
 * verified empirically: z.ai, MiniMax, OpenAI and Anthropic all answer `/v1/models` with nothing
 * but an id, an object type and an owner.
 *
 * A shipped number is a real published figure, not a guess, but it ages with the image and cannot
 * know about a model released after it. Collapsing the two into one unlabelled integer would let a
 * stale constant read exactly like a live reading, which is the failure this label exists to make
 * impossible — the same reason `ResetSource` rides beside every reset instant.
 */
export const ModelContextSource = z.enum(["upstream", "shipped"])
export type ModelContextSource = z.infer<typeof ModelContextSource>

/**
 * Where the **row itself** came from — which voice said "this model exists here". Distinct from
 * {@link ModelContextSource}, which labels only the two numbers beside it: a live SDK listing that
 * states no size still takes its window from the shipped table, so one row legitimately reads
 * `listingSource: "live"` with `contextSource: "shipped"`.
 *
 * - `upstream` — the provider's own HTTP model listing, read by the hourly sweep.
 * - `live` — the Claude Agent SDK's `system/init` handshake for one subscription's own
 *   `CLAUDE_CONFIG_DIR`: what that subscription can actually be asked for today, aliases included.
 * - `shipped` — {@link CLAUDE_SUBSCRIPTION_MODELS}, the fallback for a subscription whose live read
 *   was unavailable. A real published list, but one that ages with the image.
 */
export const ModelListingSource = z.enum(["upstream", "live", "shipped"])
export type ModelListingSource = z.infer<typeof ModelListingSource>

/**
 * One model as this router can describe it. Every field beyond the id is nullable, and null means
 * **unknown** rather than zero or unlimited — a client that reads a missing context window as "no
 * limit" would build a request the upstream rejects, so the absence has to be visible.
 */
export interface ModelDescriptor {
  /** Upstream-side id, exactly as the provider names it. */
  readonly id: string
  /** Total prompt+completion window, in tokens. Null when nothing states it. */
  readonly contextTokens: number | null
  /** Largest completion the model will produce, in tokens. Null when nothing states it. */
  readonly maxOutputTokens: number | null
  /** Absent whenever both numbers are null: a source with nothing to source is noise. */
  readonly contextSource: ModelContextSource | null
  /** Which voice listed this row — see {@link ModelListingSource}. */
  readonly listingSource: ModelListingSource
  /**
   * For an alias row (`sonnet`, `opus`, `fable`, `haiku`), the canonical id it resolves to today.
   * Information only: the client's model string is still what goes upstream, unchanged.
   */
  readonly resolvedModel: string | null
}

/**
 * A context-window table row, as the shipped tables under `services/catalog/windows/` state it.
 *
 * `maxOutputTokens` is optional because several vendors publish a context length and no output
 * ceiling at all (Mistral and xAI, at the time of writing), and restating a ceiling nobody
 * published would be the invention this module refuses.
 */
export interface ContextWindow {
  readonly contextTokens: number
  readonly maxOutputTokens?: number
}

/** A vendor table: normalized model name -> its window. Mirrors `cost/rates.ts`'s `ModelTable`. */
export type ContextTable = Readonly<Record<string, ContextWindow>>

/**
 * The models a Claude subscription serves when the Agent SDK cannot be asked — the fallback behind
 * a `listingSource: "shipped"` row. A subscription has no HTTP listing to GET and no discover
 * button; the SDK's `system/init` handshake is its only live voice, and when that voice is
 * unavailable (no `claude` binary, `needs_reauth`, a timeout) this is what `GET /v1/models` says
 * rather than `data: []`.
 *
 * Provenance: the published model reference on the date `CONTEXT_TABLE_AS_OF` names. Context
 * windows live in the shipped table under `services/models/windows/`, keyed by these same ids.
 * Blast radius of a stale row: a model listed that the subscription no longer serves, or one
 * missing that it does — until the next live read replaces the set. Nothing routes on it.
 */
export const CLAUDE_SUBSCRIPTION_MODELS: readonly string[] = Object.freeze([
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
])

/**
 * The family aliases the `claude` CLI accepts, each resolving to the **latest** of its family as
 * of the same date. A live listing's own `resolvedModel` wins over this map whenever it states
 * one; this is only what the shipped fallback claims.
 */
export const CLAUDE_SUBSCRIPTION_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  fable: "claude-fable-5-1",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
})
