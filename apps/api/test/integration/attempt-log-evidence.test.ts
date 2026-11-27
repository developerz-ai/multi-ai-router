import { describe, expect, test } from "bun:test"
import { ownedInvoker } from "../../src/composition/owned-invoker"
import { createLogger } from "../../src/logging/logger"
import { CLAUDE_FAST_CLI_VERSION } from "../../src/providers/claude-fast/integrity"
import { createFastInvoker } from "../../src/providers/claude-fast/invoker"
import { createSdkConcurrency } from "../../src/providers/claude-sdk/concurrency"
import type { SdkInvoker } from "../../src/providers/claude-sdk/invoke"
import { createSdkInvoker } from "../../src/providers/claude-sdk/invoker"
import type { OwnerLaunch } from "../../src/providers/claude-sdk/owner-launch-types"
import { UpstreamAdmissionRefused } from "../../src/providers/upstream-admission"
import { account, subscriptionAccount } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, KEY, post, settle } from "./harness"

/**
 * The evidence the "upstream attempt failed" line carries (#509), per transport: how many requests
 * were in flight on the account when the refusal landed (the refused one included), which Claude
 * invoker produced the outcome and the model it sent, the upstream's request id, `retry-after` and
 * rate-limit headers, and the names of the scrub rules that changed the system prompt. A field that
 * does not apply is absent, never `null`. Never logged: a credential or a word of the prompt.
 *
 * Every Claude case composes the transport as `composition/request-services.ts` does (`ownedInvoker`
 * over the invoker), and every SDK stub throws from the iterator, never from `runQuery` itself: a
 * synchronous throw lands before the upstream starts and writes no such line at all.
 */

type Line = Record<string, unknown>

const SECRET_SENTENCE = "The vault phrase is purple-elephant-forty-two."
const ACCESS_TOKEN = "fast-selected-account-token"
/** Credential-shaped: the logger's `sk-` value pattern must take it out of a header value. */
const CREDENTIAL_HEADER = `sk-ant-api03-${"Q".repeat(48)}`
const SYSTEM = `Use the opencode tools when asked.\n\n${SECRET_SENTENCE}`
/** The model the router plans for a subscription account here: no alias map, so the client's own. */
const PLANNED = "claude-opus-5-5"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function capture() {
  const lines: Line[] = []
  const logger = createLogger({
    level: "warn",
    write: (line) => {
      lines.push(JSON.parse(line))
    },
  })
  return { lines, logger }
}

const failedLines = (lines: readonly Line[]) =>
  lines.filter((line) => line.msg === "upstream attempt failed")

function onlyFailedLine(lines: readonly Line[]): Line {
  const failed = failedLines(lines)
  expect(failed).toHaveLength(1)
  const line = failed[0]
  if (line === undefined) throw new Error("no upstream attempt failed line")
  return line
}

function absent(line: Line, ...fields: string[]) {
  for (const field of fields)
    expect({ field, present: Object.hasOwn(line, field) }).toEqual({
      field,
      present: false,
    })
}

function request(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: PLANNED,
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    ...fields,
  })
}

const WITH_SYSTEM = request({ system: SYSTEM })

function anthropicError(status: number, headers: Record<string, string> = {}) {
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "rate_limit_error",
        message: "Number of request tokens has exceeded your limit.",
      },
    }),
    { status, headers: { "content-type": "application/json", ...headers } },
  )
}

const REFUSAL_HEADERS = {
  "request-id": "req_fast_refusal_1",
  "retry-after": "17",
  "anthropic-ratelimit-unified-5h-status": "rejected",
  "anthropic-ratelimit-requests-remaining": "0",
  "anthropic-ratelimit-tokens-remaining": "0",
  "anthropic-ratelimit-unified-note": CREDENTIAL_HEADER,
}

function lease(refuse = false, onHandle?: () => void) {
  const signal = new AbortController().signal
  return {
    handle: (accountId: string) => {
      onHandle?.()
      return {
        accountId,
        owner: "owner",
        generation: 1n,
        signal,
        valid: () => !refuse,
        assert() {
          if (refuse) throw new UpstreamAdmissionRefused("replica lease lost")
        },
        remainingMs: () => 60_000,
      }
    },
  }
}

/** A real Agent-SDK invoker whose `query()` throws on the first `next()`, after it started. */
function throwingSdk(options: { owner?: boolean; hold?: Promise<void> } = {}): SdkInvoker {
  const owner: OwnerLaunch = {
    spawn: () => {
      throw new Error("no process is spawned in a test")
    },
    ready: Promise.resolve(),
    exited: new Promise<void>(() => {}),
    started: Promise.resolve(),
    prepare: async () => {},
    release() {},
    assertReady() {},
    activate() {},
    cancel() {},
  }
  return createSdkInvoker({
    concurrency: createSdkConcurrency({ global: 4, perAccount: 4 }),
    resolveCli: () => ({ ok: true, source: "env_override", path: "/offline/claude", bytes: 1 }),
    ...(options.owner === true ? { ownerLaunch: () => owner } : {}),
    runQuery: ({ prompt }) => {
      void (async () => {
        for await (const _ of prompt) {
        }
      })()
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<unknown>> {
              if (options.hold !== undefined) await options.hold
              throw new Error("API Error: 429 rate limit exceeded for this account")
            },
            async return(): Promise<IteratorResult<unknown>> {
              return { done: true, value: undefined }
            },
          }
        },
      }
    },
  })
}

interface FastOptions {
  readonly upstream?: (request: Request) => Response | Promise<Response>
  readonly resolveModel?: (model: string) => string | null
  readonly expired?: boolean
  readonly sdk?: SdkInvoker
  readonly perAccount?: number
  readonly refuseLease?: boolean
  readonly onHandle?: () => void
}

function fastInvoker(options: FastOptions): SdkInvoker {
  const fast = createFastInvoker({
    concurrency: createSdkConcurrency({
      global: options.perAccount ?? 4,
      perAccount: options.perAccount ?? 4,
    }),
    errorMaxBytes: 4096,
    credential: async () => ({
      accessToken: ACCESS_TOKEN,
      expiresAt: options.expired === true ? Date.now() - 1 : Date.now() + 3_600_000,
      deviceId: "a".repeat(64),
      accountUuid: "11111111-1111-4111-8111-111111111111",
    }),
    resolveModel: (_, model) => (options.resolveModel ?? ((m: string) => m))(model),
    sdk: options.sdk ?? throwingSdk(),
    fetch: async (request) =>
      (options.upstream ?? (() => anthropicError(429, REFUSAL_HEADERS)))(request),
  })
  return ownedInvoker(lease(options.refuseLease, options.onHandle), fast)
}

function claudeRouter(invokeSdk: SdkInvoker) {
  const { lines, logger } = capture()
  const h = harness({
    accounts: [subscriptionAccount("sub")],
    responses: [],
    maxAttempts: 1,
    invokeSdk,
    logger,
  })
  return { ...h, lines }
}

async function send(invokeSdk: SdkInvoker, body: string) {
  const h = claudeRouter(invokeSdk)
  const response = await h.app.request("/v1/messages", post(body, bearer()))
  await response.text()
  await settle()
  return h.lines
}

function noLeak(line: Line) {
  const text = JSON.stringify(line)
  for (const secret of [KEY, ACCESS_TOKEN, CREDENTIAL_HEADER, SECRET_SENTENCE, "purple-elephant"])
    expect({ leaked: secret, found: text.includes(secret) }).toEqual({
      leaked: secret,
      found: false,
    })
}

describe("Claude fast, refused inside refuse()", () => {
  test("the line carries the gate count, the fast transport, the sent model, the real headers and the rules", async () => {
    const line = onlyFailedLine(await send(fastInvoker({}), WITH_SYSTEM))
    expect(line).toMatchObject({
      inFlight: 1,
      transport: "fast",
      model: PLANNED,
      upstreamRequestId: "req_fast_refusal_1",
      retryAfter: "17",
      scrubRules: ["brand-tokens"],
    })
    // The headers `safeError` drops on the way to the log site, captured where they still exist.
    expect(line.rateLimitHeaders).toEqual({
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-requests-remaining": "0",
      // The logger redacts a key naming `token`: accepted, the requests limiter keeps its value.
      "anthropic-ratelimit-tokens-remaining": "[REDACTED]",
      "anthropic-ratelimit-unified-note": "[REDACTED]",
    })
    noLeak(line)
  })

  for (const [resolved, sent] of [
    ["claude-resolved-opus[1m]", "claude-resolved-opus"],
    ["claude-resolved-sonnet", "claude-resolved-sonnet"],
  ] as const) {
    test(`an alias resolving to ${resolved} logs ${sent}, the model the fast body sends`, async () => {
      const sentModels: string[] = []
      const invoke = fastInvoker({
        resolveModel: (model) => (model === "opus-alias" ? resolved : null),
        upstream: async (upstream) => {
          sentModels.push((JSON.parse(await upstream.text()) as { model: string }).model)
          return anthropicError(429, REFUSAL_HEADERS)
        },
      })
      const line = onlyFailedLine(await send(invoke, request({ model: "opus-alias" })))
      expect(sentModels).toEqual([sent])
      expect(line.model).toBe(sent)
      expect(line.transport).toBe("fast")
    })
  }

  test("a lone refusal counts itself: inFlight is 1, never 0", async () => {
    const line = onlyFailedLine(await send(fastInvoker({}), request()))
    expect(line.inFlight).toBe(1)
  })

  test("with two requests held in flight on the account, the third's refusal logs inFlight 3", async () => {
    const release = deferred<void>()
    let calls = 0
    const both = deferred<void>()
    const invoke = fastInvoker({
      perAccount: 3,
      upstream: async () => {
        calls += 1
        if (calls <= 2) {
          if (calls === 2) both.resolve()
          await release.promise
        }
        return anthropicError(429, REFUSAL_HEADERS)
      },
    })
    const h = claudeRouter(invoke)
    const held = [1, 2].map(() => h.app.request("/v1/messages", post(request(), bearer())))
    await both.promise
    const third = await h.app.request("/v1/messages", post(request(), bearer()))
    await third.text()
    await settle()
    const line = onlyFailedLine(h.lines)
    expect(line.inFlight).toBe(3)
    release.resolve()
    for (const response of await Promise.all(held)) await response.text()
  })

  test("no system prompt means the scrub never ran: scrubRules is absent, not []", async () => {
    const line = onlyFailedLine(await send(fastInvoker({}), request()))
    absent(line, "scrubRules")
  })

  test("a system prompt with no fingerprint ran the scrub: scrubRules is []", async () => {
    const line = onlyFailedLine(await send(fastInvoker({}), request({ system: "Be terse." })))
    expect(line.scrubRules).toEqual([])
  })

  test("a native billing header alone leaves no text to scrub: scrubRules is absent", async () => {
    const billing = `x-anthropic-billing-header: cc_version=${CLAUDE_FAST_CLI_VERSION}.abc; cc_entrypoint=cli; cch=00000;`
    const body = request({ system: [{ type: "text", text: billing }] })
    const line = onlyFailedLine(await send(fastInvoker({}), body))
    // Refused by the fast transport itself, not a profile fallback onto the SDK.
    expect(line.transport).toBe("fast")
    absent(line, "scrubRules")
  })

  test("a native billing header beside harness text still scrubs that text and names the rule", async () => {
    const billing = `x-anthropic-billing-header: cc_version=${CLAUDE_FAST_CLI_VERSION}.abc; cc_entrypoint=cli; cch=00000;`
    const body = request({
      system: [
        { type: "text", text: billing },
        { type: "text", text: "Use the opencode tools when asked." },
      ],
    })
    const line = onlyFailedLine(await send(fastInvoker({}), body))
    expect(line.transport).toBe("fast")
    expect(line.scrubRules).toEqual(["brand-tokens"])
  })
})

describe("Claude fast, outside refuse()", () => {
  const OUTSIDE = ["inFlight", "upstreamRequestId", "retryAfter", "rateLimitHeaders"]

  test("a fetch that throws logs the fast transport, its model and its rules, and no count", async () => {
    const invoke = fastInvoker({
      upstream: () => {
        throw new Error("stub upstream declined to answer")
      },
    })
    const line = onlyFailedLine(await send(invoke, WITH_SYSTEM))
    expect(line).toMatchObject({ transport: "fast", model: PLANNED, scrubRules: ["brand-tokens"] })
    absent(line, ...OUTSIDE)
    noLeak(line)
  })

  test("a thrown failure keeps the resolved model with its [1m] tag stripped", async () => {
    const invoke = fastInvoker({
      resolveModel: () => "claude-resolved-opus[1m]",
      upstream: () => {
        throw new Error("stub upstream declined to answer")
      },
    })
    const line = onlyFailedLine(await send(invoke, request({ model: "opus-alias" })))
    expect(line.model).toBe("claude-resolved-opus")
  })

  test("a redirect answered as the fast invoker's own 502 logs the fast transport", async () => {
    const invoke = fastInvoker({
      upstream: () =>
        new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } }),
    })
    const line = onlyFailedLine(await send(invoke, WITH_SYSTEM))
    expect(line).toMatchObject({ transport: "fast", model: PLANNED, scrubRules: ["brand-tokens"] })
    absent(line, ...OUTSIDE)
  })

  test("a 200 that is not an event stream logs the fast transport", async () => {
    const invoke = fastInvoker({
      upstream: () =>
        new Response("<html>proxy</html>", {
          status: 200,
          headers: { "content-type": "text/html", "request-id": "req_ignored" },
        }),
    })
    const line = onlyFailedLine(await send(invoke, request()))
    expect(line).toMatchObject({ transport: "fast", model: PLANNED })
    absent(line, ...OUTSIDE, "scrubRules")
  })

  for (const shape of ["throws", "redirects"] as const) {
    test(`with another request in flight, a fetch that ${shape} still logs no inFlight`, async () => {
      const release = deferred<void>()
      const first = deferred<void>()
      let calls = 0
      const invoke = fastInvoker({
        upstream: async () => {
          calls += 1
          if (calls === 1) {
            first.resolve()
            await release.promise
            return anthropicError(429, REFUSAL_HEADERS)
          }
          if (shape === "throws") throw new Error("stub upstream declined to answer")
          return new Response(null, { status: 302, headers: { location: "https://e.test/" } })
        },
      })
      const h = claudeRouter(invoke)
      const held = h.app.request("/v1/messages", post(request(), bearer()))
      await first.promise
      const response = await h.app.request("/v1/messages", post(request(), bearer()))
      await response.text()
      await settle()
      const line = onlyFailedLine(h.lines)
      expect(line.transport).toBe("fast")
      absent(line, "inFlight")
      release.resolve()
      await (await held).text()
    })
  }

  test("an expired credential falls back to the SDK before fast reports: the SDK owns the line", async () => {
    const line = onlyFailedLine(await send(fastInvoker({ expired: true }), WITH_SYSTEM))
    expect(line).toMatchObject({ transport: "sdk", model: PLANNED, scrubRules: ["brand-tokens"] })
    absent(line, ...OUTSIDE)
  })

  test("a model that does not resolve falls back to the SDK: the SDK owns the line", async () => {
    const invoke = fastInvoker({ resolveModel: () => null })
    const line = onlyFailedLine(await send(invoke, request()))
    expect(line).toMatchObject({ transport: "sdk", model: PLANNED })
    absent(line, ...OUTSIDE, "scrubRules")
  })
})

describe("Claude Agent SDK, thrown from the turn", () => {
  const OMITTED = ["inFlight", "upstreamRequestId", "retryAfter", "rateLimitHeaders"]

  test("without an owner launch, the line carries the sdk transport, its model and its rules", async () => {
    const line = onlyFailedLine(await send(throwingSdk(), WITH_SYSTEM))
    expect(line).toMatchObject({ transport: "sdk", model: PLANNED, scrubRules: ["brand-tokens"] })
    absent(line, ...OMITTED)
    noLeak(line)
  })

  test("through an owner launch, as production runs it, the sdk transport still reports", async () => {
    const line = onlyFailedLine(await send(throwingSdk({ owner: true }), WITH_SYSTEM))
    expect(line).toMatchObject({ transport: "sdk", model: PLANNED, scrubRules: ["brand-tokens"] })
    absent(line, ...OMITTED)
  })

  test("no system prompt means no systemPrompt option: scrubRules is absent", async () => {
    const line = onlyFailedLine(await send(throwingSdk(), request()))
    expect(line.transport).toBe("sdk")
    absent(line, "scrubRules")
  })

  test("with another turn in flight on the account, the line still has no inFlight", async () => {
    const release = deferred<void>()
    let turns = 0
    const holding = throwingSdk({ hold: release.promise })
    const failing = throwingSdk()
    const invoke: SdkInvoker = (invocation) => {
      turns += 1
      return turns === 1 ? holding(invocation) : failing(invocation)
    }
    const h = claudeRouter(invoke)
    const held = h.app.request("/v1/messages", post(request(), bearer()))
    for (let tick = 0; tick < 50 && turns === 0; tick++) await Bun.sleep(1)
    const response = await h.app.request("/v1/messages", post(request(), bearer()))
    await response.text()
    await settle()
    const line = onlyFailedLine(h.lines)
    expect(line.transport).toBe("sdk")
    absent(line, "inFlight")
    release.resolve()
    await (await held).text()
  })
})

describe("the structured-output refusal: a failure line with no transport report", () => {
  const STRUCTURED = request({
    output_config: {
      format: { type: "json_schema", schema: { type: "object", properties: {} } },
    },
  })

  for (const [name, invoke] of [
    ["fast mode off", () => throwingSdk()],
    ["fast credential expired", () => fastInvoker({ expired: true })],
  ] as const) {
    test(`${name}: the line exists and carries no transport, model, inFlight or scrubRules`, async () => {
      const line = onlyFailedLine(await send(invoke(), STRUCTURED))
      expect(line.signal).toBe("claude-sdk:structured-output-unsupported")
      absent(line, "transport", "model", "inFlight", "scrubRules")
    })
  }
})

describe("refusals that never reach the attempt-failed line", () => {
  test("a lease refused before the invoke writes no line", async () => {
    const lines = await send(fastInvoker({ refuseLease: true }), request())
    expect(failedLines(lines)).toEqual([])
  })

  test("a client abort before the attempt starts writes no line", async () => {
    const client = new AbortController()
    const invoke = fastInvoker({ onHandle: () => client.abort(new Error("client went away")) })
    const h = claudeRouter(invoke)
    const response = await Promise.resolve(
      h.app.request("/v1/messages", { ...post(request(), bearer()), signal: client.signal }),
    ).catch(() => null)
    await response?.text().catch(() => "")
    await settle()
    expect(failedLines(h.lines)).toEqual([])
  })
})

describe("an HTTP driver (openai-oauth)", () => {
  const CODEX_ID = "acct-codex-evidence"
  const CODEX_TOKEN = `eyJhbGciOiJub25lIn0.${Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: CODEX_ID } }),
  ).toString("base64url")}.sig`
  const CODEX_BODY = JSON.stringify({
    model: "gpt-5.5",
    max_tokens: 64,
    system: SYSTEM,
    messages: [{ role: "user", content: "hi" }],
  })

  function codexAccount() {
    return {
      ...account("codex", { provider: "openai-oauth", cipher: CRYPTOR, billing: "subscription" }),
      authMaterial: CRYPTOR.encrypt(JSON.stringify({ accessToken: CODEX_TOKEN })),
    }
  }

  const refused = () =>
    new Response(JSON.stringify({ error: { message: "slow down", type: "rate_limit_error" } }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_codex_1",
        "retry-after": "30",
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-remaining-tokens": "0",
        "x-codex-primary-used-percent": "100",
        "x-codex-secondary-window-minutes": "10080",
        "x-unrelated": "kept-out",
      },
    })

  function codexRouter(responses: readonly (() => Response | Promise<Response>)[]) {
    const { lines, logger } = capture()
    const h = harness({ accounts: [codexAccount()], responses, maxAttempts: 1, logger })
    return { ...h, lines }
  }

  test("the line carries the account's count, the planned model and the response headers", async () => {
    const h = codexRouter([refused])
    const response = await h.app.request("/v1/messages", post(CODEX_BODY, bearer()))
    await response.text()
    await settle()
    const line = onlyFailedLine(h.lines)
    expect(line).toMatchObject({
      inFlight: 1,
      model: "gpt-5.5",
      upstreamRequestId: "req_codex_1",
      retryAfter: "30",
    })
    expect(line.rateLimitHeaders).toEqual({
      "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-remaining-tokens": "[REDACTED]",
      "x-codex-primary-used-percent": "100",
      "x-codex-secondary-window-minutes": "10080",
    })
    absent(line, "transport", "scrubRules")
    noLeak(line)
    expect(JSON.stringify(line)).not.toContain(CODEX_TOKEN)
  })

  test("with two requests held in flight, the third's refusal logs inFlight 3", async () => {
    const release = deferred<void>()
    const held = async () => {
      await release.promise
      return refused()
    }
    const h = codexRouter([held, held, refused])
    const pending = [1, 2].map(() => h.app.request("/v1/messages", post(CODEX_BODY, bearer())))
    for (let tick = 0; tick < 100 && h.upstream.calls.length < 2; tick++) await Bun.sleep(1)
    expect(h.upstream.calls).toHaveLength(2)
    const third = await h.app.request("/v1/messages", post(CODEX_BODY, bearer()))
    await third.text()
    await settle()
    const line = onlyFailedLine(h.lines)
    expect(line.inFlight).toBe(3)
    release.resolve()
    for (const response of await Promise.all(pending)) await response.text()
  })
})
