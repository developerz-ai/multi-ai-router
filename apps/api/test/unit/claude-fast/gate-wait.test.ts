import { describe, expect, test } from "bun:test"
import {
  createSdkConcurrency,
  createSdkWaitBudget,
  SdkGateWaitExpiredError,
} from "../../../src/providers"
import { createFastInvoker } from "../../../src/providers/claude-fast/invoker"
import type { SdkInvocation } from "../../../src/providers/claude-sdk/invoke"
import type { SdkAttemptInput } from "../../../src/services/dataplane/sdk-attempt"
import { invocationFailure } from "../../../src/services/dataplane/sdk-attempt-failure"
import { manualGateClock, turns } from "../claude-sdk/manual-gate-clock"

/**
 * The fast transport and the bounded gate wait (`CLAUDE_SDK_QUEUE_WAIT_MS`).
 *
 * The fast invoker takes the same two-gate slot the SDK path does, with the request's one budget,
 * and its pre-inference fallback to the SDK draws on what is left of that budget. Its refusal must
 * reach the attempt as the typed `SdkGateWaitExpiredError`, never wrapped as a `FastTransportError`
 * (a 502): the throw below is returned, not awaited, inside the invoker's `try`, which is the only
 * reason it is not caught there.
 */

const WAIT_MS = 60_000
const credential = {
  accessToken: "selected-account-secret",
  expiresAt: Number.MAX_SAFE_INTEGER,
  deviceId: "a".repeat(64),
  accountUuid: "11111111-1111-4111-8111-111111111111",
}

function invocation(budget: ReturnType<typeof createSdkWaitBudget>): SdkInvocation {
  return {
    accountId: "account",
    configDir: "/isolated/account",
    apiKeyId: "key",
    sessionKey: "session",
    model: "claude-opus-5",
    body: Buffer.from(
      JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    ),
    signal: new AbortController().signal,
    session: { kind: "fresh", reason: "no-session" },
    queueWait: budget,
  }
}

function harness(options: { readonly cold: boolean; readonly onFallback?: () => void }) {
  const time = manualGateClock()
  const concurrency = createSdkConcurrency(
    { global: 4, perAccount: 1 },
    { now: time.now, timer: time.timer },
  )
  const sdkCalls: SdkInvocation[] = []
  const invoke = createFastInvoker({
    concurrency,
    errorMaxBytes: 4096,
    credential: async () => (options.cold ? null : credential),
    resolveModel: () => "claude-opus-5",
    // The SDK transport's own acquire, as `providers/claude-sdk/invoker.ts` makes it.
    sdk: async (input) => {
      sdkCalls.push(input)
      const slot = await concurrency.acquire(input.accountId, input.signal, input.queueWait)
      slot.release()
      return new Response("sdk")
    },
    ...(options.onFallback === undefined ? {} : { onFallback: options.onFallback }),
    fetch: async () => new Response("unreachable", { status: 500 }),
  })
  return { time, concurrency, invoke, sdkCalls }
}

describe("the fast invoker at a full gate", () => {
  test("a full account gate refuses the budgeted request with the typed error, unwrapped", async () => {
    const { time, concurrency, invoke } = harness({ cold: false })
    const holder = await concurrency.acquire("account", new AbortController().signal)
    const budget = createSdkWaitBudget(WAIT_MS)

    const outcome = invoke(invocation(budget)).then(
      () => new Error("answered"),
      (error: unknown) => error,
    )
    await turns()
    expect(concurrency.queued).toBe(1)
    time.advance(WAIT_MS)

    const error = await outcome
    expect(error).toBeInstanceOf(SdkGateWaitExpiredError)
    expect((error as SdkGateWaitExpiredError).half).toBe("account")
    expect(budget.remaining()).toBe(0)
    holder.release()
    expect(concurrency.inFlight).toBe(0)
  })

  test("the cold-credential fallback draws on what is left of the same budget and ends as account-full", async () => {
    const holder: { release?: () => void } = {}
    const interloper: { release?: () => void } = {}
    const h = harness({
      cold: true,
      // Fires after the fast path gave its slot back and before the SDK asks for one: the account
      // is taken again by another request, so the fallback finds the gate full.
      onFallback: () => {
        void h.concurrency.acquire("account", new AbortController().signal).then((slot) => {
          interloper.release = slot.release
        })
      },
    })
    holder.release = (await h.concurrency.acquire("account", new AbortController().signal)).release
    const budget = createSdkWaitBudget(WAIT_MS)

    const outcome = h.invoke(invocation(budget)).then(
      () => new Error("answered"),
      (error: unknown) => error,
    )
    await turns()
    // 40 s queued behind the holder on the fast path's own acquire...
    h.time.advance(40_000)
    holder.release?.()
    await turns(12)
    expect(budget.remaining()).toBe(20_000)
    // ...leaves 20 s for the fallback, which finds the interloper and queues on the same budget.
    expect(h.sdkCalls).toHaveLength(1)
    expect(h.sdkCalls[0]?.queueWait).toBe(budget)
    expect(h.concurrency.queued).toBe(1)
    h.time.advance(20_000)

    const error = await outcome
    expect(error).toBeInstanceOf(SdkGateWaitExpiredError)
    expect(budget.remaining()).toBe(0)

    // The attempt reads that throw as the router's own verdict, not as a transport failure.
    const failed = invocationFailure(
      error,
      { gateWait: { budget, retryAfterSeconds: 30 } } as unknown as SdkAttemptInput,
      {} as never,
      null,
      new AbortController().signal,
    )
    expect(failed.kind).toBe("failure")
    if (failed.kind === "failure") expect(failed.failure.kind).toBe("account-full")
    interloper.release?.()
    expect(h.concurrency.inFlight).toBe(0)
  })
})
