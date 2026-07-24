import { describe, expect, test } from "bun:test"
import { CredentialDecryptError } from "@multi-ai-router/core"
import { createCredentialCipher } from "../../../src/services/crypto/cipher"
import { ENVELOPE_VERSION } from "../../../src/services/crypto/envelope"

const KEY = new Uint8Array(32).fill(7)
const OTHER_KEY = new Uint8Array(32).fill(8)
const SECRET = "sk-ant-api03-not-a-real-credential"

const cipher = createCredentialCipher({ key: KEY })

/** Segment indexes of `v1.<keyId>.<iv>.<authTag>.<ciphertext>`. */
const IV = 2
const AUTH_TAG = 3
const CIPHERTEXT = 4

function segments(envelope: string): string[] {
  return envelope.split(".")
}

/** Flips one bit of a base64url segment, keeping it a well-formed segment. */
function flipBit(segment: string): string {
  const bytes = Buffer.from(segment, "base64url")
  const first = bytes[0] ?? 0
  bytes[0] = first ^ 0b0000_0001
  return bytes.toString("base64url")
}

function replaceSegment(envelope: string, index: number, value: string): string {
  const parts = segments(envelope)
  parts[index] = value
  return parts.join(".")
}

function expectDecryptRejected(envelope: string): CredentialDecryptError {
  try {
    cipher.decrypt(envelope)
  } catch (error) {
    if (error instanceof CredentialDecryptError) return error
    throw error
  }
  throw new Error("expected decrypt to throw a CredentialDecryptError")
}

describe("round trip", () => {
  test("decrypt returns exactly what encrypt was given", () => {
    expect(cipher.decrypt(cipher.encrypt(SECRET))).toBe(SECRET)
  })

  test("survives multi-byte utf-8 and a long OAuth-token-sized payload", () => {
    const payload = `${"ya29.".repeat(400)}—ünïcödé—🔐`
    expect(cipher.decrypt(cipher.encrypt(payload))).toBe(payload)
  })

  test("the envelope never contains the plaintext", () => {
    expect(cipher.encrypt(SECRET)).not.toContain(SECRET)
    expect(cipher.encrypt(SECRET)).not.toContain("sk-ant")
  })

  test("stamps the configured key id, defaulting to k1", () => {
    expect(cipher.keyId).toBe("k1")
    expect(cipher.encrypt(SECRET).startsWith(`${ENVELOPE_VERSION}.k1.`)).toBe(true)
    expect(createCredentialCipher({ key: KEY, keyId: "k2" }).encrypt(SECRET)).toContain("v1.k2.")
  })

  test("refuses a key that is not 32 bytes", () => {
    expect(() => createCredentialCipher({ key: new Uint8Array(16) })).toThrow(/32 bytes/)
  })

  test("refuses to encrypt an empty credential", () => {
    expect(() => cipher.encrypt("")).toThrow(/empty credential/)
  })
})

describe("the nonce is fresh for every record", () => {
  test("1000 encryptions of the same plaintext produce 1000 distinct nonces", () => {
    // Nonce reuse under one key is what breaks GCM outright, so this is not a
    // statistical nicety — a collision here means the construction is wrong.
    const runs = 1000
    const nonces = new Set<string>()
    const envelopes = new Set<string>()

    for (let index = 0; index < runs; index += 1) {
      const envelope = cipher.encrypt(SECRET)
      nonces.add(segments(envelope)[IV] ?? "")
      envelopes.add(envelope)
    }

    expect(nonces.size).toBe(runs)
    expect(envelopes.size).toBe(runs)
  })

  test("the nonce is 12 bytes", () => {
    const nonce = segments(cipher.encrypt(SECRET))[IV] ?? ""
    expect(Buffer.from(nonce, "base64url")).toHaveLength(12)
  })
})

describe("decrypt fails loudly", () => {
  test("on a tampered ciphertext", () => {
    const envelope = cipher.encrypt(SECRET)
    const tampered = replaceSegment(
      envelope,
      CIPHERTEXT,
      flipBit(segments(envelope)[CIPHERTEXT] ?? ""),
    )

    expect(tampered).not.toBe(envelope)
    expect(expectDecryptRejected(tampered)).toBeInstanceOf(CredentialDecryptError)
  })

  test("on a tampered authentication tag", () => {
    const envelope = cipher.encrypt(SECRET)
    const tampered = replaceSegment(envelope, AUTH_TAG, flipBit(segments(envelope)[AUTH_TAG] ?? ""))

    expectDecryptRejected(tampered)
  })

  test("on a tampered nonce", () => {
    const envelope = cipher.encrypt(SECRET)
    expectDecryptRejected(replaceSegment(envelope, IV, flipBit(segments(envelope)[IV] ?? "")))
  })

  test("on a truncated envelope", () => {
    const envelope = cipher.encrypt(SECRET)
    expect(expectDecryptRejected(segments(envelope).slice(0, 3).join(".")).message).toContain(
      "expected 5 segments",
    )
    expect(expectDecryptRejected(envelope.slice(0, envelope.length - 6)).message).toBeTruthy()
  })

  test("on an unknown envelope version — never attempted with the current key", () => {
    const envelope = cipher.encrypt(SECRET)
    const relabelled = replaceSegment(envelope, 0, "v2")

    expect(expectDecryptRejected(relabelled).message).toContain("version")
  })

  test("on an unknown key id — a rotated record is re-encrypted, never guessed at", () => {
    const envelope = createCredentialCipher({ key: KEY, keyId: "k2" }).encrypt(SECRET)

    expect(expectDecryptRejected(envelope).message).toContain("k2")
    expect(expectDecryptRejected(envelope).message).toContain("does not hold")
  })

  test("when the header is re-labelled on a record this key could otherwise open", () => {
    // The `v1.<keyId>` header is bound in as additional authenticated data, so
    // even a cipher configured for `k2` cannot open a `k1` record renamed to k2.
    const envelope = cipher.encrypt(SECRET)
    const k2 = createCredentialCipher({ key: KEY, keyId: "k2" })

    expect(() => k2.decrypt(replaceSegment(envelope, 1, "k2"))).toThrow(CredentialDecryptError)
  })

  test("with the wrong encryption key", () => {
    const envelope = createCredentialCipher({ key: OTHER_KEY }).encrypt(SECRET)
    const error = expectDecryptRejected(envelope)

    expect(error.code).toBe("credential_decrypt_failed")
    expect(error.status).toBe(500)
  })

  test("without ever putting credential material in the message", () => {
    const envelope = cipher.encrypt(SECRET)
    const tampered = replaceSegment(
      envelope,
      CIPHERTEXT,
      flipBit(segments(envelope)[CIPHERTEXT] ?? ""),
    )
    const error = expectDecryptRejected(tampered)

    expect(error.message).not.toContain(SECRET)
    expect(error.message).not.toContain(segments(envelope)[CIPHERTEXT] ?? "")
    expect(error.message).not.toContain(Buffer.from(KEY).toString("base64url"))
  })
})
