/**
 * The IdP's published public keys. JWKS is fetched and the lookup is by `kid`.
 *
 * The cache is an in-memory map keyed by `kid` and a moment-in-time, so a kid we
 * have never seen forces a fetch and a kid we have seen reuses the entry. The
 * JWKS endpoint's own `Cache-Control` header is respected when present, falling
 * back to a conservative one-hour max-age.
 *
 * Key rotation is the case this has to get right: a signed id_token can carry
 * a kid we have not seen before, and the verifier needs to know to fetch and
 * re-try — not the same way it would for a kid we have never heard of.
 *
 * The wire format is a JWK with the fields we use. Anything else we do not
 * touch; an unsupported `kty` is a rejection of that key, not a rejection of
 * the kid.
 */

import { z } from "zod"

/** The dials we actually consume. Other fields are ignored by design. */
const jwkSchema = z.object({
  kty: z.string(),
  /** Must be present on a key we are willing to use. */
  alg: z.string().optional(),
  kid: z.string(),
  use: z.string().optional(),
  // RSA parameters:
  n: z.string().optional(),
  e: z.string().optional(),
  // EC parameters:
  crv: z.string().optional(),
  x: z.string().optional(),
  y: z.string().optional(),
})

const jwksSchema = z.object({
  keys: z.array(jwkSchema),
})

export interface JWK {
  readonly kty: string
  readonly kid: string
  readonly alg?: string
  readonly n?: string
  readonly e?: string
  readonly crv?: string
  readonly x?: string
  readonly y?: string
}

export class OIDCJWKSError extends Error {
  readonly code: "fetch_failed" | "parse_failed" | "not_found"
  constructor(message: string, code: OIDCJWKSError["code"]) {
    super(message)
    this.name = "OIDCJWKSError"
    this.code = code
  }
}

/**
 * The wire shape `crypto.subtle.importKey` wants for an RSA public key. We carry
 * only the fields we need; the `alg` on the key is what the verifier reads from
 * the JWS header.
 */
export interface CryptoKeyHolder {
  readonly kid: string
  readonly alg: string
  readonly key: CryptoKey
}

export interface JWKSCache {
  /** Resolves the key for a kid, fetching JWKS if it is a new one. */
  resolve(headers: { kid?: string; alg?: string }): Promise<CryptoKeyHolder>
  /** Drops every cached key. The next `resolve(...)` will fetch again. */
  invalidate(): void
}

export interface JWKSFetch {
  fetch(url: string): Promise<Response>
}

export function defaultJWKSFetch(): JWKSFetch {
  return {
    async fetch(url) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      try {
        return await fetch(url, { signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/** Accepts a `fetch`-style function so callers can pass the global without a wrapper. */
function asFetch(fetcher: typeof fetch | JWKSFetch): JWKSFetch {
  if (typeof fetcher === "function") {
    return {
      async fetch(url: string) {
        return fetcher(url)
      },
    }
  }
  return fetcher
}

interface CacheEntry {
  key: CryptoKeyHolder
  loadedAtMs: number
  /** `Cache-Control: max-age` seconds, or a conservative default. */
  maxAgeMs: number
}

const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000
const MIN_MAX_AGE_MS = 5 * 60 * 1000 // floor under operator control

function parseMaxAge(header: string | null): number {
  if (header === null) return DEFAULT_MAX_AGE_MS
  const match = /max-age\s*=\s*(\d+)/i.exec(header)
  if (match === null) return DEFAULT_MAX_AGE_MS
  const seconds = Number(match[1])
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_MAX_AGE_MS
  return Math.max(MIN_MAX_AGE_MS, seconds * 1000)
}

export function createJWKSCache(
  jwksUri: string,
  fetcher: typeof fetch | JWKSFetch = defaultJWKSFetch(),
  clock: () => number = () => Date.now(),
): JWKSCache {
  const fetcherNorm = asFetch(fetcher)
  const cache = new Map<string, CacheEntry>()

  async function fetchAndPopulate(): Promise<void> {
    const res = await fetcherNorm.fetch(jwksUri)
    if (!res.ok) {
      throw new OIDCJWKSError(`jwks endpoint returned ${res.status}`, "fetch_failed")
    }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw new OIDCJWKSError("jwks endpoint did not return JSON", "parse_failed")
    }
    const parsed = jwksSchema.safeParse(body)
    if (!parsed.success) throw new OIDCJWKSError("jwks document is malformed", "parse_failed")

    const maxAgeMs = parseMaxAge(res.headers.get("cache-control"))
    const nowMs = clock()
    const imported: CacheEntry[] = []
    for (const jwk of parsed.data.keys) {
      // Only RSA at the moment. EC support is a follow-up; the JWK layer is the
      // seam to add it on without surfacing new errors to the caller.
      if (jwk.kty !== "RSA") continue
      if (jwk.n === undefined || jwk.e === undefined) continue
      const alg = jwk.alg ?? "RS256"
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: jwk.kty, n: jwk.n, e: jwk.e, alg },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      )
      imported.push({ key: { kid: jwk.kid, alg, key }, loadedAtMs: nowMs, maxAgeMs })
    }
    // Replace the cache atomically. Reads after this point see the new set.
    cache.clear()
    for (const entry of imported) cache.set(entry.key.kid, entry)
  }

  /** Returns the entry if it is still fresh according to its own `max-age`. */
  function freshEntry(kid: string, nowMs: number): CacheEntry | null {
    const entry = cache.get(kid)
    if (entry === undefined) return null
    if (nowMs - entry.loadedAtMs >= entry.maxAgeMs) return null
    return entry
  }

  return {
    async resolve(headers): Promise<CryptoKeyHolder> {
      const kid = headers.kid
      if (kid === undefined || kid.length === 0) {
        // A token without a kid is refused; the spec is clear and we have no way
        // to pick a key safely.
        throw new OIDCJWKSError("id_token has no kid header", "not_found")
      }
      const nowMs = clock()
      const hit = freshEntry(kid, nowMs)
      if (hit !== null) return hit.key

      // Either the kid is unknown or its entry is stale. Either way, fetch.
      await fetchAndPopulate()
      const entry = cache.get(kid)
      if (entry === undefined) {
        throw new OIDCJWKSError(`no key for kid "${kid}" in jwks`, "not_found")
      }
      return entry.key
    },
    invalidate(): void {
      cache.clear()
    },
  }
}
