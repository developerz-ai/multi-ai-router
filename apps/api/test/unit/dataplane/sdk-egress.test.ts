import { describe, expect, test } from "bun:test"
import { NoHealthyAccountError } from "@multi-ai-router/core"
import type { Logger } from "../../../src/logging/logger"
import {
  claudeSdkDriver,
  type SdkInvocation,
  type SessionPlan,
  type SessionStore,
} from "../../../src/providers"
import {
  planCandidates,
  resolveEgress,
  runSdkAttempt,
  type SdkServableCandidate,
  type SdkSessionContext,
} from "../../../src/services/dataplane"
import { type Candidate, HEALTHY, isRetryable, recordFailure } from "../../../src/services/routing"
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

/** A store that records what selection asked of it, and hands back the plan the test wants. */
function sessionDouble(plan: SessionPlan): {
  readonly context: SdkSessionContext
  readonly invalidated: string[]
} {
  const invalidated: string[] = []
  const store: SessionStore = {
    binding: () => Promise.resolve(undefined),
    invalidate: (apiKeyId, sessionKey) => invalidated.push(`${apiKeyId}::${sessionKey}`),
    resolve: () => ({ plan, remember: () => {}, release: () => {} }),
  }
  return {
    context: { store, apiKeyId: "key-1", sessionKey: "sess-1", keySource: "header" },
    invalidated,
  }
}

const NOW = new Date("2026-09-06T00:00:00.000Z")

function rejectingAttempt(error: unknown, session?: SdkSessionContext) {
  return runSdkAttempt({
    plan: SDK_PLAN,
    body: null,
    invoke: () => Promise.reject(error),
    session,
    timeoutMs: 1_000,
  })
}

describe("what a subscription failure is read as", () => {
  test("an expired credential reaches the breaker as auth, not as a mystery 5xx", async () => {
    const outcome = await rejectingAttempt(new Error("OAuth token has expired"))

    expect(outcome.kind).toBe("failure")
    if (outcome.kind !== "failure") return
    // `auth` on an oauth account is what marks it `needs_reauth` and drops it from routing.
    expect(outcome.failure.kind).toBe("auth")
    expect(outcome.classification?.signal).toBe("claude-sdk:credential-expired")
    // Nothing answered over HTTP, so there is no provider body to relay.
    expect(outcome.upstream).toBeNull()
  })

  test("a spent window is rate limited, so the client gets a 429 rather than a 503", async () => {
    const outcome = await rejectingAttempt(new Error("Claude AI usage limit reached"))

    expect(outcome.kind).toBe("failure")
    if (outcome.kind !== "failure") return
    expect(outcome.failure.kind).toBe("rate-limited")
    expect(outcome.classification?.kind).toBe("rate-limited")
  })

  test("a crash leaves the next account free to serve, and counts toward this one's streak", async () => {
    const outcome = await rejectingAttempt(new Error("Claude Code process exited with code 1"))

    expect(outcome.kind).toBe("failure")
    if (outcome.kind !== "failure") return
    // Ambiguous by nature — a dead subprocess may be the account's config directory or may be this
    // one request — so it is counted rather than exempted, and the threshold decides.
    expect(outcome.failure.kind).toBe("server-error")
    expect(recordFailure(HEALTHY, outcome.failure, NOW).consecutiveFailures).toBe(1)
  })

  /**
   * The cooldown cascade of 2026-09-06. A busy session reached the breaker as `server-error`, so
   * three in a row on one account parked a subscription that was answering fine — and under an
   * agent workload they arrive fast and land on account after account, walking a healthy pool into
   * a cooldown that answers the next caller as though there were no capacity.
   */
  test("a busy session moves on without blaming the account it left", async () => {
    const outcome = await rejectingAttempt(
      new Error("Session 4f2b is currently running as a background agent"),
    )

    expect(outcome.kind).toBe("failure")
    if (outcome.kind !== "failure") return
    expect(outcome.failure.kind).toBe("busy-session")
    // Retryable: the next candidate gets its turn, the SDK transport having already spent its own
    // in-place fork before the chain saw this.
    expect(isRetryable(outcome.failure.kind)).toBe(true)

    // And blameless: three of them in a row leave the account exactly where they found it.
    let state = HEALTHY
    for (let at = 0; at < 3; at += 1) state = recordFailure(state, outcome.failure, NOW)
    expect(state).toEqual(HEALTHY)
  })

  test("the message a client may read is the router's, never the SDK's", async () => {
    const outcome = await rejectingAttempt(
      new Error("No conversation found with session ID /data/accounts/sub/sessions/4f2b"),
    )

    expect(outcome.kind).toBe("failure")
    if (outcome.kind !== "failure") return
    expect(outcome.failure.message).not.toContain("/data/accounts")
  })

  test("a stale session drops the binding that named it, so the replay starts fresh", async () => {
    const session = sessionDouble({
      kind: "resume",
      sdkSessionId: "sdk-1",
      lineage: "continuation",
      deltaFrom: 1,
    })

    const outcome = await rejectingAttempt(
      new Error("No conversation found with session ID: sdk-1"),
      session.context,
    )

    expect(outcome.kind).toBe("failure")
    if (outcome.kind !== "failure") return
    // The planner reads this kind by name and replays once on the *same* account.
    expect(outcome.failure.kind).toBe("stale-session")
    expect(session.invalidated).toEqual(["key-1::sess-1"])
  })

  test("a turn that resumed nothing has no binding to discredit", async () => {
    const session = sessionDouble({ kind: "fresh", reason: "no-session" })

    await rejectingAttempt(
      new Error("No conversation found with session ID: sdk-1"),
      session.context,
    )

    expect(session.invalidated).toEqual([])
  })

  test("a failure that is not the session's leaves the binding alone", async () => {
    const session = sessionDouble({
      kind: "resume",
      sdkSessionId: "sdk-1",
      lineage: "continuation",
      deltaFrom: 1,
    })

    await rejectingAttempt(new Error("Claude AI usage limit reached"), session.context)

    expect(session.invalidated).toEqual([])
  })
})

describe("a rendered error Response is a failed attempt, not a success to relay", () => {
  // The renderer answers a non-streaming turn that ended in an upstream `error` event with the
  // error's body under a real status (`render/stream.ts`) — and *no byte of it has reached the
  // client*. Wrapping it as a success recorded a win on the account, reset its failure streak,
  // and relayed the 502 while healthy candidates in the same pool sat unasked.
  const errorBody = JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } })

  test("a 502 body comes back as a retryable failure carrying the upstream's own answer", async () => {
    const outcome = await runSdkAttempt({
      plan: SDK_PLAN,
      body: null,
      invoke: async () =>
        new Response(errorBody, { status: 502, headers: { "content-type": "application/json" } }),
      session: undefined,
      timeoutMs: 1_000,
    })

    expect(outcome.kind).toBe("failure")
    if (outcome.kind !== "failure") return
    // `server-error` is retryable: the four healthy accounts beside this one get their turn.
    expect(outcome.failure.kind).toBe("server-error")
    expect(outcome.failure.status).toBe(502)
    // The body is kept, so the client can still hear the upstream's words if nobody else serves.
    expect(outcome.upstream?.status).toBe(502)
    expect(outcome.upstream?.bodyText).toBe(errorBody)
    // The router-authored sentence, never the upstream's own.
    expect(outcome.failure.message).not.toContain("boom")
  })

  test("a 200 stays a success — the streaming path is always one, by construction", async () => {
    const outcome = await runSdkAttempt({
      plan: SDK_PLAN,
      body: null,
      invoke: async () => new Response('{"type":"message"}', { status: 200 }),
      session: undefined,
      timeoutMs: 1_000,
    })

    expect(outcome.kind).toBe("success")
  })
})

describe("the truncated-turn alarm reaches the log", () => {
  // The render layer is pure and holds no logger, so `onTruncatedTurn` is worth nothing until this
  // seam turns it into a line an operator can see — with the account, on the request-scoped logger
  // that already stamps the request id, and carrying enough to say *which* early ending it was.
  function capturingLog(): { readonly log: Logger; readonly warned: Record<string, unknown>[] } {
    const warned: Record<string, unknown>[] = []
    const log: Logger = {
      debug: () => {},
      info: () => {},
      warn: (msg, fields) => void warned.push({ msg, ...fields }),
      error: () => {},
      child: () => log,
    }
    return { log, warned }
  }

  test("a truncated turn is warned about with the account and everything the renderer knew", async () => {
    const { log, warned } = capturingLog()
    await runSdkAttempt({
      plan: SDK_PLAN,
      body: null,
      invoke: async (invocation) => {
        invocation.onTruncatedTurn?.({
          blocks: 2,
          kinds: ["text", "tool_use"],
          lastMessage: "stream_event",
          lastEvent: "content_block_delta",
          sawResult: false,
          lastSystemSubtype: "init",
          sdkMessages: 7,
          frames: 5,
        })
        return new Response('{"type":"message"}', { status: 200 })
      },
      session: undefined,
      timeoutMs: 1_000,
      log,
    })

    // Every field, because the question this line exists to answer is which early ending it was:
    // the query iterator completing, a `result` landing mid-block, or the subprocess dying.
    expect(warned).toEqual([
      {
        msg: "sdk turn ended mid-answer; the client is told it is incomplete",
        accountId: "sub",
        blocks: 2,
        kinds: ["text", "tool_use"],
        lastMessage: "stream_event",
        lastEvent: "content_block_delta",
        sawResult: false,
        lastSystemSubtype: "init",
        sdkMessages: 7,
        frames: 5,
      },
    ])
  })

  test("a clean stream logs nothing, and no logger wired breaks nothing", async () => {
    const { log, warned } = capturingLog()
    await runSdkAttempt({
      plan: SDK_PLAN,
      body: null,
      invoke: async () => new Response('{"type":"message"}', { status: 200 }),
      session: undefined,
      timeoutMs: 1_000,
      log,
    })
    expect(warned).toEqual([])

    const bare = await runSdkAttempt({
      plan: SDK_PLAN,
      body: null,
      invoke: async (invocation) => {
        invocation.onForcedBlockClose?.(1)
        return new Response('{"type":"message"}', { status: 200 })
      },
      session: undefined,
      timeoutMs: 1_000,
    })
    expect(bare.kind).toBe("success")
  })
})

describe("what the lineage plan is told", () => {
  function recordingSession(): {
    readonly context: SdkSessionContext
    readonly resolved: { sessionGone?: boolean }[]
  } {
    const resolved: { sessionGone?: boolean }[] = []
    const store: SessionStore = {
      binding: () => Promise.resolve(undefined),
      invalidate: () => {},
      resolve: (input) => {
        resolved.push({
          ...(input.sessionGone === undefined ? {} : { sessionGone: input.sessionGone }),
        })
        return {
          plan: { kind: "fresh", reason: "no-session" },
          remember: () => {},
          release: () => {},
        }
      },
    }
    return {
      context: { store, apiKeyId: "key-1", sessionKey: "sess-1", keySource: "header" },
      resolved,
    }
  }

  test("the in-place replay after a stale session says the session is gone", async () => {
    const session = recordingSession()
    await runSdkAttempt({
      plan: SDK_PLAN,
      body: null,
      invoke: async () => new Response('{"type":"message"}', { status: 200 }),
      session: session.context,
      timeoutMs: 1_000,
      sessionGone: true,
    })

    expect(session.resolved).toEqual([{ sessionGone: true }])
  })

  test("an ordinary first attempt claims nothing about the session", async () => {
    const session = recordingSession()
    await runSdkAttempt({
      plan: SDK_PLAN,
      body: null,
      invoke: async () => new Response('{"type":"message"}', { status: 200 }),
      session: session.context,
      timeoutMs: 1_000,
    })

    expect(session.resolved).toEqual([{}])
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
