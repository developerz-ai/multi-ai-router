import { describe, expect, test } from "bun:test"
import { CredentialDecryptError } from "@multi-ai-router/core"
import {
  AUTH_TAG_BYTES,
  ENVELOPE_SEGMENTS,
  ENVELOPE_VERSION,
  envelopeHeader,
  formatEnvelope,
  IV_BYTES,
  parseEnvelope,
} from "../../../src/services/crypto/envelope"

const parts = {
  keyId: "k1",
  iv: new Uint8Array(IV_BYTES).fill(1),
  authTag: new Uint8Array(AUTH_TAG_BYTES).fill(2),
  ciphertext: new Uint8Array([9, 8, 7, 6, 5]),
}

function expectRejected(value: string): CredentialDecryptError {
  try {
    parseEnvelope(value)
  } catch (error) {
    if (error instanceof CredentialDecryptError) return error
    throw error
  }
  throw new Error("expected parseEnvelope to throw a CredentialDecryptError")
}

describe("the envelope format", () => {
  test("is v1.<keyId>.<iv>.<authTag>.<ciphertext>", () => {
    const segments = formatEnvelope(parts).split(".")

    expect(segments).toHaveLength(ENVELOPE_SEGMENTS)
    expect(segments[0]).toBe(ENVELOPE_VERSION)
    expect(segments[1]).toBe("k1")
  })

  test("carries a key id from day one, even though rotation is deferred", () => {
    // The field is the whole reason rotation is possible later. Never simplify it away.
    expect(formatEnvelope({ ...parts, keyId: "k9" }).startsWith("v1.k9.")).toBe(true)
    expect(envelopeHeader("k9")).toBe("v1.k9")
  })

  test("uses unpadded base64url, so a record survives a URL and a JSON body unescaped", () => {
    const segments = formatEnvelope({ ...parts, ciphertext: new Uint8Array([251, 255, 190]) })
      .split(".")
      .slice(2)

    for (const segment of segments) {
      expect(segment).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })

  test("round-trips through parseEnvelope byte for byte", () => {
    const parsed = parseEnvelope(formatEnvelope(parts))

    expect(parsed.version).toBe(ENVELOPE_VERSION)
    expect(parsed.keyId).toBe("k1")
    expect(parsed.iv).toEqual(parts.iv)
    expect(parsed.authTag).toEqual(parts.authTag)
    expect(parsed.ciphertext).toEqual(parts.ciphertext)
  })
})

describe("parseEnvelope rejects rather than guesses", () => {
  const encoded = formatEnvelope(parts)
  const segments = encoded.split(".")

  test("a truncated record", () => {
    expect(expectRejected(segments.slice(0, 4).join(".")).message).toContain("expected 5 segments")
    expect(expectRejected("").message).toContain("expected 5 segments")
  })

  test("a record with an extra segment", () => {
    expectRejected(`${encoded}.extra`)
  })

  test("an unknown envelope version", () => {
    const message = expectRejected(`v2.${segments.slice(1).join(".")}`).message
    expect(message).toContain("version")
  })

  test("a key id that is not a plain label", () => {
    expect(expectRejected(`v1..${segments.slice(2).join(".")}`).message).toContain("key id")
    expect(expectRejected(`v1.k 1.${segments.slice(2).join(".")}`).message).toContain("key id")
  })

  test("a segment that is not base64url — never silently repaired", () => {
    // `Buffer.from(_, "base64url")` drops characters it does not recognise, so
    // this has to fail at the shape gate rather than decode to something short.
    expect(expectRejected(encoded.replace(segments[2] ?? "", "not*base64")).message).toContain(
      "base64url",
    )
  })

  test("a nonce of the wrong length", () => {
    const shortIv = Buffer.alloc(IV_BYTES - 1).toString("base64url")
    const message = expectRejected(
      [segments[0], segments[1], shortIv, segments[3], segments[4]].join("."),
    ).message
    expect(message).toContain("nonce must be 12 bytes")
  })

  test("an authentication tag of the wrong length", () => {
    const shortTag = Buffer.alloc(AUTH_TAG_BYTES - 4).toString("base64url")
    const message = expectRejected(
      [segments[0], segments[1], segments[2], shortTag, segments[4]].join("."),
    ).message
    expect(message).toContain("authentication tag must be 16 bytes")
  })

  test("with a CredentialDecryptError, never a generic Error", () => {
    const error = expectRejected("nonsense")
    expect(error).toBeInstanceOf(CredentialDecryptError)
    expect(error.code).toBe("credential_decrypt_failed")
    expect(error.status).toBe(500)
  })
})
