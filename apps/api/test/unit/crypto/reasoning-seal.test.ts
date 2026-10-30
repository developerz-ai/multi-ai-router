import { describe, expect, test } from "bun:test"
import { createReasoningSealer } from "../../../src/services/crypto/reasoning-seal"
import { reasoningSealFor } from "../../../src/services/dataplane/chain-body"

/**
 * The seal a translated response puts around an upstream's encrypted reasoning so a client can
 * carry it back on the next turn (e.g. inside an Anthropic thinking `signature`). Bound to the
 * account that produced it: only that account's seal opens it, so a blob is never replayed to an
 * upstream that did not issue it, and a client-forged or altered one is refused.
 */

const KEY = Buffer.alloc(32, 7).toString("base64")
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64")
const BLOB = "gAAAAABo-encrypted_reasoning+/=="

describe("reasoning seal", () => {
  test("round trip on the account that sealed it", () => {
    const seal = createReasoningSealer(KEY).forAccount("acct-a")
    expect(seal.open(seal.seal(BLOB))).toBe(BLOB)
  })

  test("deterministic: the same blob seals to the same bytes (the prefix cache depends on it)", () => {
    const seal = createReasoningSealer(KEY).forAccount("acct-a")
    expect(seal.seal(BLOB)).toBe(seal.seal(BLOB))
  })

  test("another account's seal does not open it", () => {
    const sealer = createReasoningSealer(KEY)
    expect(sealer.forAccount("acct-b").open(sealer.forAccount("acct-a").seal(BLOB))).toBeNull()
  })

  test("another deployment's key does not open it", () => {
    const sealed = createReasoningSealer(KEY).forAccount("acct-a").seal(BLOB)
    expect(createReasoningSealer(OTHER_KEY).forAccount("acct-a").open(sealed)).toBeNull()
  })

  test("any tampered byte is refused", () => {
    const seal = createReasoningSealer(KEY).forAccount("acct-a")
    const sealed = seal.seal(BLOB)
    for (let index = 0; index < sealed.length; index += 1) {
      const flipped = sealed[index] === "A" ? "B" : "A"
      const tampered = sealed.slice(0, index) + flipped + sealed.slice(index + 1)
      if (tampered === sealed) continue
      expect(seal.open(tampered)).toBeNull()
    }
  })

  test.each(["", "mrs1.", "mrs1..", "mar1:abc", "not-a-seal", `mrs1.${"A".repeat(10)}`])(
    "malformed %p is refused, never thrown",
    (value) => {
      expect(createReasoningSealer(KEY).forAccount("acct-a").open(value)).toBeNull()
    },
  )

  test("the seal never carries key material", () => {
    const sealed = createReasoningSealer(KEY).forAccount("acct-a").seal(BLOB)
    expect(sealed).not.toContain(KEY)
    expect(sealed.startsWith("mrs1.")).toBe(true)
  })

  test("an invalid ENCRYPTION_KEY is refused at construction", () => {
    expect(() => createReasoningSealer("short")).toThrow(/ENCRYPTION_KEY/)
  })
})

describe("reasoningSealFor: the chain's per-candidate seam", () => {
  const sealer = createReasoningSealer(KEY)
  const ctx = { runtime: { reasoningSealer: sealer } } as unknown as Parameters<
    typeof reasoningSealFor
  >[0]
  const servable = (id: string, translated: boolean) =>
    ({ account: { id }, translation: translated ? {} : null }) as unknown as Parameters<
      typeof reasoningSealFor
    >[1]

  test("a translated attempt gets the selected account's seal", () => {
    const bound = reasoningSealFor(ctx, servable("acct-a", true))
    expect(bound?.accountId).toBe("acct-a")
    expect(bound?.seal.open(sealer.forAccount("acct-a").seal(BLOB))).toBe(BLOB)
    expect(bound?.seal.open(sealer.forAccount("acct-b").seal(BLOB))).toBeNull()
  })

  test("a passthrough attempt gets none: its body is never touched", () => {
    expect(reasoningSealFor(ctx, servable("acct-a", false))).toBeUndefined()
  })
})
