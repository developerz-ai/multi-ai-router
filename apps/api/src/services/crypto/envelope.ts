import { CredentialDecryptError } from "@multi-ai-router/core"
import { z } from "zod"

/**
 * The at-rest envelope every AES-256-GCM ciphertext in the router is stored as:
 *
 *     v1.<keyId>.<iv>.<authTag>.<ciphertext>
 *      │    │      │      │           └─ base64url — the GCM ciphertext
 *      │    │      │      └─ base64url — the 16-byte GCM authentication tag
 *      │    │      └─ base64url — 12 random bytes, generated per encryption, never reused
 *      │    └─ which encryption key produced this record (`k1` today)
 *      └─ envelope format version
 *
 * Five dot-separated segments. Every binary segment is unpadded base64url, so a
 * record is copy-safe and survives a `text` column, a JSON body, and a URL with
 * no escaping. `.` never occurs inside base64url, so the split is unambiguous.
 *
 * `keyId` is carried from day one even though only one key exists and rotation
 * is DEFERRED (docs/idea/07-security.md#secrets-at-rest): rotating without a key
 * id means re-encrypting blind, so this field must never be simplified away.
 *
 * `v1.<keyId>` doubles as the GCM additional authenticated data, so the tag
 * covers the header as well as the ciphertext — a stored record cannot be
 * re-labelled with another version or key id and still verify.
 *
 * Parsing is a trust boundary: the input is whatever is in the database, so it
 * is validated before a single byte reaches OpenSSL, and every rejection is a
 * `CredentialDecryptError` naming the reason and nothing else. No message here
 * ever carries ciphertext, plaintext, or key material.
 */

export const ENVELOPE_VERSION = "v1"
export const ENVELOPE_SEGMENTS = 5
export const IV_BYTES = 12
export const AUTH_TAG_BYTES = 16

export interface CredentialEnvelope {
  readonly version: typeof ENVELOPE_VERSION
  readonly keyId: string
  readonly iv: Uint8Array
  readonly authTag: Uint8Array
  readonly ciphertext: Uint8Array
}

/** The `v1.<keyId>` prefix, used verbatim as the GCM additional authenticated data. */
export function envelopeHeader(keyId: string): string {
  return `${ENVELOPE_VERSION}.${keyId}`
}

export function formatEnvelope(parts: Omit<CredentialEnvelope, "version">): string {
  return [
    envelopeHeader(parts.keyId),
    encodeSegment(parts.iv),
    encodeSegment(parts.authTag),
    encodeSegment(parts.ciphertext),
  ].join(".")
}

/**
 * Validates a stored envelope into its parts.
 *
 * @throws CredentialDecryptError on anything that is not a well-formed `v1`
 * envelope — a truncated record, an unknown version, a segment that is not
 * base64url, or a nonce/tag of the wrong length.
 */
export function parseEnvelope(value: string): CredentialEnvelope {
  const segments = value.split(".")
  if (segments.length !== ENVELOPE_SEGMENTS) {
    reject(`expected ${ENVELOPE_SEGMENTS} segments, got ${segments.length}`)
  }

  const parsed = envelopeSegments.safeParse({
    version: segments[0],
    keyId: segments[1],
    iv: segments[2],
    authTag: segments[3],
    ciphertext: segments[4],
  })
  if (!parsed.success) reject(describe(parsed.error))

  const iv = decodeSegment(parsed.data.iv)
  if (iv.byteLength !== IV_BYTES) reject(`nonce must be ${IV_BYTES} bytes, got ${iv.byteLength}`)

  const authTag = decodeSegment(parsed.data.authTag)
  if (authTag.byteLength !== AUTH_TAG_BYTES) {
    reject(`authentication tag must be ${AUTH_TAG_BYTES} bytes, got ${authTag.byteLength}`)
  }

  return {
    version: ENVELOPE_VERSION,
    keyId: parsed.data.keyId,
    iv,
    authTag,
    ciphertext: decodeSegment(parsed.data.ciphertext),
  }
}

/** Unpadded base64url. Rejected rather than silently repaired — `Buffer.from` drops stray bytes. */
const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/, "is not unpadded base64url")

const envelopeSegments = z.object({
  version: z.literal(ENVELOPE_VERSION, "is not a supported envelope version"),
  // Deliberately narrow: a key id is an operator-chosen label, not free text,
  // and it travels inside the authenticated header.
  keyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/, "is not a valid key id"),
  iv: base64url,
  authTag: base64url,
  ciphertext: base64url,
})

function encodeSegment(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

function decodeSegment(segment: string): Uint8Array {
  return new Uint8Array(Buffer.from(segment, "base64url"))
}

function describe(error: z.ZodError): string {
  const issue = error.issues[0]
  if (issue === undefined) return "is malformed"
  const field = issue.path.map(String).join(".")
  return field === "" ? issue.message : `${field} ${issue.message}`
}

function reject(reason: string): never {
  throw new CredentialDecryptError(`credential envelope rejected: ${reason}`)
}
