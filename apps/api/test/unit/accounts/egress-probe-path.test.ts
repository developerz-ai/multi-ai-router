import { expect, test } from "bun:test"
import type { RateLimitSignal } from "../../../src/providers"
import { createTestNowService } from "../../../src/services/accounts"
import { createCredentialCipher } from "../../../src/services/crypto/cipher"
import { accountRow } from "../../support/account-row"

/** "Never around it" (03-providers.md#egress-proxy): the recovery probe is a guarded test. */
test("a guarded test leaves through the account's egress proxy like any other call", async () => {
  const cipher = createCredentialCipher({ key: new Uint8Array(32).fill(3) })
  const proxy = "http://u:p@proxy.test:1"
  const account = accountRow({
    id: crypto.randomUUID(),
    provider: "openrouter",
    authMaterial: cipher.encrypt("sk-or-test"),
    egressProxy: { address: "proxy.test:1", sealed: cipher.encrypt(proxy) },
  })
  const seen: unknown[] = []
  const service = createTestNowService({
    accounts: { findById: async () => account },
    cipher,
    audit: { record: async () => {} },
    cooldownSeconds: 0,
    timeoutMs: 1_000,
    now: () => new Date("2026-11-23T00:00:00.000Z"),
    fetch: async (_request, init) => {
      seen.push(init)
      return Response.json({ choices: [] })
    },
  })
  await service.test(account.id, { model: "m" })
  await service.test(account.id, {
    model: "m",
    recovery: { startGuard: async () => {}, rateLimitSink: () => {} },
  })
  expect(seen).toEqual([{ proxy }, { proxy }])
})

/** One spent free model on a per-model key must leave the account's other models serving. */
test("a limit that is one model's own is folded as a reading, never as the account's wall", async () => {
  const cipher = createCredentialCipher({ key: new Uint8Array(32).fill(3) })
  const account = accountRow({
    id: crypto.randomUUID(),
    provider: "nvidia",
    authMaterial: cipher.encrypt("nvapi-test"),
  })
  const folded: RateLimitSignal[] = []
  const service = createTestNowService({
    accounts: { findById: async () => account },
    cipher,
    audit: { record: async () => {} },
    cooldownSeconds: 0,
    timeoutMs: 1_000,
    now: () => new Date("2026-11-23T00:00:00.000Z"),
    health: {
      applyRateLimit: (_id, signal) => {
        if (signal !== null) folded.push(signal)
      },
    },
    fetch: async () => new Response("{}", { status: 429, headers: { "retry-after": "60" } }),
  })
  await service.test(account.id, { model: "m" })
  expect(folded.filter((signal) => signal.limited)).toEqual([])
})
