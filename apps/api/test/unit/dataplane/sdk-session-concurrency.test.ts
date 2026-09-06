import { describe, expect, test } from "bun:test"
import { createSessionStore, type SessionStore } from "../../../src/providers"
import {
  type AttemptOutcome,
  runSdkAttempt,
  type SdkServableCandidate,
  type SdkSessionContext,
} from "../../../src/services/dataplane"
import { subscriptionAccount } from "./fixtures"

/**
 * **Who owns the conversation while a turn is running**, asserted through `runSdkAttempt` against a
 * real session store rather than a double — because the property under test is precisely the one a
 * double cannot have: the claim is released by the answer's own body finishing, and a stub that
 * never produces a body would prove nothing.
 *
 * Production, 2026-09-06. opencode fires hidden one-shots — a conversation title, a summary —
 * carrying the same session header as the visible turn and often in parallel with it. Both resolved
 * to one SDK session; the second asked the CLI to resume a session the first was still running; the
 * CLI refused on stderr behind an `exit 1`; the router read a subprocess crash, answered `502`, and
 * failed the user's conversation over onto a cold account mid-turn.
 */

const SDK_PLAN: SdkServableCandidate = {
  account: subscriptionAccount("sub-1"),
  configDir: "/data/accounts/sub-1",
  upstreamModel: "claude-opus-5",
  poolId: null,
  translation: null,
}

const NOW = new Date("2026-09-06T00:00:00.000Z")

/** One message, then two, then three: a conversation that grows the way a real one does. */
function body(turns: number): Uint8Array {
  const messages = [{ role: "user", content: "hello" }]
  for (let at = 1; at < turns; at += 1) {
    messages.push({ role: "assistant", content: `answer ${at}` })
    messages.push({ role: "user", content: `question ${at + 1}` })
  }
  return new TextEncoder().encode(JSON.stringify({ messages }))
}

function storeAndContext(): { readonly store: SessionStore; readonly session: SdkSessionContext } {
  const rows = new Map<string, unknown>()
  const store = createSessionStore({
    repository: {
      findByKey: () => Promise.resolve(undefined),
      upsert: (input) => {
        rows.set(input.key, input)
        return Promise.resolve()
      },
    },
    now: () => NOW,
  })
  return {
    store,
    session: { store, apiKeyId: "key-1", sessionKey: "conv-1", keySource: "header" },
  }
}

/**
 * An attempt whose answer streams, and whose SDK session is therefore still in use when
 * `runSdkAttempt` returns. `sessionId` is what the turn reports; `plans` collects the lineage plan
 * each attempt was launched with.
 */
function streamingAttempt(
  session: SdkSessionContext,
  turns: number,
  sessionId: string,
  plans: string[],
): { readonly outcome: Promise<AttemptOutcome>; close(): void } {
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })

  const outcome = runSdkAttempt({
    plan: SDK_PLAN,
    body: body(turns),
    session,
    timeoutMs: 60_000,
    invoke: (invocation) => {
      plans.push(
        invocation.session.kind === "fresh"
          ? `fresh:${invocation.session.reason}`
          : `${invocation.session.kind}:${invocation.session.sdkSessionId}`,
      )
      invocation.onSession?.({ sdkSessionId: sessionId })
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("data: {}\n\n"))
          await held
          controller.close()
        },
      })
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      )
    },
  })

  return { outcome, close: release }
}

/** Reads the answer to its end, which is what tells the router the turn is over. */
async function drain(outcome: AttemptOutcome): Promise<void> {
  if (outcome.kind !== "success") throw new Error(`expected a success, got ${outcome.kind}`)
  await outcome.response.text()
}

describe("a hidden one-shot arriving beside the visible turn", () => {
  test("the visible turn resumes; the one-shot beside it is detached, on a fresh session", async () => {
    const { session } = storeAndContext()
    const plans: string[] = []

    // Turn one establishes the binding.
    const first = streamingAttempt(session, 1, "sdk-1", plans)
    first.close()
    await drain(await first.outcome)

    // Turn two resumes it — and is still running when the one-shot arrives.
    const visible = streamingAttempt(session, 3, "sdk-1", plans)
    const outcome = await visible.outcome
    const oneShot = streamingAttempt(session, 3, "sdk-throwaway", plans)
    oneShot.close()
    await drain(await oneShot.outcome)

    expect(plans).toEqual(["fresh:no-session", "resume:sdk-1", "fresh:session-busy"])

    visible.close()
    await drain(outcome)
  })

  test("and the one-shot leaves the conversation exactly where it was", async () => {
    const { session } = storeAndContext()
    const plans: string[] = []

    const first = streamingAttempt(session, 1, "sdk-1", plans)
    first.close()
    await drain(await first.outcome)

    const visible = streamingAttempt(session, 3, "sdk-1", plans)
    const outcome = await visible.outcome
    const oneShot = streamingAttempt(session, 3, "sdk-throwaway", plans)
    oneShot.close()
    await drain(await oneShot.outcome)
    visible.close()
    await drain(outcome)

    // The next real turn resumes the conversation's own session, never the one-shot's throwaway.
    const next = streamingAttempt(session, 5, "sdk-1", plans)
    next.close()
    await drain(await next.outcome)

    expect(plans.at(-1)).toBe("resume:sdk-1")
  })
})

describe("the claim is released by the answer itself", () => {
  test("a drained answer hands the conversation back, so the next turn resumes", async () => {
    const { session } = storeAndContext()
    const plans: string[] = []

    const first = streamingAttempt(session, 1, "sdk-1", plans)
    first.close()
    await drain(await first.outcome)

    const second = streamingAttempt(session, 3, "sdk-1", plans)
    second.close()
    await drain(await second.outcome)

    const third = streamingAttempt(session, 5, "sdk-1", plans)
    third.close()
    await drain(await third.outcome)

    expect(plans).toEqual(["fresh:no-session", "resume:sdk-1", "resume:sdk-1"])
  })

  test("a client that goes away hands it back too — a cancelled body is a finished turn", async () => {
    const { session } = storeAndContext()
    const plans: string[] = []

    const first = streamingAttempt(session, 1, "sdk-1", plans)
    first.close()
    await drain(await first.outcome)

    // Started, then abandoned without ever being read to the end.
    const abandoned = await streamingAttempt(session, 3, "sdk-1", plans).outcome
    if (abandoned.kind !== "success") throw new Error("expected a success")
    await abandoned.response.body?.cancel()

    const next = streamingAttempt(session, 5, "sdk-1", plans)
    next.close()
    await drain(await next.outcome)

    // Not `fresh:session-busy`: the abandoned turn released the conversation on its way out.
    expect(plans.at(-1)).toBe("resume:sdk-1")
  })

  test("a failed attempt releases before the chain resolves its next one", async () => {
    const { session } = storeAndContext()
    const plans: string[] = []

    const first = streamingAttempt(session, 1, "sdk-1", plans)
    first.close()
    await drain(await first.outcome)

    const failed = await runSdkAttempt({
      plan: SDK_PLAN,
      body: body(3),
      session,
      timeoutMs: 1_000,
      invoke: () => Promise.reject(new Error("Claude AI usage limit reached")),
    })
    expect(failed.kind).toBe("failure")

    // The failover's next attempt is a different account, but the same conversation: it must be
    // able to claim it rather than run detached because the attempt that just failed still holds it.
    const retry = streamingAttempt(session, 3, "sdk-1", plans)
    retry.close()
    await drain(await retry.outcome)

    expect(plans.at(-1)).toBe("resume:sdk-1")
  })
})
