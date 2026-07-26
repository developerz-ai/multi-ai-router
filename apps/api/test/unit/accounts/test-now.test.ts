import { describe, expect, test } from "bun:test"
import type { AccountRow } from "@multi-ai-router/db"
import type { SdkTestProbe, SdkTestProbeResult } from "../../../src/providers"
import { createTestNowService } from "../../../src/services/accounts"
import type { AuditEventInput } from "../../../src/services/admin"

/**
 * "Test now" — the second, opt-in button beside "Re-check now".
 *
 * The properties worth pinning: the HTTP half actually addresses the account's own driver and
 * reports its real answer; the Agent-SDK half refuses to run without `confirmed: true` and never
 * touches the SDK probe when it is missing; and the cooldown, cost-bearing on purpose, is its own
 * clock rather than the re-check's.
 */

const NOW = new Date("2026-01-01T12:00:00.000Z")

function accountRow(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "acc-1",
    label: "acc-1",
    provider: "zai",
    status: "active",
    authMaterial: "plaintext-key",
    configDir: null,
    tokenExpiresAt: null,
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    weight: 100,
    priority: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function harness(options: {
  readonly row?: AccountRow
  readonly fetch?: (request: Request) => Promise<Response>
  readonly sdkProbe?: SdkTestProbe
  readonly cooldownSeconds?: number
}) {
  const row = options.row ?? accountRow()
  const audited: AuditEventInput[] = []
  let clock = NOW

  const service = createTestNowService({
    accounts: { findById: async (id) => (id === row.id ? row : undefined) },
    cipher: { decrypt: (envelope) => envelope },
    audit: { record: async (event) => void audited.push(event) },
    cooldownSeconds: options.cooldownSeconds ?? 60,
    timeoutMs: 5_000,
    now: () => clock,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.sdkProbe === undefined ? {} : { sdkProbe: options.sdkProbe }),
  })

  return {
    service,
    audited,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms)
    },
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("createTestNowService — HTTP accounts", () => {
  test("reports a real success against the account's own driver", async () => {
    let seenUrl: string | null = null
    const { service, audited } = harness({
      fetch: async (request) => {
        seenUrl = request.url
        return jsonResponse(200, { id: "msg_1", content: [] })
      },
    })

    const result = await service.test("acc-1", { model: "glm-4.7" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.tested).toBe(true)
    expect(result.value.outcome).toBe("ok")
    // The default surface is Anthropic — z.ai's primary client speaks it.
    expect(seenUrl).toBe("https://api.z.ai/api/anthropic/v1/messages")
    expect(audited).toHaveLength(1)
    expect(audited[0]?.kind).toBe("account.tested")
  })

  test("reports the real failure classification, not a generic error", async () => {
    const { service } = harness({
      fetch: async () => jsonResponse(401, { error: { code: "1001", message: "bad token" } }),
    })

    const result = await service.test("acc-1", { model: "glm-4.7" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.outcome).toBe("failed")
    expect(result.value.message).toBe("zai:auth-code")
  })

  test("refuses inside its own cooldown without spending a request", async () => {
    let calls = 0
    const { service, advance } = harness({
      cooldownSeconds: 120,
      fetch: async () => {
        calls += 1
        return jsonResponse(200, {})
      },
    })

    const first = await service.test("acc-1", { model: "glm-4.7" })
    expect(first.ok && first.value.tested).toBe(true)

    advance(1_000)
    const second = await service.test("acc-1", { model: "glm-4.7" })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.tested).toBe(false)
    expect(calls).toBe(1)
  })

  test("names the account when it does not exist", async () => {
    const { service } = harness({})
    const result = await service.test("missing", { model: "glm-4.7" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.status).toBe(404)
  })
})

describe("createTestNowService — Agent-SDK accounts", () => {
  function subscriptionRow(): AccountRow {
    return accountRow({
      provider: "anthropic-oauth",
      authMaterial: null,
      configDir: "/data/claude/acc-1",
    })
  }

  test("refuses without confirmed, and never calls the probe", async () => {
    let called = false
    const probe: SdkTestProbe = {
      run: async () => {
        called = true
        return { ok: true, message: "pong" }
      },
    }
    const { service } = harness({ row: subscriptionRow(), sdkProbe: probe })

    const result = await service.test("acc-1", { model: "claude-sonnet-4-5" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe("confirmation_required")
    expect(called).toBe(false)
  })

  test("runs the real probe once confirmed", async () => {
    const probe: SdkTestProbe = {
      run: async (): Promise<SdkTestProbeResult> => ({ ok: true, message: "pong" }),
    }
    const { service, audited } = harness({ row: subscriptionRow(), sdkProbe: probe })

    const result = await service.test("acc-1", { model: "claude-sonnet-4-5", confirmed: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.outcome).toBe("ok")
    expect(result.value.message).toBe("pong")
    expect(audited).toHaveLength(1)
  })

  test("reports the probe's own failure verbatim", async () => {
    const probe: SdkTestProbe = {
      run: async () => ({
        ok: false,
        message: "the account's Claude subscription window is spent",
      }),
    }
    const { service } = harness({ row: subscriptionRow(), sdkProbe: probe })

    const result = await service.test("acc-1", { model: "claude-sonnet-4-5", confirmed: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.outcome).toBe("failed")
    expect(result.value.message).toBe("the account's Claude subscription window is spent")
  })

  test("refuses by name when no probe is configured, even when confirmed", async () => {
    const { service } = harness({ row: subscriptionRow() })

    const result = await service.test("acc-1", { model: "claude-sonnet-4-5", confirmed: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.outcome).toBe("failed")
    expect(result.value.message).toContain("no Agent-SDK test probe")
  })

  test("refuses an account with no config directory yet", async () => {
    const probe: SdkTestProbe = { run: async () => ({ ok: true, message: "pong" }) }
    const bare = accountRow({ provider: "anthropic-oauth", authMaterial: null, configDir: null })
    const { service } = harness({ row: bare, sdkProbe: probe })

    const result = await service.test("acc-1", { model: "claude-sonnet-4-5", confirmed: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.outcome).toBe("failed")
    expect(result.value.message).toContain("no config directory")
  })
})
