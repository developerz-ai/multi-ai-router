/**
 * Claude Code's context-window tag: a bracketed suffix on a model name (`opus[1m]`,
 * `claude-opus-5-5[1m]`, and — because Claude Code appends it to whatever its default model is —
 * `gpt-6.1-sol[1m]`). It is a client-side hint about the context window, not part of the model's
 * identity: the `claude` CLI reads it and turns it into a request option, and every other upstream
 * answers the tagged name as an unknown model.
 *
 * Provenance: the `claude` CLI's alias table (2.1.286) spells the tag `[1m]`; the grammar here is
 * the general shape of that suffix — one bracketed alphanumeric token, at the very end, after a
 * non-empty name — so a future `[2m]` is recognized without a release. Blast radius: a model whose
 * real upstream id ends in a bracketed token would have it read as a tag on a provider that does
 * not understand tags, unless an Account lists or aliases the tagged name explicitly.
 */
const CONTEXT_TAG = /^(.+?)\[([a-z0-9]+)\]$/i

export interface ContextTagged {
  /** The model name with the tag removed. */
  readonly base: string
  /** The tag's content, without brackets (`1m`). */
  readonly tag: string
}

/** The name split at its trailing context tag, or `null` when it carries none. */
export function splitContextTag(model: string): ContextTagged | null {
  const match = CONTEXT_TAG.exec(model)
  const base = match?.[1]
  const tag = match?.[2]
  return base === undefined || tag === undefined ? null : { base, tag }
}
