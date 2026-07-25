import { describe, expect, test } from "bun:test"
import { NoHealthyAccountError } from "@multi-ai-router/core"
import { claudeSdkDriver, type SdkInvocation } from "../../../src/providers"
import {
  planCandidates,
  resolveEgress,
  runSdkAttempt,
  type SdkServableCandidate,
} from "../../../src/services/dataplane"
import type { Candidate } from "../../../src/services/routing"
import { account, catalog, subscriptionAccount } from "./fixtures"

/**
 * The Agent-SDK transport seam: a Claude subscription is *planned*, not refused.
 *
 * Three properties matter here and each has a rule behind it. The plan carries a config directory
 * instead of a URL, because that directory is the whole multi-account mechanism
 * (docs/idea/11-anthropic-agent-sdk.md §3). The re-synthesis target is the driver's dialect and
 * never the account's pinned surface, because the SDK is rendered into Anthropic Messages once and
 * every other ingress reuses an ordinary translator (§6). And a chain may mix transports, so one
 * misconfigured subscription account must not take the HTTP accounts beside it down with it.
 */

function candidateFor(id: string, model = "claude-opus-5"): Candidate {
  return {
    account: {
      id,
      label: id,
      provider: "anthropic-oauth",
      status: "active",
      weight: 100,
      priority: 0,
      health: { consecutiveFailures: 0, inFlight: 0, recentTokens: 0 },
    },
    poolId: null,
    weight: 100,
    priority: 0,
    order: 0,
    upstreamModel: model,
    halfOpen: false,
  }
}

describe("the Agent-SDK egress decision", () => {
  test("an Anthropic client needs no conversion, and is still not a passthrough", () => {
    const decision = resolveEgress("anthropic", subscriptionAccount("sub"))

    expect(decision.mode).toBe("agent-sdk")
    if (decision.mode !== "agent-sdk") return
    expect(decision.to).toBe("anthropic")
    // Null means "nothing to convert", not "forward the bytes": the SDK yields message objects and
    // the body is read either way.
    expect(decision.pair).toBeNull()
  })

  test("another ingress dialect reuses the ordinary translator toward Anthropic", () => {
    const decision = resolveEgress("openai-chat", subscriptionAccount("sub"))

    expect(decision.mode).toBe("agent-sdk")
    if (decision.mode !== "agent-sdk") return
    expect(decision.from).toBe("openai-chat")
    expect(decision.to).toBe("anthropic")
    expect(decision.pair?.ingress).toBe("openai-chat")
    expect(decision.pair?.egress).toBe("anthropic")
  })

  test("an account pinning another surface does not move the re-synthesis target", () => {
    const decision = resolveEgress(
      "openai-chat",
      subscriptionAccount("sub", { dialect: "openai-chat" }),
    )

    expect(decision.mode).toBe("agent-sdk")
    if (decision.mode !== "agent-sdk") return
    expect(decision.to).toBe("anthropic")
  })
})

describe("planning a subscription attempt", () => {
  test("carries the config directory, not a URL, and records the SDK egress mode", () => {
    const entry = subscriptionAccount("sub", { configDir: "/data/accounts/sub" })
    const plan = planCandidates([candidateFor("sub")], catalog([entry]), "anthropic")

    expect(plan.servable).toHaveLength(1)
    const servable = plan.servable[0]
    expect(servable?.kind).toBe("sdk")
    if (servable?.kind !== "sdk") return
    expect(servable.configDir).toBe("/data/accounts/sub")
    expect(servable.egressMode).toBe("agent-sdk")
    expect(servable.dialect).toBe("anthropic")
  })

  test("the account's alias map still decides the model the SDK is asked for", () => {
    const entry = subscriptionAccount("sub", { modelAliases: { sonnet: "claude-sonnet-4-6" } })
    const plan = planCandidates([candidateFor("sub", "sonnet")], catalog([entry]), "anthropic")

    expect(plan.servable[0]?.upstreamModel).toBe("claude-sonnet-4-6")
  })

  test("a subscription account with no config directory is unservable and names itself", () => {
    const entry = { ...subscriptionAccount("sub"), configDir: null }
    const plan = planCandidates([candidateFor("sub")], catalog([entry]), "anthropic")

    expect(plan.servable).toHaveLength(0)
    expect(plan.endpointError).toBeInstanceOf(NoHealthyAccountError)
    expect(plan.endpointError?.message).toContain("sub")
    // The failure is about the account, so it must not read as a bad request from the caller.
    expect(plan.endpointError?.status).toBe(503)
  })

  test("one misconfigured subscription does not take the HTTP accounts beside it down", () => {
    const broken = { ...subscriptionAccount("sub"), configDir: null }
    const healthy = account("api-1", { provider: "anthropic-api" })
    const candidates = [candidateFor("sub"), { ...candidateFor("api-1"), order: 1 }]

    const plan = planCandidates(candidates, catalog([broken, healthy]), "anthropic")

    expect(plan.servable).toHaveLength(1)
    expect(plan.servable[0]?.kind).toBe("http")
    expect(plan.endpointError).toBeInstanceOf(NoHealthyAccountError)
  })
})

const SDK_PLAN: SdkServableCandidate = {
  kind: "sdk",
  candidate: candidateFor("sub"),
  account: subscriptionAccount("sub"),
  driver: claudeSdkDriver,
  dialect: "anthropic",
  configDir: "/data/accounts/sub",
  upstreamModel: "claude-sonnet-4-6",
  translation: null,
  egressMode: "agent-sdk",
}

describe("running a subscription attempt", () => {
  test("hands the invoker the account's own directory, model, and body", async () => {
    const seen: SdkInvocation[] = []
    const outcome = await runSdkAttempt({
      plan: SDK_PLAN,
      body: new TextEncoder().encode('{"model":"claude-sonnet-4-6"}'),
      invoke: async (invocation) => {
        seen.push(invocation)
        return new Response('{"type":"message"}', { status: 200 })
      },
      session: undefined,
      timeoutMs: 1_000,
    })

    expect(outcome.kind).toBe("success")
    expect(seen).toHaveLength(1)
    expect(seen[0]?.configDir).toBe("/data/accounts/sub")
    expect(seen[0]?.accountId).toBe("sub")
    expect(seen[0]?.model).toBe("claude-sonnet-4-6")
    expect(seen[0]?.signal.aborted).toBe(false)
    // Quota state rides the query stream as `rate_limit_event`, never an HTTP header.
    if (outcome.kind !== "success") return
    expect(outcome.rateLimit).toBeNull()
  })

  test("no transport wired fails the attempt by name, and retryably", async () => {
    const outcome = await runSdkAttempt({
      plan: SDK_PLAN,
      body: null,
      invoke: undefined,
      session: undefined,
      timeoutMs: 1_000,
    })

    expect(outcome.kind).toBe("failure")
    if (outcome.kind !== "failure") return
    // Retryable, so an HTTP account later in the same pool still serves the request.
    expect(outcome.failure.kind).toBe("server-error")
    expect(outcome.failure.message).toContain("Agent SDK")
    // Nothing answered, so there is no provider body to relay back.
    expect(outcome.upstream).toBeNull()
    expect(outcome.classification).toBeNull()
  })

  test("an aborted invocation is a timeout, not a mystery server error", async () => {
    const outcome = await runSdkAttempt({
      plan: SDK_PLAN,
      body: null,
      invoke: () => Promise.reject(new DOMException("aborted", "AbortError")),
      session: undefined,
      timeoutMs: 1_000,
    })

    expect(outcome.kind).toBe("failure")
    if (outcome.kind !== "failure") return
    expect(outcome.failure.kind).toBe("timeout")
  })

  test("the client's disconnect reaches the subprocess through one composed signal", async () => {
    const client = new AbortController()
    let signal: AbortSignal | undefined
    await runSdkAttempt({
      plan: SDK_PLAN,
      body: null,
      invoke: async (invocation) => {
        signal = invocation.signal
        return new Response(null, { status: 200 })
      },
      session: undefined,
      timeoutMs: 60_000,
      signal: client.signal,
    })

    expect(signal?.aborted).toBe(false)
    client.abort()
    expect(signal?.aborted).toBe(true)
  })
})

describe("the subscription driver", () => {
  test("refuses to fall back to a shared config directory", () => {
    expect(() => claudeSdkDriver.resolveConfigDir({ id: "sub", configDir: null })).toThrow(
      NoHealthyAccountError,
    )
    // Whitespace is not a directory either — a blank setting must not resolve to the CLI's default,
    // which would run every account against one credential store.
    expect(() => claudeSdkDriver.resolveConfigDir({ id: "sub", configDir: "   " })).toThrow(
      NoHealthyAccountError,
    )
  })

  test("declares the one surface it renders and the auth style it holds", () => {
    expect(claudeSdkDriver.id).toBe("anthropic-oauth")
    expect(claudeSdkDriver.dialect).toBe("anthropic")
    expect(claudeSdkDriver.authKind).toBe("oauth")
  })
})
