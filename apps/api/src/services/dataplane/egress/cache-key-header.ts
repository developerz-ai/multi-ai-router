import { createHash } from "node:crypto"
import type { SessionKeySource } from "../body/session"

/**
 * The prompt-cache affinity header a surface reads (`ResponsesEgressRules.cacheKeyHeader`), and the
 * value this attempt sends under it. Pure: the caller hands in what it already holds.
 *
 * - **Translated**: the key the body carries — the caller's own `prompt_cache_key`, else the
 *   router's session key for the conversation ({@link sessionCacheKey}).
 * - **Byte relay**: the client's own header of that name, forwarded. The trust-boundary allowlist
 *   (`egress/headers.ts`) strips every client header it does not name, and this one is not a
 *   credential: only a surface that declares it ever receives it.
 *
 * A value no header can carry (a control character) is not sent; the body still carries the key.
 */

export type CacheKeySource =
  | { readonly kind: "translated"; readonly key: string | undefined }
  | { readonly kind: "relay"; readonly client: Headers }

/**
 * The `prompt_cache_key` a translated request to a cache-keyed surface carries when the caller
 * states none — every Anthropic-ingress request, since that dialect has no such field.
 *
 * Derived from the session key `body/session.ts` resolved, so it is exactly as stable as sticky
 * routing: one value across a conversation's turns, a different one per conversation. A client
 * session header (`x-session-id`) names the conversation outright; without one the key is the
 * fingerprint of the opening, which two concurrent conversations with one opening share — and so
 * share one cache key, as they already share one account. An **unbound** key is fresh per request
 * and would only defeat affinity, so none is sent. Hashed with the router key id: the upstream sees
 * no client value and no internal key, and two router keys never share a cache key.
 */
export function sessionCacheKey(
  apiKeyId: string,
  sessionKey: string,
  source: SessionKeySource,
): string | undefined {
  if (source === "unbound") return undefined
  const hex = createHash("sha256").update(`${apiKeyId}\0${sessionKey}`, "utf8").digest("hex")
  // UUID-shaped, the form the Codex CLI's own conversation ids take.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** The caller's key when it states one, else the router's. Empty or blank states none. */
export function effectiveCacheKey(
  caller: unknown,
  fallback: string | undefined,
): string | undefined {
  return typeof caller === "string" && caller.trim().length > 0 ? caller : fallback
}

/** Visible ASCII and space: what `Headers.set` accepts without throwing and an upstream parses. */
const HEADER_VALUE = /^[\x20-\x7e]+$/

export function cacheKeyHeader(
  name: string | undefined,
  source: CacheKeySource,
): readonly [string, string] | undefined {
  if (name === undefined) return undefined
  const value = (source.kind === "translated" ? source.key : source.client.get(name))?.trim()
  if (value === undefined || value.length === 0 || !HEADER_VALUE.test(value)) return undefined
  return [name, value]
}
