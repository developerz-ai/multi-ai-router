import { describe, expect, test } from "bun:test"
import type { AccountRow } from "@multi-ai-router/db"
import {
  createSdkQuotaStore,
  type RateLimitSignal,
  type SdkTestProbe,
  type SdkTestProbeInput,
  type SdkTestProbeResult,
} from "../../../src/providers"
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

  // The real stores, not stubs: the point of these two is that a reading lands where the console
  // reads it, and a stub would let the two drift apart exactly as they did in production.
  const quota = createSdkQuotaStore()
  const folded: { accountId: string; signal: RateLimitSignal | null }[] = []
  const warnings: { msg: string; fields?: Record<string, unknown> }[] = []

  const service = createTestNowService({
    accounts: { findById: async (id) => (id === row.id ? row : undefined) },
    cipher: { decrypt: (envelope) => envelope },
    audit: { record: async (event) => void audited.push(event) },
    cooldownSeconds: options.cooldownSeconds ?? 60,
    timeoutMs: 5_000,
    now: () => clock,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.sdkProbe === undefined ? {} : { sdkProbe: options.sdkProbe }),
    quota,
    health: {
      applyRateLimit: (accountId, signal) => void folded.push({ accountId, signal }),
    },
    log: { warn: (msg, fields) => void warnings.push({ msg, fields }) },
  })

  return {
    service,
    audited,
    quota,
    folded,
    warnings,
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

  test("probes an openai-chat account under the ceiling name its provider states", async () => {
    const sent: Record<string, unknown>[] = []
    const capture = async (request: Request) => {
      sent.push(JSON.parse(await request.text()) as Record<string, unknown>)
      return jsonResponse(200, { choices: [] })
    }

    // OpenAI refuses `max_tokens` on every reasoning model it sells, so a probe carrying it would
    // report a healthy account as broken.
    const openAi = harness({
      row: accountRow({ provider: "openai-api", dialect: "openai-chat" }),
      fetch: capture,
    })
    await openAi.service.test("acc-1", { model: "gpt-5" })

    // …and a vendor that never adopted the new name would drop the field and ignore the ceiling.
    const openRouter = harness({ row: accountRow({ provider: "openrouter" }), fetch: capture })
    await openRouter.service.test("acc-1", { model: "gpt-4o" })

    expect(sent[0]).toHaveProperty("max_completion_tokens", 1)
    expect(sent[0]).not.toHaveProperty("max_tokens")
    expect(sent[1]).toHaveProperty("max_tokens", 1)
    expect(sent[1]).not.toHaveProperty("max_completion_tokens")
  })

  test("an anthropic-dialect probe keeps max_tokens: the dialect requires that field", async () => {
    let sent: Record<string, unknown> = {}
    const { service } = harness({
      fetch: async (request) => {
        sent = JSON.parse(await request.text()) as Record<string, unknown>
        return jsonResponse(200, { id: "msg_1", content: [] })
      },
    })

    await service.test("acc-1", { model: "glm-4.7" })

    expect(sent).toHaveProperty("max_tokens", 1)
    expect(sent).not.toHaveProperty("max_completion_tokens")
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
        return { ok: true, message: "pong", rateLimitInfos: [] }
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
    const seen: SdkTestProbeInput[] = []
    const probe: SdkTestProbe = {
      run: async (input): Promise<SdkTestProbeResult> => {
        seen.push(input)
        return { ok: true, message: "pong", rateLimitInfos: [] }
      },
    }
    const { service, audited } = harness({ row: subscriptionRow(), sdkProbe: probe })

    const result = await service.test("acc-1", { model: "claude-sonnet-4-5", confirmed: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.outcome).toBe("ok")
    expect(result.value.message).toBe("pong")
    expect(audited).toHaveLength(1)
    // The account id is what the probe's per-Account subprocess slot is taken under: without it the
    // gate would bound every "Test now" press as if it were the same Account.
    expect(seen.map((input) => input.accountId)).toEqual(["acc-1"])
    expect(seen[0]?.configDir).toBe("/data/claude/acc-1")
  })

  test("reports the probe's own failure verbatim", async () => {
    const probe: SdkTestProbe = {
      run: async () => ({
        ok: false,
        message: "the account's Claude subscription window is spent",
        rateLimitInfos: [],
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
    const probe: SdkTestProbe = {
      run: async () => ({ ok: true, message: "pong", rateLimitInfos: [] }),
    }
    const bare = accountRow({ provider: "anthropic-oauth", authMaterial: null, configDir: null })
    const { service } = harness({ row: bare, sdkProbe: probe })

    const result = await service.test("acc-1", { model: "claude-sonnet-4-5", confirmed: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.outcome).toBe("failed")
    expect(result.value.message).toContain("no config directory")
  })
})

/**
 * What the billed turn is worth beyond a yes/no.
 *
 * The SDK volunteers `rate_limit_event` on every query, so the probe already holds the account's
 * live window state by the time it answers. Two hops have to happen for that to be worth anything,
 * and the first version of this fix only did the first: ingest it into the quota store, **and** fold
 * the resulting signal into the health store — which is what `availability.ts` builds the console's
 * view from. A reading that stops at the quota store is a reading nothing renders.
 */
describe("createTestNowService — what a Claude subscription's turn reports back", () => {
  const subscription = () =>
    accountRow({ provider: "anthropic-oauth", configDir: "/data/claude/a" })

  function probeReturning(result: Partial<SdkTestProbeResult>): SdkTestProbe {
    return {
      run: async (_input: SdkTestProbeInput) => ({
        ok: true,
        message: "pong",
        rateLimitInfos: [],
        ...result,
      }),
    }
  }

  test("the turn's quota reading reaches the health store the console reads", async () => {
    const reading = {
      status: "allowed",
      rateLimitType: "five_hour",
      // Epoch SECONDS, as the SDK actually sends them.
      resetsAt: Math.floor(NOW.getTime() / 1000) + 3_600,
    }
    const { service, folded } = harness({
      row: subscription(),
      sdkProbe: probeReturning({ rateLimitInfos: [reading] }),
    })

    const result = await service.test(subscription().id, { model: "claude-x", confirmed: true })

    expect(result.ok).toBe(true)
    expect(folded).toHaveLength(1)
    expect(folded[0]?.accountId).toBe(subscription().id)
    // The window is carried through with the provider's own instant, not an estimate of ours.
    const window = folded[0]?.signal?.quotaWindows?.find((w) => w.window === "five_hour")
    expect(window?.resetsAt).toEqual(new Date(NOW.getTime() + 3_600_000))
    expect(window?.resetSource).toBe("provider-reported")
  })

  test("a turn that reported no windows folds nothing rather than an empty reading", async () => {
    const { service, folded } = harness({
      row: subscription(),
      sdkProbe: probeReturning({ rateLimitInfos: [] }),
    })

    await service.test(subscription().id, { model: "claude-x", confirmed: true })

    // Not `applyRateLimit(id, null)`: claiming "this account reported no limits" is a different
    // statement from "this turn carried no reading", and the store would act on the first.
    expect(folded).toHaveLength(0)
  })

  test("a failed test is logged, so an unrecognized upstream reason is not lost", async () => {
    const { service, warnings } = harness({
      row: subscription(),
      sdkProbe: {
        run: async () => ({
          ok: false,
          message: "the account's Claude subscription window is spent",
          rateLimitInfos: [],
        }),
      },
    })

    await service.test(subscription().id, { model: "claude-x", confirmed: true })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.msg).toBe("account test failed")
    expect(warnings[0]?.fields).toMatchObject({
      provider: "anthropic-oauth",
      reason: "the account's Claude subscription window is spent",
    })
  })

  test("a successful test logs nothing — the response already said so", async () => {
    const { service, warnings } = harness({
      row: subscription(),
      sdkProbe: probeReturning({}),
    })

    await service.test(subscription().id, { model: "claude-x", confirmed: true })

    expect(warnings).toHaveLength(0)
  })
})
