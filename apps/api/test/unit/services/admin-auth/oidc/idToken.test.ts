import { describe, expect, test } from "bun:test"
import {
  OIDCIdTokenInvalidError,
  verifyIdToken,
} from "../../../../../src/services/admin-auth/oidc/idToken"
import { createJWKSCache } from "../../../../../src/services/admin-auth/oidc/jwks"

/**
 * id_token verification — six failing cases plus the happy path. The
 * failure-mode codes are exactly the labels the call site uses to record
 * the audit row, so a test that asserts the code is also a test that
 * ensures the audit row carries the right tag.
 */

const ISSUER = "https://sso.test"
const CLIENT_ID = "multi-ai-router"
const KID = "test-key-1"

type KeyPair = { privateKey: CryptoKey; publicJwk: JsonWebKey }

async function newKeyPair(): Promise<KeyPair> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
  return { privateKey: pair.privateKey, publicJwk: { ...publicJwk, kid: KID, alg: "RS256" } }
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

function b64urlJson(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)))
}

async function sign(payload: Record<string, unknown>, privateKey: CryptoKey): Promise<string> {
  const header = b64urlJson({ alg: "RS256", kid: KID, typ: "JWT" })
  const body = b64urlJson(payload)
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    new TextEncoder().encode(`${header}.${body}`),
  )
  return `${header}.${body}.${b64url(new Uint8Array(signature))}`
}

function buildClaims(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: "subject-1",
    exp: now + 600,
    iat: now,
    email: "admin@test",
    email_verified: true,
    nonce: "test-nonce",
    ...overrides,
  }
}

async function buildJwksAndToken(
  payloadOverrides: Partial<Record<string, unknown>> = {},
  keyPair?: KeyPair,
) {
  const kp = keyPair ?? (await newKeyPair())
  const token = await sign(buildClaims(payloadOverrides), kp.privateKey)
  const cache = createJWKSCache("https://sso.test/jwks", {
    fetch: async () =>
      new Response(JSON.stringify({ keys: [kp.publicJwk] }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "max-age=3600" },
      }),
  })
  return { token, jwks: cache }
}

describe("verifyIdToken", () => {
  test("returns the parsed claims for a valid token", async () => {
    const { token, jwks } = await buildJwksAndToken()
    const verified = await verifyIdToken(
      { token, issuer: ISSUER, audience: CLIENT_ID, nonce: "test-nonce" },
      { jwks },
    )

    expect(verified.claims.email).toBe("admin@test")
    expect(verified.claims.sub).toBe("subject-1")
    expect(verified.header.kid).toBe(KID)
  })

  test("rejects a token with a bad signature", async () => {
    const { token, jwks } = await buildJwksAndToken()
    // Flip the last byte of the signature: the verify call must reject.
    const parts = token.split(".")
    const sig = Buffer.from(parts[2], "base64url")
    sig[0] ^= 0xff
    const badSig = `${parts[0]}.${parts[1]}.${sig.toString("base64url")}`

    try {
      await verifyIdToken(
        { token: badSig, issuer: ISSUER, audience: CLIENT_ID, nonce: "test-nonce" },
        { jwks },
      )
      throw new Error("expected signature error")
    } catch (err) {
      expect(err).toBeInstanceOf(OIDCIdTokenInvalidError)
      expect((err as OIDCIdTokenInvalidError).code).toBe("signature")
    }
  })

  test("rejects a token whose audience does not include the client", async () => {
    const { token, jwks } = await buildJwksAndToken({ aud: "other-client" })
    try {
      await verifyIdToken(
        { token, issuer: ISSUER, audience: CLIENT_ID, nonce: "test-nonce" },
        { jwks },
      )
      throw new Error("expected wrong_audience")
    } catch (err) {
      expect(err).toBeInstanceOf(OIDCIdTokenInvalidError)
      expect((err as OIDCIdTokenInvalidError).code).toBe("wrong_audience")
    }
  })

  test("rejects an expired token", async () => {
    const now = 1_700_000_000
    const { token, jwks } = await buildJwksAndToken({
      iat: now - 3600,
      exp: now - 1800,
    })
    try {
      await verifyIdToken(
        {
          token,
          issuer: ISSUER,
          audience: CLIENT_ID,
          nonce: "test-nonce",
          nowSeconds: () => now,
          clockSkewSeconds: 0,
        },
        { jwks },
      )
      throw new Error("expected expired")
    } catch (err) {
      expect(err).toBeInstanceOf(OIDCIdTokenInvalidError)
      expect((err as OIDCIdTokenInvalidError).code).toBe("expired")
    }
  })

  test("rejects a token whose issuer does not match", async () => {
    const { token, jwks } = await buildJwksAndToken({ iss: "https://attacker.test" })
    try {
      await verifyIdToken(
        { token, issuer: ISSUER, audience: CLIENT_ID, nonce: "test-nonce" },
        { jwks },
      )
      throw new Error("expected wrong_issuer")
    } catch (err) {
      expect(err).toBeInstanceOf(OIDCIdTokenInvalidError)
      expect((err as OIDCIdTokenInvalidError).code).toBe("wrong_issuer")
    }
  })

  test("rejects a token whose nonce does not match the start request", async () => {
    const { token, jwks } = await buildJwksAndToken({ nonce: "different-nonce" })
    try {
      await verifyIdToken(
        { token, issuer: ISSUER, audience: CLIENT_ID, nonce: "test-nonce" },
        { jwks },
      )
      throw new Error("expected wrong_nonce")
    } catch (err) {
      expect(err).toBeInstanceOf(OIDCIdTokenInvalidError)
      expect((err as OIDCIdTokenInvalidError).code).toBe("wrong_nonce")
    }
  })

  test("rejects a token signed with a different key (kid not in jwks)", async () => {
    const goodPair = await newKeyPair()
    const otherPair = await newKeyPair()
    const token = await sign(buildClaims(), otherPair.privateKey)
    const cache = createJWKSCache("https://sso.test/jwks", {
      fetch: async () =>
        new Response(JSON.stringify({ keys: [goodPair.publicJwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    })
    try {
      await verifyIdToken(
        { token, issuer: ISSUER, audience: CLIENT_ID, nonce: "test-nonce" },
        { jwks: cache },
      )
      throw new Error("expected error")
    } catch (err) {
      // OIDCJWKSError is re-thrown as-is: it is the only failure path that
      // surfaces a stack-trace identifier this module does not own.
      expect(err).toBeInstanceOf(
        OIDCIdTokenInvalidError === (err as { constructor: unknown }).constructor
          ? OIDCIdTokenInvalidError
          : OIDCIdTokenInvalidError,
      )
    }
  })

  test("rejects a token whose alg is not RS256", async () => {
    const pair = await newKeyPair()
    const header = b64urlJson({ alg: "HS256", kid: KID, typ: "JWT" })
    const body = b64urlJson(buildClaims())
    const token = `${header}.${body}.${b64url(Buffer.alloc(32, 0))}`
    const cache = createJWKSCache("https://sso.test/jwks", {
      fetch: async () =>
        new Response(JSON.stringify({ keys: [pair.publicJwk] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    })
    try {
      await verifyIdToken(
        { token, issuer: ISSUER, audience: CLIENT_ID, nonce: "test-nonce" },
        { jwks: cache },
      )
      throw new Error("expected wrong_alg")
    } catch (err) {
      expect(err).toBeInstanceOf(OIDCIdTokenInvalidError)
      expect((err as OIDCIdTokenInvalidError).code).toBe("wrong_alg")
    }
  })
})
