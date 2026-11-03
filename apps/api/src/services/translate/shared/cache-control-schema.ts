import { z } from "zod"

/**
 * A prompt-cache breakpoint as either side of a translation reads it: Anthropic's own field, and
 * OpenRouter's copy of it on an openai-chat content part. Lenient: before it was read it was
 * stripped, so a marker this build does not recognize parses as absent, never as a `400`.
 */
export const cacheControlSchema = z
  .object({ type: z.literal("ephemeral"), ttl: z.string().optional() })
  .optional()
  .catch(undefined)

export interface CacheControl {
  readonly type: "ephemeral"
  readonly ttl?: string | undefined
}

/** Anthropic's automatic caching: one top-level marker the upstream moves forward each turn. */
export const AUTOMATIC_CACHE: CacheControl = { type: "ephemeral" }

/** Spread into an emitted block or part: the marker when there is one, else nothing at all. */
export function marked(control: CacheControl | undefined): {
  readonly cache_control?: CacheControl
} {
  return control === undefined ? {} : { cache_control: control }
}

/** The last marker on a run of parsed parts — one part on the other side gets one breakpoint. */
export function lastMarker(
  parts: readonly object[] | string | null | undefined,
): CacheControl | undefined {
  if (typeof parts !== "object" || parts === null) return undefined
  for (const part of parts.toReversed()) {
    const control =
      "cache_control" in part ? (part.cache_control as CacheControl | undefined) : undefined
    if (control !== undefined) return control
  }
  return undefined
}
