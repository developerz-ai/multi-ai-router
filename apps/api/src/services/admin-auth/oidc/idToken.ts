/**
 * `id_token` verification — JWS signature, standard claims, the lot.
 *
 * The verifier is a single function with two collaborators: a JWKS cache and a
 * clock. Everything that distinguishes one validator from another is in the
 * verifier's *configuration* (issuer, audience, optional subject), not in its
 * code. That is the only way to keep the failure-mode wording identical across
 * all the ways a token can be wrong.
 *
 * One failure wording for the operator-facing answer. The exception is what the
 * IdP says back: a clock-skew error is a clock-skew error, and we should let it
 * surface for debugging. The route layer logs the *kind* and answers the
 * client with the generic message.
 */

import { z } from "zod"
import type { CryptoKeyHolder, JWKSCache } from "./jwks"

const ALG = "RS256"

/** RFC 7519 §4.1 — the standard claims we actually use. */
const idTokenClaimsSchema = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string(),
  /** Seconds since epoch, integer. */
  exp: z.number(),
  /** Seconds since epoch, integer. */
  iat: z.number(),
  /** RFC 7519 §4.1.2 — `azp` is the authorized party when `aud` is an array. */
  azp: z.string().optional(),
  /** Email + verified-ness. The IdP is the source of truth for both. */
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
  /** The OIDC flow's replay defence, minted server-side at start. */
  nonce: z.string().optional(),
})

export type IdTokenClaims = z.infer<typeof idTokenClaimsSchema>

/** A JWS in compact serialization. Header.payload.signature, all base64url. */
const jwsCompactSchema = z.tuple([z.string().min(1), z.string().min(1), z.string().min(1)])

export class OIDCIdTokenInvalidError extends Error {
  readonly code:
    | "malformed"
    | "signature"
    | "expired"
    | "not_yet_valid"
    | "wrong_issuer"
    | "wrong_audience"
    | "wrong_nonce"
    | "missing_email"
    | "email_unverified"
    | "missing_sub"
    | "wrong_alg"
  constructor(message: string, code: OIDCIdTokenInvalidError["code"]) {
    super(message)
    this.name = "OIDCIdTokenInvalidError"
    this.code = code
  }
}

export interface JWSHeader {
  readonly alg: string
  readonly kid?: string
  readonly typ?: string
}

function b64urlDecode(value: string): Uint8Array {
  // bun's atob is fine for ASCII; the URL-safe alphabet is what differs.
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4))
  const b64 = value.replaceAll("-", "+").replaceAll("_", "/") + pad
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function b64urlDecodeJson<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(value))) as T
}

export interface VerifyIdTokenInput {
  /** Compact-serialized JWS. */
  readonly token: string
  /** The issuer the discovery doc advertised and we asked for. */
  readonly issuer: string
  /** The client id we used at the authorize step. */
  readonly audience: string
  /** The nonce we minted at start and pulled back from the state row. */
  readonly nonce: string
  /** Allowed clock skew, in seconds. Default 60 to soak router/IdP drift. */
  readonly clockSkewSeconds?: number
  /** Injected clock for tests. Default is real time. */
  readonly nowSeconds?: () => number
}

export interface VerifyIdTokenDeps {
  readonly jwks: JWKSCache
}

export interface VerifiedIdToken {
  readonly claims: IdTokenClaims
  readonly header: JWSHeader
}

/** One function — the only place any id_token check runs. */
export async function verifyIdToken(
  input: VerifyIdTokenInput,
  deps: VerifyIdTokenDeps,
): Promise<VerifiedIdToken> {
  const parts = jwsCompactSchema.safeParse(input.token.split("."))
  if (!parts.success) {
    throw new OIDCIdTokenInvalidError("id_token is not a valid JWS", "malformed")
  }

  const [headerB64, payloadB64, signatureB64] = parts.data
  let header: JWSHeader
  let claims: IdTokenClaims
  try {
    header = b64urlDecodeJson<JWSHeader>(headerB64)
    claims = idTokenClaimsSchema.parse(b64urlDecodeJson<unknown>(payloadB64))
  } catch {
    throw new OIDCIdTokenInvalidError("id_token header or payload is malformed", "malformed")
  }

  if (header.alg !== ALG) {
    throw new OIDCIdTokenInvalidError(
      `id_token uses alg "${header.alg}"; only ${ALG} is accepted`,
      "wrong_alg",
    )
  }

  const keyHolder: CryptoKeyHolder = await deps.jwks.resolve(header)
  if (keyHolder.alg !== ALG) {
    throw new OIDCIdTokenInvalidError(
      `key for kid "${header.kid}" advertises alg "${keyHolder.alg}"; only ${ALG} is accepted`,
      "wrong_alg",
    )
  }

  // The signature is over the **ASCII** bytes of `<header>.<payload>`. Decoding
  // to bytes then re-encoding would round-trip through the wire alphabet and is
  // not what the signature was computed over.
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  const signatureBytes = b64urlDecode(signatureB64)
  const verified = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    keyHolder.key,
    signatureBytes.buffer.slice(
      signatureBytes.byteOffset,
      signatureBytes.byteOffset + signatureBytes.byteLength,
    ) as ArrayBuffer,
    signingInput,
  )
  if (!verified) {
    throw new OIDCIdTokenInvalidError("id_token signature did not verify", "signature")
  }

  const skew = input.clockSkewSeconds ?? 60
  const now = input.nowSeconds ? input.nowSeconds() : Math.floor(Date.now() / 1000)

  if (claims.iss !== input.issuer) {
    throw new OIDCIdTokenInvalidError(
      `id_token issuer "${claims.iss}" does not match expected "${input.issuer}"`,
      "wrong_issuer",
    )
  }

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!aud.includes(input.audience)) {
    throw new OIDCIdTokenInvalidError(
      `id_token aud does not include client id "${input.audience}"`,
      "wrong_audience",
    )
  }

  // The nonce is the replay defence. Bind it to the state row's nonce and reject.
  if (claims.nonce === undefined || claims.nonce !== input.nonce) {
    throw new OIDCIdTokenInvalidError(
      "id_token nonce did not match the start request",
      "wrong_nonce",
    )
  }

  if (claims.exp + skew < now) {
    throw new OIDCIdTokenInvalidError("id_token has expired", "expired")
  }

  return { claims, header }
}

/** A small, focused check that the email + verified contract is satisfied. */
export function assertEmailVerified(claims: IdTokenClaims): { email: string; sub: string } {
  if (claims.email === undefined || claims.email.length === 0) {
    throw new OIDCIdTokenInvalidError("id_token has no email claim", "missing_email")
  }
  if (claims.email_verified !== true) {
    throw new OIDCIdTokenInvalidError(
      "id_token email is not verified by the identity provider",
      "email_unverified",
    )
  }
  if (claims.sub === undefined || claims.sub.length === 0) {
    throw new OIDCIdTokenInvalidError("id_token has no sub claim", "missing_sub")
  }
  return { email: claims.email, sub: claims.sub }
}
