import { describe, expect, test } from "bun:test"
import {
  createDiscoveryService,
  OIDCDiscoveryError,
} from "../../../../../src/services/admin-auth/oidc/discovery"

/**
 * `/.well-known/openid-configuration` — parse, cache hit, cache miss. The
 * service is a thin one: a fetcher, a clock, an in-memory cache. The shape
 * is mostly about the cache and the validation, which is what the three
 * tests pin.
 */

const ISSUER = "https://sso.test"
const DOC = {
  issuer: ISSUER,
  authorization_endpoint: "https://sso.test/oauth2/v2/authorize",
  token_endpoint: "https://sso.test/oauth2/v2/token",
  jwks_uri: "https://sso.test/oauth2/v2/keys",
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: ["openid", "profile", "email"],
  id_token_signing_alg_values_supported: ["RS256"],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("createDiscoveryService", () => {
  test("fetches the discovery document on first call and parses it", async () => {
    let calls = 0
    const service = createDiscoveryService(ISSUER, {
      fetch: async () => {
        calls += 1
        return jsonResponse(DOC)
      },
    })

    const doc = await service.load()

    expect(doc.issuer).toBe(ISSUER)
    expect(doc.authorization_endpoint).toBe(DOC.authorization_endpoint)
    expect(doc.jwks_uri).toBe(DOC.jwks_uri)
    expect(calls).toBe(1)
  })

  test("returns the cached document on subsequent calls without re-fetching", async () => {
    let calls = 0
    const service = createDiscoveryService(ISSUER, {
      fetch: async () => {
        calls += 1
        return jsonResponse(DOC)
      },
    })

    await service.load()
    await service.load()
    await service.load()

    expect(calls).toBe(1)
  })

  test("re-fetches after invalidate() is called", async () => {
    let calls = 0
    const service = createDiscoveryService(ISSUER, {
      fetch: async () => {
        calls += 1
        return jsonResponse(DOC)
      },
    })

    await service.load()
    service.invalidate()
    await service.load()

    expect(calls).toBe(2)
  })

  test("fails with fetch_failed when the endpoint returns non-2xx", async () => {
    const service = createDiscoveryService(ISSUER, {
      fetch: async () => jsonResponse({}, 503),
    })

    expect(service.load()).rejects.toBeInstanceOf(OIDCDiscoveryError)
    try {
      await service.load()
    } catch (err) {
      expect((err as OIDCDiscoveryError).code).toBe("fetch_failed")
    }
  })

  test("fails with parse_failed when the body is not JSON", async () => {
    const service = createDiscoveryService(ISSUER, {
      fetch: async () => new Response("not-json", { status: 200 }),
    })

    try {
      await service.load()
      throw new Error("expected parse_failed")
    } catch (err) {
      expect(err).toBeInstanceOf(OIDCDiscoveryError)
      expect((err as OIDCDiscoveryError).code).toBe("parse_failed")
    }
  })

  test("fails with validation_failed when the issuer in the document does not match", async () => {
    const service = createDiscoveryService(ISSUER, {
      fetch: async () =>
        jsonResponse({
          ...DOC,
          issuer: "https://attacker.test",
        }),
    })

    try {
      await service.load()
      throw new Error("expected validation_failed")
    } catch (err) {
      expect(err).toBeInstanceOf(OIDCDiscoveryError)
      expect((err as OIDCDiscoveryError).code).toBe("validation_failed")
    }
  })

  test("fails with unsupported when the IdP does not advertise PKCE S256", async () => {
    const service = createDiscoveryService(ISSUER, {
      fetch: async () =>
        jsonResponse({
          ...DOC,
          code_challenge_methods_supported: ["plain"],
        }),
    })

    try {
      await service.load()
      throw new Error("expected unsupported")
    } catch (err) {
      expect(err).toBeInstanceOf(OIDCDiscoveryError)
      expect((err as OIDCDiscoveryError).code).toBe("unsupported")
    }
  })
})
