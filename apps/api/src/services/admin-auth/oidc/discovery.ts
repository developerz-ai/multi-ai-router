/**
 * `/.well-known/openid-configuration` — the document the IdP publishes so verification
 * never needs a hardcoded endpoint per provider.
 *
 * The cache is in-memory and process-local: a reload picks up the new keys lazily on
 * the first verify after the cache is invalidated, and one replica's stale doc is
 * a stale doc for one request — no coordination needed.
 *
 * Errors here are reason-coded: a fetch that fails and a parse that fails are
 * different problems and the rest of the stack should be able to tell them apart
 * if it wants to log differently. The route that uses this module collapses them
 * into the single "could not verify" wording the endpoint is documented to
 * render.
 */

import { z } from "zod"

/** What the spec says this endpoint returns. All fields are required by RFC. */
export const discoverySchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
  /** `openid` must be present. The rest are fine to omit. */
  response_types_supported: z.array(z.string()).optional(),
  /** PKCE is mandatory for the public client we run. */
  code_challenge_methods_supported: z.array(z.string()).optional(),
  /** Scopes the IdP will hand out. We use `openid`; the rest are optional. */
  scopes_supported: z.array(z.string()).optional(),
  /** Algorithms, mostly a hint to the JWKS layer. */
  id_token_signing_alg_values_supported: z.array(z.string()).optional(),
})

export type DiscoveryDocument = z.infer<typeof discoverySchema>

/** Distinct outcomes, so a caller can say *why* the IdP's document is unusable. */
export class OIDCDiscoveryError extends Error {
  readonly code: "fetch_failed" | "parse_failed" | "validation_failed" | "unsupported"
  constructor(message: string, code: OIDCDiscoveryError["code"]) {
    super(message)
    this.name = "OIDCDiscoveryError"
    this.code = code
  }
}

export interface DiscoveryService {
  /** Force-fetches on miss, returns cached on hit. Throws {@link OIDCDiscoveryError} on failure. */
  load(): Promise<DiscoveryDocument>
  /** Drops the cached doc. The next `load()` will fetch again. */
  invalidate(): void
}

/** Injects the network so the unit tests can stub it. */
export interface DiscoveryFetch {
  fetch(url: string): Promise<Response>
}

/** A reasonable default: a fetch with a sensible timeout and only the headers we need. */
export function defaultDiscoveryFetch(): DiscoveryFetch {
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
function asFetch(fetcher: typeof fetch | DiscoveryFetch): DiscoveryFetch {
  if (typeof fetcher === "function") {
    return {
      async fetch(url: string) {
        return fetcher(url)
      },
    }
  }
  return fetcher
}

export function createDiscoveryService(
  issuerUrl: string,
  fetcher: typeof fetch | DiscoveryFetch = defaultDiscoveryFetch(),
  clock: () => number = () => Date.now(),
): DiscoveryService {
  const fetcherNorm = asFetch(fetcher)
  /** Normalize: drop any trailing slash. The spec is permissive; we are not. */
  const issuer = issuerUrl.replace(/\/+$/u, "")
  const url = `${issuer}/.well-known/openid-configuration`

  let cached: { doc: DiscoveryDocument; fetchedAtMs: number } | null = null

  return {
    async load(): Promise<DiscoveryDocument> {
      if (cached !== null) return cached.doc

      const res = await fetcherNorm.fetch(url)
      if (!res.ok) {
        throw new OIDCDiscoveryError(
          `discovery endpoint returned ${res.status} for ${url}`,
          "fetch_failed",
        )
      }
      let body: unknown
      try {
        body = await res.json()
      } catch {
        throw new OIDCDiscoveryError("discovery endpoint did not return JSON", "parse_failed")
      }
      const parsed = discoverySchema.safeParse(body)
      if (!parsed.success) {
        throw new OIDCDiscoveryError(
          "discovery document is missing required fields",
          "validation_failed",
        )
      }
      // Verify the issuer is exactly the one we asked for. RFC 8414 says it must match.
      if (parsed.data.issuer.replace(/\/+$/u, "") !== issuer) {
        throw new OIDCDiscoveryError(
          `discovery document issuer "${parsed.data.issuer}" does not match configured issuer`,
          "validation_failed",
        )
      }
      // PKCE is mandatory for the public client we run.
      if (
        !parsed.data.code_challenge_methods_supported?.includes("S256") &&
        !parsed.data.code_challenge_methods_supported?.includes("s256")
      ) {
        throw new OIDCDiscoveryError(
          "discovery document does not advertise PKCE S256 support",
          "unsupported",
        )
      }
      cached = { doc: parsed.data, fetchedAtMs: clock() }
      return parsed.data
    },
    invalidate(): void {
      cached = null
    },
  }
}
