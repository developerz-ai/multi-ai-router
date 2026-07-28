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
