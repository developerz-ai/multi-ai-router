import { describe, expect, test } from "bun:test"
import { TranslationError } from "@multi-ai-router/core"
import { createHealthStore, planCandidates } from "../../../src/services/dataplane"
import { type ChainContext, runChain } from "../../../src/services/dataplane/chain"
import { createRuntime } from "../../../src/services/dataplane/runtime"
import type { TranslatedRequestBody } from "../../../src/services/dataplane/translate-body"
import type { UsageRecord } from "../../../src/services/usage"
import { candidate } from "../routing/fixtures"
import { account, catalog, cipher, clock, jsonResponse, type TestClock } from "./fixtures"

/**
 * Where the upstream span opens, and what that costs the one number it decides.
 *
 * `routerOverheadMs` is `totalMs - upstreamMs`, so every millisecond charged to `upstreamMs` is a
 * millisecond subtracted from the router's own budget. The chain therefore has to be exact about
 * *when this attempt started waiting*: it starts when the transport is handed the request, not when
 * the attempt began. Between those two points the router **works** — it converts the client's body
 * for a translated candidate, rewrites the model for a renamed one, and reads the account's
 * credential — and none of that is a wait.
 *
 * Getting it wrong is invisible in every other test, because it does not change a status, a body, a
 * header, or a row's existence. It changes one integer, in the direction that makes the router look
 * faster than it is. So the clock here is driven by hand and the conversion is *made* expensive:
 * these assert exact millisecond attribution, not an ordering.
 *
 * `../../integration/overhead.test.ts` is the other half — the drain of a live stream is a wait, and
 * has to land on the other side of the same subtraction.
 */

const TRANSLATE_MS = 30
const UPSTREAM_MS = 400
const DECRYPT_MS = 12

const CRYPTOR = cipher()

const BODY = JSON.stringify({
  model: "claude-opus-5",
  max_tokens: 64,
  messages: [{ role: "user", content: "hello" }],
})

const CHAT_REPLY = {
  id: "chatcmpl-1",
  model: "gpt-4o",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" } }],
  usage: { prompt_tokens: 3, completion_tokens: 4 },
}

/**
 * A conversion that costs real time on the harness clock — the fact production has and a test
 * otherwise cannot, since `bodyFor` is the only router work inside the window under test.
 */
function costlyTranslation(testClock: TestClock, ms: number): TranslatedRequestBody {
  return {
    bodyFor: () => {
      testClock.advance(ms)
      return new TextEncoder().encode(JSON.stringify({ model: "gpt-4o", messages: [] }))
    },
  }
}

interface Chain {
  readonly context: ChainContext
  readonly rows: readonly UsageRecord[]
}

/**
 * One anthropic-speaking client against one openai-chat account: the chain's translate path, built
 * through the real planner so the candidate carries the driver, URL, and translation pair a
 * deployment would give it.
 */
function chain(options: {
  readonly clock: TestClock
  readonly translated: TranslatedRequestBody
  readonly call: (request: Request) => Promise<Response>
  readonly decrypt?: (value: string) => string
}): Chain {
  const upstream = account("or-1", { provider: "openrouter", apiKey: "sk-or", cipher: CRYPTOR })
  const plan = planCandidates(
    [candidate(upstream.snapshot)],
    catalog([upstream]),
    "anthropic",
    "messages",
  )
  const rows: UsageRecord[] = []

  const runtime = createRuntime({
    health: createHealthStore({ jitter: () => 0 }),
    cipher: options.decrypt === undefined ? CRYPTOR : { decrypt: options.decrypt },
    call: options.call,
    sessionKeySource: "fingerprint",
    clock: options.clock,
    timeoutMs: 30_000,
    record: (row) => void rows.push(row),
    correlationId: "11111111-1111-4111-8111-111111111111",
    clientRequestId: null,
    apiKeyId: "22222222-2222-4222-8222-222222222222",
    sessionKey: "session-1",
    model: "claude-opus-5",
    ingressDialect: "anthropic",
    operation: "messages",
    requestStarted: options.clock.elapsed(),
  })

  return {
    rows,
    context: {
      runtime,
      plan: plan.servable,
      request: new Request("http://router.test/v1/messages", { method: "POST", body: BODY }),
      bodyBytes: new TextEncoder().encode(BODY),
      modelSpan: null,
      translation: { created: 0, model: "claude-opus-5", fallbackId: "msg_test" },
      translated: options.translated,
      failover: undefined,
      log: undefined,
    },
  }
}

/** An upstream that charges the clock for its own time before answering, exactly as one does. */
function answersAfter(testClock: TestClock, ms: number, make: () => Response) {
  return (): Promise<Response> => {
    testClock.advance(ms)
    return Promise.resolve(make())
  }
}

describe("the upstream span opens when the transport is called, not when the attempt is", () => {
  test("a successful attempt charges the conversion to the router and the wait to the upstream", async () => {
    const testClock = clock()
    const it = chain({
      clock: testClock,
      translated: costlyTranslation(testClock, TRANSLATE_MS),
      call: answersAfter(testClock, UPSTREAM_MS, () => jsonResponse(200, CHAT_REPLY)),
    })

    await (await runChain(it.context)).text()

    const row = it.rows[0]
    expect(row?.outcome).toBe("success")
    expect(row?.egressMode).toBe("translate")
    // The attempt's wall time is both halves; only one of them is the router's.
    expect(row?.latencyMs).toBe(TRANSLATE_MS + UPSTREAM_MS)
    expect(row?.routerOverheadMs).toBe(TRANSLATE_MS)
  })

  test("a failed attempt is measured the same way — the row changes, the subtraction does not", async () => {
    const testClock = clock()
    const it = chain({
      clock: testClock,
      translated: costlyTranslation(testClock, TRANSLATE_MS),
      call: answersAfter(testClock, UPSTREAM_MS, () => jsonResponse(500, { error: "nope" })),
    })

    // The upstream answered, so its own answer is what the client gets — relayed, not thrown.
    expect((await runChain(it.context)).status).toBe(500)

    const row = it.rows[0]
    expect(row?.outcome).toBe("upstream_error")
    expect(row?.routerOverheadMs).toBe(TRANSLATE_MS)
  })

  test("an attempt that never reached a transport charges nothing to the upstream", async () => {
    const testClock = clock()
    const it = chain({
      clock: testClock,
      translated: costlyTranslation(testClock, TRANSLATE_MS),
      call: () => Promise.reject(new Error("the upstream must never be called")),
      // A credential the router cannot read. Both transports answer their own transport failures
      // with an outcome, so a throw out of the dispatch happened before a byte was sent — and the
      // time it took is the router's, however it is spent.
      decrypt: () => {
        testClock.advance(DECRYPT_MS)
        throw new Error("credential envelope rejected")
      },
    })

    await expect(runChain(it.context)).rejects.toThrow()

    const row = it.rows[0]
    expect(row?.outcome).toBe("upstream_error")
    expect(row?.httpStatus).toBeNull()
    expect(row?.routerOverheadMs).toBe(TRANSLATE_MS + DECRYPT_MS)
  })

  test("a body with no faithful conversion charges its refusal to the router", async () => {
    const testClock = clock()
    const it = chain({
      clock: testClock,
      translated: {
        bodyFor: () => {
          testClock.advance(TRANSLATE_MS)
          throw new TranslationError("no representation")
        },
      },
      call: () => Promise.reject(new Error("the upstream must never be called")),
    })

    await expect(runChain(it.context)).rejects.toThrow()

    const row = it.rows[0]
    expect(row?.outcome).toBe("client_error")
    expect(row?.routerOverheadMs).toBe(TRANSLATE_MS)
  })
})
