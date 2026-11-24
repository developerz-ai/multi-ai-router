/**
 * A recovering account is proved by its first model output. Before 2.77.0 the designated request
 * held the account's one permit until its stream ended, so every other request of a one-account pool
 * was answered a router-made `429` for minutes.
 */
import { describe, expect, test } from "bun:test"
import { credentialFingerprint } from "@multi-ai-router/db"
import { createHealthStore, planCandidates } from "../../../src/services/dataplane"
import { accountHealthFacts } from "../../../src/services/dataplane/health-observation"
import { createRelayHealth } from "../../../src/services/dataplane/relay-health"
import type { RelayVerdict } from "../../../src/services/dataplane/relay-terminal"
import { createRuntime } from "../../../src/services/dataplane/runtime"
import { candidate } from "../routing/fixtures"
import { account, catalog, cipher, clock, NOW } from "./fixtures"

const CLEAN: RelayVerdict = {
  outcome: "success",
  errorClass: null,
  failure: null,
  recovery: "succeeded",
}
const broke: RelayVerdict = {
  outcome: "upstream_error",
  errorClass: "upstream_error",
  failure: { kind: "connection", message: "reset" },
  recovery: "failed",
}

function relay(options: { readonly designated?: boolean; readonly limited?: boolean } = {}) {
  const upstream = account("a")
  const published: unknown[] = []
  const health = createHealthStore({
    jitter: () => 0,
    onBreaker: (_id, breaker) => void published.push(breaker),
  })
  const observation = health.captureAttempt("a", accountHealthFacts(upstream))
  const servable = planCandidates(
    [candidate(upstream.snapshot, 0, { halfOpen: options.designated ?? true })],
    catalog([upstream]),
    "anthropic",
  ).servable[0]
  if (servable === undefined) throw new Error("missing servable account")
  const finishes: string[] = []
  let released = 0
  const runtime = createRuntime({
    health,
    cipher: cipher(),
    call: async () => new Response(),
    sessionKeySource: "fingerprint",
    clock: clock(),
    timeoutMs: 1,
    record: () => {},
    correlationId: "c",
    clientRequestId: null,
    apiKeyId: "k",
    sessionKey: "s",
    model: "m",
    ingressDialect: "anthropic",
    operation: "messages",
    requestStarted: 0,
  })
  const subject = createRelayHealth({ runtime }, servable, {
    startedAt: NOW,
    started: 0,
    upstreamMs: 0,
    upstreamStarted: 0,
    observation,
    isRateLimited: () => options.limited ?? false,
    releaseProbe: () => {
      released += 1
    },
    ...(options.designated === false
      ? {}
      : {
          recovery: {
            designated: true,
            started: () => true,
            finish: (state: string) => void finishes.push(state),
          },
        }),
  })
  /** The breaker row this replica published, acknowledged as Postgres stored it. */
  const acknowledge = (revision: number) =>
    health.reconcile("a", {
      ...accountHealthFacts(upstream),
      breaker: {
        accountId: "a",
        revision,
        credentialFingerprint: credentialFingerprint(upstream.authMaterial),
        lifecycleVersion: 0,
        healthRecoveryVersion: 0,
        authRecoveryVersion: 0,
        status: "active",
        consecutiveFailures: 0,
        cooldownUntil: null,
        cooldownSource: "unknown",
        cooldownReason: null,
        probeHeldUntil: null,
      } as never,
    })
  return { subject, health, finishes, acknowledge, released: () => released, published }
}

describe("a designated probe", () => {
  test("settles succeeded and gives up its hold at the first model output, once", () => {
    const r = relay()
    r.subject.firstOutput()
    r.subject.firstOutput()

    expect(r.finishes).toEqual(["succeeded"])
    expect(r.released()).toBe(1)
    r.subject.settle(CLEAN)
    expect(r.finishes).toEqual(["succeeded"])
    expect(r.health.stateOf("a").breaker.status).toBe("active")
  })

  test("a stream that breaks after its output still strikes, even once the success was stored", () => {
    const r = relay()
    r.subject.firstOutput()
    r.acknowledge(1)
    r.subject.settle(broke)

    expect(r.finishes).toEqual(["succeeded"])
    expect(r.health.stateOf("a").breaker.consecutiveFailures).toBe(1)
  })

  test("a rate limit seen before the first output settles nothing early", () => {
    const r = relay({ limited: true })
    r.subject.firstOutput()
    expect(r.finishes).toEqual([])
    r.subject.settle(CLEAN)
    expect(r.finishes).toEqual(["failed"])
  })

  test("a stream that ends with no output settles at its end, as before", () => {
    const r = relay()
    r.subject.settle(broke)
    expect(r.finishes).toEqual(["failed"])
    expect(r.health.stateOf("a").breaker.status).toBe("cooling_down")
  })
})

test("an ordinary answer publishes its one success at its end, not at its first token", () => {
  const r = relay({ designated: false })
  r.subject.firstOutput()
  expect(r.published).toHaveLength(0)
  r.subject.settle(CLEAN)
  expect(r.published).toHaveLength(1)
})

test("an in-stream refusal of the request proves the account answered, and holds a refused model", () => {
  const r = relay()
  r.subject.settle({
    outcome: "client_error",
    errorClass: "x",
    failure: { kind: "model-unsupported", message: "no such model" },
    recovery: "succeeded",
  })
  expect(r.finishes).toEqual(["succeeded"])
  expect(r.health.stateOf("a").breaker.status).toBe("active")
})
