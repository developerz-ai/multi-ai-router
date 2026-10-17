/**
 * The prompt-cache affinity header a surface reads (`ResponsesEgressRules.cacheKeyHeader`), and the
 * value this attempt sends under it. Pure: the caller hands in what it already holds.
 *
 * - **Translated**: the caller's own `prompt_cache_key`, the value the body carries too. No key, no
 *   header — a router-minted value would merge or split conversations the caller drew.
 * - **Byte relay**: the client's own header of that name, forwarded. The trust-boundary allowlist
 *   (`egress/headers.ts`) strips every client header it does not name, and this one is not a
 *   credential: only a surface that declares it ever receives it.
 *
 * A value no header can carry (a control character) is not sent; the body still carries the key.
 */

export type CacheKeySource =
  | { readonly kind: "translated"; readonly key: string | undefined }
  | { readonly kind: "relay"; readonly client: Headers }

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
