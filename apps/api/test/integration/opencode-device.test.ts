import { describe, expect, test } from "bun:test"
import { createDeviceConnectService } from "../../src/services/accounts"
import { createAuditRecorder } from "../../src/services/admin"
import { createCredentialCipher } from "../../src/services/crypto/cipher"
import { createMemoryStore } from "../support/memory-store"

function harness() {
  const store = createMemoryStore()
  const clock = { now: new Date("2026-11-07T12:00:00Z") }
  const cipher = createCredentialCipher({ key: new Uint8Array(32).fill(7) })
  const calls: string[] = []
  let pollBody: unknown
  let onPoll: (() => Promise<void>) | undefined
  const service = createDeviceConnectService({
    accounts: store.accounts,
    states: store.oauthStates,
    cipher,
    audit: createAuditRecorder(store.audit),
    stateMinutes: 20,
    exchangeTimeoutMs: 1000,
    now: () => clock.now,
    refreshCatalogAfterMutation: async () => {},
    fetch: async (request) => {
      calls.push(request.url)
      if (request.url.endsWith("/device/code"))
        return Response.json({
          device_code: "test-handle",
          user_code: "ABCD-EFGH",
          interval: 5,
          expires_in: 600,
        })
      if (request.url.endsWith("/device/token")) {
        await onPoll?.()
        return pollBody
          ? Response.json(pollBody, { status: 400 })
          : Response.json({
              access_token: "test-access",
              refresh_token: "test-refresh",
              expires_in: 3600,
              org_id: "org-test",
            })
      }
      throw new Error("Unexpected code exchange")
    },
  })
  return {
    store,
    clock,
    cipher,
    calls,
    service,
    setPollBody: (body: unknown) => {
      pollBody = body
    },
    setOnPoll: (fn: () => Promise<void>) => {
      onPoll = fn
    },
  }
}

describe("OpenCode direct device tokens", () => {
  test("commits tokens once with lifecycle fences, encrypted, without a second exchange", async () => {
    const h = harness()
    const row = await h.store.accounts.create({ label: "console", provider: "opencode-oauth" })
    const start = await h.service.begin(row.id, "connect")
    expect(start).toMatchObject({ ok: true, value: { expiresAt: "2026-11-07T12:10:00.000Z" } })
    expect(await h.service.status(row.id)).toMatchObject({ ok: true, value: { status: "waiting" } })
    expect(h.calls).toHaveLength(1)
    h.clock.now = new Date(h.clock.now.getTime() + 5000)
    const done = await h.service.status(row.id)
    expect(done).toMatchObject({ ok: true, value: { status: "connected" } })
    const saved = await h.store.accounts.findById(row.id)
    expect(saved?.authMaterial).not.toContain("test-access")
    const stored = JSON.parse(h.cipher.decrypt(saved?.authMaterial ?? ""))
    expect(stored).toMatchObject({
      accessToken: "test-access",
      refreshToken: "test-refresh",
      providerAccountId: "org-test",
    })
    expect(saved?.tokenExpiresAt?.toISOString()).toBe("2026-11-07T13:00:05.000Z")
    expect(await h.service.status(row.id)).toEqual(done)
    expect(h.calls).toHaveLength(2)
    expect(JSON.stringify(done)).not.toContain("test-access")
    expect(JSON.stringify(h.store.rows.audit)).not.toContain("test-refresh")
  })

  test("repeated slow_down permanently adds five seconds, without the transient backoff cap", async () => {
    const h = harness()
    const row = await h.store.accounts.create({ label: "console", provider: "opencode-oauth" })
    await h.service.begin(row.id, "connect")
    h.setPollBody({ error: "slow_down" })
    h.clock.now = new Date(h.clock.now.getTime() + 5000)
    for (const interval of [10, 15, 20, 25, 30]) {
      expect(await h.service.status(row.id)).toMatchObject({
        ok: true,
        value: { status: "waiting" },
      })
      const count = h.calls.length
      h.clock.now = new Date(h.clock.now.getTime() + (interval - 1) * 1000)
      await h.service.status(row.id)
      expect(h.calls).toHaveLength(count)
      h.clock.now = new Date(h.clock.now.getTime() + 1000)
    }
  })

  test("superseded authorization cannot write a directly issued token set", async () => {
    const h = harness()
    const row = await h.store.accounts.create({ label: "console", provider: "opencode-oauth" })
    await h.service.begin(row.id, "connect")
    h.clock.now = new Date(h.clock.now.getTime() + 5000)
    h.setOnPoll(async () => {
      await h.service.begin(row.id, "connect")
    })
    expect(await h.service.status(row.id)).toMatchObject({ ok: true, value: { status: "expired" } })
    expect((await h.store.accounts.findById(row.id))?.authMaterial).toBeNull()
  })
})
