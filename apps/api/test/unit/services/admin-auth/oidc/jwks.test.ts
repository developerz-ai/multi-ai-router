import { describe, expect, test } from "bun:test"
import { createJWKSCache, OIDCJWKSError } from "../../../../../src/services/admin-auth/oidc/jwks"

/**
 * JWKS — resolve by `kid`, rotate, expired cache. The cache is a `Map`
 * keyed by `kid`, and the interesting bit is rotation: a fresh kid forces
 * a fetch and the two keys coexist.
 */

/** A real RSA key the WebCrypto API can import. Generated once per test. */
async function makeJwkPair(kid: string) {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey)
  return {
    publicJwk: { ...publicJwk, kid, alg: "RS256", use: "sig" },
    privateKey: keyPair.privateKey,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "max-age=3600" },
  })
}

describe("createJWKSCache", () => {
  test("resolves a key by kid after fetching JWKS", async () => {
    const { publicJwk } = await makeJwkPair("kid-1")
    let calls = 0
    const cache = createJWKSCache("https://sso.test/jwks", {
      fetch: async () => {
        calls += 1
        return jsonResponse({ keys: [publicJwk] })
      },
    })

    const holder = await cache.resolve({ kid: "kid-1", alg: "RS256" })

    expect(holder.kid).toBe("kid-1")
    expect(holder.alg).toBe("RS256")
    expect(calls).toBe(1)
  })

  test("does not re-fetch when the kid is still cached", async () => {
    const { publicJwk } = await makeJwkPair("kid-1")
    let calls = 0
    const cache = createJWKSCache("https://sso.test/jwks", {
      fetch: async () => {
        calls += 1
        return jsonResponse({ keys: [publicJwk] })
      },
    })

    await cache.resolve({ kid: "kid-1", alg: "RS256" })
    await cache.resolve({ kid: "kid-1", alg: "RS256" })
    await cache.resolve({ kid: "kid-1", alg: "RS256" })

    expect(calls).toBe(1)
  })

  test("rotates: a new kid forces a refetch and the cache holds both keys", async () => {
    const first = await makeJwkPair("kid-1")
    const second = await makeJwkPair("kid-2")
    // The fetch responds to one call with one kid, the next with both.
    let calls = 0
    const cache = createJWKSCache("https://sso.test/jwks", {
      fetch: async () => {
        calls += 1
        // First call: only kid-1. Second call: both. The cache replaces the
        // map on each fetch — that is what rotation is here.
        return jsonResponse({ keys: calls === 1 ? [first.publicJwk] : [second.publicJwk] })
      },
    })

    await cache.resolve({ kid: "kid-1", alg: "RS256" })
    // kid-2 is unseen — refetch.
    const holder = await cache.resolve({ kid: "kid-2", alg: "RS256" })

    expect(holder.kid).toBe("kid-2")
    expect(calls).toBe(2)
  })

  test("refetches when the cache is stale per its own max-age", async () => {
    const { publicJwk } = await makeJwkPair("kid-1")
    let calls = 0
    let now = 0
    const cache = createJWKSCache(
      "https://sso.test/jwks",
      {
        fetch: async () => {
          calls += 1
          return jsonResponse({ keys: [publicJwk] })
        },
      },
      () => now,
    )

    now = 0
    await cache.resolve({ kid: "kid-1", alg: "RS256" })
    // Cache-Control said 3600s = 3_600_000ms. Advance past it.
    now = 4_000_000
    await cache.resolve({ kid: "kid-1", alg: "RS256" })

    expect(calls).toBe(2)
  })

  test("fails with not_found when the kid is not in JWKS after a fetch", async () => {
    const { publicJwk } = await makeJwkPair("kid-1")
    const cache = createJWKSCache("https://sso.test/jwks", {
      fetch: async () => jsonResponse({ keys: [publicJwk] }),
    })

    try {
      await cache.resolve({ kid: "kid-unknown", alg: "RS256" })
      throw new Error("expected not_found")
    } catch (err) {
      expect(err).toBeInstanceOf(OIDCJWKSError)
      expect((err as OIDCJWKSError).code).toBe("not_found")
    }
  })

  test("fails with not_found when the id_token has no kid header", async () => {
    const cache = createJWKSCache("https://sso.test/jwks", {
      fetch: async () => jsonResponse({ keys: [] }),
    })

    try {
      await cache.resolve({ alg: "RS256" })
      throw new Error("expected not_found")
    } catch (err) {
      expect(err).toBeInstanceOf(OIDCJWKSError)
      expect((err as OIDCJWKSError).code).toBe("not_found")
    }
  })

  test("invalidate() drops every cached key", async () => {
    const { publicJwk } = await makeJwkPair("kid-1")
    let calls = 0
    const cache = createJWKSCache("https://sso.test/jwks", {
      fetch: async () => {
        calls += 1
        return jsonResponse({ keys: [publicJwk] })
      },
    })

    await cache.resolve({ kid: "kid-1", alg: "RS256" })
    cache.invalidate()
    await cache.resolve({ kid: "kid-1", alg: "RS256" })

    expect(calls).toBe(2)
  })
})
