import { expect, test } from "bun:test"
import { createLogger } from "../../../src/logging/logger"
import { createSdkConcurrency, createSdkInvoker } from "../../../src/providers"
import { UpstreamAdmissionRefused } from "../../../src/providers/upstream-admission"
import { createHealthStore, planCandidates } from "../../../src/services/dataplane"
import { type ChainContext, runChain } from "../../../src/services/dataplane/chain"
import type { HealthStore } from "../../../src/services/dataplane/health"
import type { RecoveryAttempt } from "../../../src/services/dataplane/recovery-access"
import { createRuntime, type RuntimeInput } from "../../../src/services/dataplane/runtime"
import type { RoutableAccount } from "../../../src/services/dataplane/types"
import { candidate } from "../routing/fixtures"
import { account, catalog, cipher, clock, subscriptionAccount } from "./fixtures"

const body = new TextEncoder().encode(
  JSON.stringify({ model: "claude", max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
)

function chain(
  upstream: RoutableAccount,
  options: {
    readonly halfOpen?: boolean
    readonly health?: HealthStore
    readonly awaitsPermit?: () => boolean
    readonly beforeUpstreamStart?: () => void
    readonly invokeSdk?: RuntimeInput["invokeSdk"]
  } = {},
) {
  const c = catalog([upstream])
  const plan = planCandidates(
    [candidate(upstream.snapshot, 0, { halfOpen: options.halfOpen ?? false })],
    c,
    "anthropic",
    "messages",
  )
  const lines: Record<string, unknown>[] = []
  const log = createLogger({
    level: "info",
    write: (line) => {
      lines.push(JSON.parse(line))
    },
  }).child({ requestId: "req-1" })
  let started = false
  let bodies = 0
  const attempt: RecoveryAttempt = {
    designated: true,
    ...(options.awaitsPermit === undefined ? {} : { awaitsPermit: options.awaitsPermit }),
    started: () => started,
    beforeUpstreamStart: () => {
      options.beforeUpstreamStart?.()
      started = true
    },
    finish: () => {},
  }
  const runtime = createRuntime({
    health: options.health ?? createHealthStore({ jitter: () => 0 }),
    cipher: cipher(),
    call: async () => {
      throw new Error("must not fetch")
    },
    ...(options.invokeSdk === undefined ? {} : { invokeSdk: options.invokeSdk }),
    sessionKeySource: "fingerprint",
    clock: clock(),
    timeoutMs: 10,
    record: () => {},
    correlationId: crypto.randomUUID(),
    clientRequestId: null,
    apiKeyId: crypto.randomUUID(),
    sessionKey: "session",
    model: "claude",
    ingressDialect: "anthropic",
    operation: "messages",
    requestStarted: 0,
    recovery: {
      quotaStaleAfterMs: 1000,
      catalog: c,
      currentSnapshot: () => upstream.snapshot,
      hint: () => {},
      prepare: () => attempt,
      forget: () => {},
    },
  })
  const context: ChainContext = {
    runtime,
    plan: plan.servable,
    request: new Request("http://router.test", { method: "POST" }),
    bodyBytes: body,
    modelSpan: null,
    translation: { created: 0, model: "claude", fallbackId: "test" },
    translated: {
      includeUsage: () => false,
      clientStreams: () => false,
      promptCacheKey: () => undefined,
      surfaceDropped: () => [],
      bodyFor: () => {
        bodies += 1
        return body
      },
    },
    failover: undefined,
    log,
  }
  const drops = () =>
    lines.filter((line) => line.msg === "candidate dropped without an upstream attempt")
  return { run: () => runChain(context), drops, bodies: () => bodies }
}

test("a recovery admission refusal leaves an info line naming the account and reason", async () => {
  const f = chain(account("a"), {
    beforeUpstreamStart: () => {
      throw new UpstreamAdmissionRefused()
    },
  })
  await expect(f.run()).rejects.toMatchObject({ status: 429 })
  expect(f.drops()).toEqual([
    expect.objectContaining({
      level: "info",
      requestId: "req-1",
      accountId: "a",
      attempt: 1,
      reason: "recovery-admission-refused",
    }),
  ])
})

test("a refused half-open probe leaves an info line, not a debug one", async () => {
  const health = createHealthStore({ jitter: () => 0 })
  const refusing: HealthStore = {
    ...health,
    admitProbe: () => ({ admitted: false, held: false }),
  }
  const f = chain(account("a"), { halfOpen: true, health: refusing })
  await expect(f.run()).rejects.toMatchObject({ status: 429 })
  expect(f.drops()).toEqual([
    expect.objectContaining({
      level: "info",
      accountId: "a",
      reason: "half-open-probe-in-flight",
    }),
  ])
})

test("an SDK preparation failure leaves an info line with only a class, never a message", async () => {
  const invokeSdk = createSdkInvoker({
    concurrency: createSdkConcurrency({ global: 1, perAccount: 1 }),
    resolveCli: () => ({ ok: false, attempts: [] }),
    runQuery: () => {
      throw new Error("must not invoke SDK")
    },
  })
  const f = chain(subscriptionAccount("a"), { invokeSdk })
  await expect(f.run()).rejects.toMatchObject({ status: 503 })
  const [drop] = f.drops()
  expect(drop).toMatchObject({ level: "info", accountId: "a", reason: "preparation-failed" })
  expect(typeof drop?.errorClass).toBe("string")
  expect(Object.keys(drop ?? {})).not.toContain("error")
  expect(f.drops()).toHaveLength(1)
})

test("a candidate with no permit is dropped before its body is built, and named once per request", async () => {
  // A request waiting out a recovery polls the chain every 250 ms. Each poll built the body and
  // prepared the whole turn to be refused at the start guard: 120-165 ms of work per 429, 20 lines.
  let launches = 0
  const f = chain(subscriptionAccount("a"), {
    awaitsPermit: () => true,
    invokeSdk: async () => {
      launches += 1
      throw new Error("must not launch")
    },
  })
  await expect(f.run()).rejects.toMatchObject({ status: 429 })
  await expect(f.run()).rejects.toMatchObject({ status: 429 })

  expect(launches).toBe(0)
  expect(f.bodies()).toBe(0)
  expect(f.drops()).toHaveLength(1)
})

test("the drop is asked per poll: a permit that arrived is used", async () => {
  let waiting = true
  let launches = 0
  const f = chain(subscriptionAccount("a"), {
    awaitsPermit: () => waiting,
    invokeSdk: async (input) => {
      launches += 1
      input.beforeUpstreamStart?.()
      input.onUpstreamStarted?.()
      return Response.json({}, { status: 503 })
    },
  })
  await expect(f.run()).rejects.toMatchObject({ status: 429 })
  waiting = false
  await f.run().catch(() => undefined)

  expect(launches).toBe(1)
})
