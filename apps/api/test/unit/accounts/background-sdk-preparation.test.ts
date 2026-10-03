import { expect, test } from "bun:test"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { createSdkConcurrency } from "../../../src/providers/claude-sdk/concurrency"
import type { OwnerLaunch } from "../../../src/providers/claude-sdk/owner-launch"
import {
  createSdkTestProbe,
  type SdkTestProbeOptions,
} from "../../../src/providers/claude-sdk/test-probe"
import { UpstreamAdmissionRefused } from "../../../src/providers/upstream-admission"
import { createTestNowService } from "../../../src/services/accounts/test-now"
import { accountRow } from "../../support/account-row"

const NOW = new Date("2026-10-03T00:00:00Z")
type Mode =
  | "missing-cli"
  | "freshness"
  | "queue-abort"
  | "owner-setup"
  | "owner-ready"
  | "owner-prepare"
  | "query-setup"
  | "final-guard"
  | "provider-error"
function fixture(mode: Mode) {
  const account = accountRow({ provider: "anthropic-oauth", configDir: "/offline-fixture" })
  const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
  let audits = 0,
    quotaWrites = 0,
    healthWrites = 0,
    activations = 0,
    cancellations = 0,
    guards = 0
  const rejectedReady = Promise.reject(new Error("guardian readiness refused"))
  void rejectedReady.catch(() => {})
  const owner: OwnerLaunch = {
    spawn: () => {
      throw new Error("test must never spawn a process")
    },
    ready: mode === "owner-ready" ? rejectedReady : Promise.resolve(),
    exited: Promise.resolve(),
    started: Promise.resolve(),
    prepare: async () => {
      if (mode === "owner-prepare") throw new Error("guardian preparation refused")
    },
    assertReady: () => {},
    activate: () => {
      activations++
    },
    release: () => {},
    cancel: () => {
      cancellations++
    },
  }
  const runQuery: NonNullable<SdkTestProbeOptions["runQuery"]> = () => {
    if (mode === "query-setup") throw new Error("SDK constructor failed")
    return (async function* () {
      if (mode !== "provider-error")
        throw new Error("preparation unexpectedly reached provider iteration")
      yield {
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed_warning" },
      } as SDKMessage
      throw new Error("offline provider failed after activation")
    })()
  }
  const probe = createSdkTestProbe({
    cliPathOverride: null,
    concurrency,
    resolveCli: () =>
      mode === "missing-cli"
        ? { ok: false, attempts: [] }
        : { ok: true, path: "/offline/claude", source: "env_override", bytes: 1000000 },
    freshness: {
      wouldRefresh: async () => false,
      ensureFresh: async () => {
        if (mode === "freshness") throw new Error("offline freshness unavailable")
      },
    },
    ownerLaunch: () => {
      if (mode === "owner-setup") throw new Error("owner factory failed")
      return owner
    },
    runQuery,
  })
  const service = createTestNowService({
    accounts: { findById: async () => account },
    cipher: { decrypt: () => "unused" },
    audit: {
      record: async () => {
        audits++
      },
    },
    now: () => NOW,
    cooldownSeconds: 30,
    timeoutMs: mode === "queue-abort" ? 5 : 1000,
    sdkProbe: probe,
    createBackgroundStartGuard: () => async () => {
      if (++guards === 2 && mode === "final-guard") throw new UpstreamAdmissionRefused()
    },
    quota: {
      ingest: () => {
        quotaWrites++
        return null
      },
    },
    health: {
      applyRateLimit: () => {
        healthWrites++
      },
    },
  })
  return {
    service,
    account,
    concurrency,
    counts: () => ({ audits, quotaWrites, healthWrites, activations, cancellations, guards }),
  }
}

for (const mode of [
  "missing-cli",
  "freshness",
  "queue-abort",
  "owner-setup",
  "owner-ready",
  "owner-prepare",
  "query-setup",
  "final-guard",
] as const) {
  test(`background SDK preparation ${mode} does not record a paid test or quota`, async () => {
    const f = fixture(mode)
    const held =
      mode === "queue-abort"
        ? await f.concurrency.acquire(f.account.id, new AbortController().signal)
        : undefined
    try {
      const result = await f.service.test(f.account.id, {
        model: "offline-model",
        confirmed: true,
        backgroundExpectedAccount: f.account,
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.failure.code).toBe("background_admission_refused")
      expect(f.service.lastCheckedAt(f.account.id)).toBeNull()
      expect(f.counts()).toMatchObject({
        audits: 0,
        quotaWrites: 0,
        healthWrites: 0,
        activations: 0,
      })
    } finally {
      held?.release()
    }
    expect(f.concurrency.inFlight).toBe(0)
    expect(f.concurrency.queued).toBe(0)
  })
}

test("provider failure after background activation records a real failed test and volunteered quota", async () => {
  const f = fixture("provider-error")
  const result = await f.service.test(f.account.id, {
    model: "offline-model",
    confirmed: true,
    backgroundExpectedAccount: f.account,
  })
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.value).toMatchObject({ tested: true, outcome: "failed" })
  expect(f.service.lastCheckedAt(f.account.id)).toEqual(NOW)
  expect(f.counts()).toMatchObject({ audits: 1, quotaWrites: 1, activations: 1, guards: 2 })
  expect(f.concurrency.inFlight).toBe(0)
})
