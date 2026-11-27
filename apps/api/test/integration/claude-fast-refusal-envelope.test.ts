import { describe, expect, test } from "bun:test"
import { ownedInvoker } from "../../src/composition/owned-invoker"
import { createFastInvoker } from "../../src/providers/claude-fast/invoker"
import { createSdkConcurrency } from "../../src/providers/claude-sdk/concurrency"
import {
  EXTRA_USAGE_GATED,
  EXTRA_USAGE_SPENT,
  WINDOW_SPENT,
} from "../../src/providers/claude-sdk/failure-rules-vocabulary"
import { createSdkQuotaStore } from "../../src/providers/claude-sdk/quota"
import { NOW, subscriptionAccount } from "../unit/dataplane/fixtures"
import { bearer, harness, post, settle } from "./harness"

/**
 * developerz-ai/multi-ai-router#508 (epic developerz-ai/developerz.ai#10277). A Claude refusal the
 * fast transport answers with a sentence the router wrote used to be relayed envelope-less: the
 * consumer could not tell a `429` that means "too many at once" from a spent window, nor read the
 * 529 as the transient it is. Every class below now carries `error.router`, the `429` and `503` ones
 * rendered through the same `toRouterError` mapping the Agent-SDK path uses, and the request wall
 * names its signal.
 */

const GATED =
  "Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."
const OUT_OF_EXTRA = "You're out of extra usage. Add more at claude.ai/settings/usage"
const UPSTREAM_OWN_WORDS = ["Third-party apps", "out of extra usage", "Overloaded", "hit your"]
const RESET_SECONDS = Math.floor(NOW.getTime() / 1000) + 3600

const anthropicError = (
  status: number,
  type: string,
  message: string,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

const spentWindow = {
  "anthropic-ratelimit-unified-status": "rejected",
  "anthropic-ratelimit-unified-5h-status": "rejected",
  "anthropic-ratelimit-unified-5h-reset": String(RESET_SECONDS),
}

function fastRouter(
  upstream: (request: Request) => Response,
  options: { accounts?: number; unknownResetRetryAfterSeconds?: number } = {},
) {
  const signal = new AbortController().signal
  const lease = {
    handle: (accountId: string) => ({
      accountId,
      owner: "owner",
      generation: 1n,
      signal,
      valid: () => true,
      assert() {},
      remainingMs: () => 60_000,
    }),
  }
  const fast = createFastInvoker({
    concurrency: createSdkConcurrency({ global: 4, perAccount: 2 }),
    errorMaxBytes: 4096,
    credential: async () => ({
      accessToken: "fast-selected-account-token",
      expiresAt: Date.now() + 3_600_000,
      deviceId: "a".repeat(64),
      accountUuid: "11111111-1111-4111-8111-111111111111",
    }),
    resolveModel: (_, model) => model,
    sdk: async () => new Response("unexpected SDK fallback", { status: 500 }),
    fetch: async (request) => upstream(request),
  })
  const quota = createSdkQuotaStore()
  const ids = Array.from({ length: options.accounts ?? 1 }, (_, index) =>
    index === 0 ? "sub" : `sub-${index + 1}`,
  )
  const h = harness({
    accounts: ids.map((id, index) => subscriptionAccount(id, { snapshot: { priority: index } })),
    responses: [],
    maxAttempts: 3,
    failover: { overloadRetries: 0 },
    selection: {
      unpooledPolicy: "priority-failover",
      ...(options.unknownResetRetryAfterSeconds === undefined
        ? {}
        : { unknownResetRetryAfterSeconds: options.unknownResetRetryAfterSeconds }),
    },
    invokeSdk: ownedInvoker(lease, fast),
    sdkQuota: quota,
  })
  return { ...h, quota }
}

const messages = JSON.stringify({
  model: "claude-opus-5-5",
  max_tokens: 64,
  messages: [{ role: "user", content: "hello" }],
})

interface Router {
  readonly wall: string
  readonly scope: string
  readonly signal: string
  readonly retryable: boolean
  readonly reset_at: string | null
  readonly retry_after_s: number | null
  readonly reset_source?: string | null
}

async function ask(h: ReturnType<typeof fastRouter>) {
  const response = await h.app.request("/v1/messages", post(messages, bearer()))
  await settle()
  const body = (await response.json()) as {
    error: { type: string; message: string; router: Router }
  }
  const serialized = JSON.stringify(body)
  for (const words of UPSTREAM_OWN_WORDS) expect(serialized).not.toContain(words)
  return { response, error: body.error, router: body.error.router }
}

const sentence = (clientMessage: string, signal: string) => `${clientMessage} (${signal})`
const breaker = (h: ReturnType<typeof fastRouter>, id = "sub") =>
  h.health.stateOf(id).breaker.status
const resetAt = new Date(RESET_SECONDS * 1000).toISOString()

describe("the request wall names the signal that ended it", () => {
  test("a permanent refusal on a one-account chain", async () => {
    const h = fastRouter(() => anthropicError(400, "invalid_request_error", GATED))
    const { response, error, router } = await ask(h)
    expect(response.status).toBe(400)
    expect(error.message).toBe(EXTRA_USAGE_GATED)
    expect(response.headers.get("retry-after")).toBeNull()
    expect(router).toMatchObject({
      wall: "request",
      scope: "request",
      signal: "claude-sdk:extra-usage-gated",
      retryable: false,
      reset_at: null,
      retry_after_s: null,
    })
    expect(breaker(h)).toBe("active")
  })

  test("two non-permanent refusals in one chain end it by count", async () => {
    const h = fastRouter(() => anthropicError(429, "rate_limit_error", OUT_OF_EXTRA), {
      accounts: 2,
    })
    const { response, error, router } = await ask(h)
    expect(response.status).toBe(400)
    expect(response.headers.get("retry-after")).toBeNull()
    expect(error.message).toBe(EXTRA_USAGE_SPENT)
    expect(router).toMatchObject({
      wall: "request",
      scope: "request",
      signal: "claude-sdk:extra-usage-gated",
      retryable: false,
      reset_at: null,
      retry_after_s: null,
    })
    expect(breaker(h, "sub")).toBe("active")
    expect(breaker(h, "sub-2")).toBe("active")
  })
})

describe("out of extra usage on a chain the request wall did not end", () => {
  test("keeps its 429 on a one-account chain, a clock clears it", async () => {
    const h = fastRouter(() => anthropicError(429, "rate_limit_error", OUT_OF_EXTRA))
    const { response, error, router } = await ask(h)
    expect(response.status).toBe(429)
    expect(error.type).toBe("rate_limit_error")
    expect(error.message).toBe(sentence(EXTRA_USAGE_SPENT, "claude-sdk:extra-usage-gated"))
    expect(router).toMatchObject({
      wall: "clock",
      scope: "account",
      signal: "claude-sdk:extra-usage-gated",
      retryable: true,
      reset_at: null,
    })
    expect(response.headers.get("retry-after")).toBe(String(router.retry_after_s))
    expect(breaker(h)).toBe("active")
  })
})

describe("a spent plan window carries its reset", () => {
  const cases = [
    ["claude-sdk:rate-limited", "Usage limit reached", WINDOW_SPENT],
    ["claude-sdk:plan-window-spent", "You've hit your weekly limit", WINDOW_SPENT],
    [
      "claude-sdk:overage-required",
      "Extra usage is required for long context requests.",
      "the account's plan does not cover the extended-context variant of this model",
    ],
  ] as const
  for (const [signal, text, clientMessage] of cases) {
    test(signal, async () => {
      const h = fastRouter(() => anthropicError(429, "rate_limit_error", text, spentWindow))
      const { response, error, router } = await ask(h)
      expect(response.status).toBe(429)
      expect(error.message).toBe(sentence(clientMessage, signal))
      expect(router).toMatchObject({
        wall: "clock",
        scope: "account",
        signal,
        retryable: true,
        reset_at: resetAt,
        retry_after_s: 3600,
      })
      expect(response.headers.get("retry-after")).toBe("3600")
      expect(breaker(h)).toBe("cooling_down")
    })
  }

  test("a model-family window holds that model and leaves the account active", async () => {
    const h = fastRouter(() =>
      anthropicError(429, "rate_limit_error", "You've hit your Opus limit", {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-representative-claim": "seven_day_opus",
        "anthropic-ratelimit-unified-reset": String(RESET_SECONDS),
      }),
    )
    const { response, error, router } = await ask(h)
    expect(response.status).toBe(429)
    expect(error.message).toBe(
      sentence(
        "the account's Claude subscription window for this model is spent",
        "claude-sdk:model-window-spent",
      ),
    )
    expect(router).toMatchObject({
      wall: "clock",
      scope: "account",
      signal: "claude-sdk:model-window-spent",
      retryable: true,
      reset_at: resetAt,
    })
    expect(response.headers.get("retry-after")).toBe(String(router.retry_after_s))
    expect(breaker(h)).toBe("active")
    expect(h.health.stateOf("sub").refusedModels?.has("claude-opus-5-5")).toBe(true)
    expect(h.health.stateOf("sub").refusedModels?.has("claude-sonnet-5")).toBe(false)
  })
})

describe("a bare upstream throttle", () => {
  test("a stated retry-after is the wait, and does not cool the account through the limiter", async () => {
    const h = fastRouter(() =>
      anthropicError(429, "rate_limit_error", "Number of request tokens has exceeded your limit.", {
        "retry-after": "17",
      }),
    )
    const { response, error, router } = await ask(h)
    expect(response.status).toBe(429)
    expect(error.message).toBe(sentence(WINDOW_SPENT, "claude-sdk:api-status-429"))
    expect(router).toMatchObject({
      wall: "clock",
      scope: "account",
      signal: "claude-sdk:api-status-429",
      retryable: true,
      retry_after_s: 17,
      reset_at: new Date(h.clock.now().getTime() + 17_000).toISOString(),
      reset_source: "provider-reported",
    })
    expect(response.headers.get("retry-after")).toBe("17")
    expect(breaker(h)).toBe("cooling_down")
    // The breaker's own estimate, not the header's 17 s: the header cools nothing.
    const cooling = h.health.stateOf("sub").breaker
    expect(cooling.cooldownSource).toBe("estimated")
    expect(cooling.cooldownUntil?.getTime()).toBeLessThan(h.clock.now().getTime() + 17_000)
    // The header is the verdict's alone: it never reaches the account's quota reading.
    expect(h.quota.snapshot("sub", h.clock.now())).toBeNull()
  })

  test("no header and no reading states no reset and invents no source", async () => {
    const h = fastRouter(
      () => anthropicError(429, "rate_limit_error", "Number of request tokens has exceeded."),
      { unknownResetRetryAfterSeconds: 47 },
    )
    const { response, router } = await ask(h)
    expect(response.status).toBe(429)
    expect(router.reset_at).toBeNull()
    expect(router.reset_source ?? null).toBeNull()
    // The operator's knob, not core's default of 30.
    expect(router.retry_after_s).toBe(47)
    expect(response.headers.get("retry-after")).toBe("47")
  })

  // Read by the same parser the HTTP path uses (`rate-limit/parse.ts`): `delay-seconds` digits or
  // an HTTP-date. A hex or exponent number is neither, so it states no wait.
  for (const header of ["1e9", "0x10"]) {
    test(`a retry-after of ${header} is not a wait, so the operator's wait answers`, async () => {
      const h = fastRouter(
        () =>
          anthropicError(429, "rate_limit_error", "Number of request tokens has exceeded.", {
            "retry-after": header,
          }),
        { unknownResetRetryAfterSeconds: 47 },
      )
      const { response, router } = await ask(h)
      expect(response.status).toBe(429)
      expect(router.reset_at).toBeNull()
      expect(router.reset_source ?? null).toBeNull()
      expect(router.retry_after_s).toBe(47)
      expect(response.headers.get("retry-after")).toBe("47")
    })
  }

  test("a retry-after HTTP-date is the reset", async () => {
    const at = new Date(NOW.getTime() + 120_000)
    const h = fastRouter(
      () =>
        anthropicError(429, "rate_limit_error", "Number of request tokens has exceeded.", {
          "retry-after": at.toUTCString(),
        }),
      { unknownResetRetryAfterSeconds: 47 },
    )
    const { response, router } = await ask(h)
    expect(response.status).toBe(429)
    expect(router).toMatchObject({
      reset_at: at.toISOString(),
      reset_source: "provider-reported",
      retry_after_s: 120,
    })
    expect(response.headers.get("retry-after")).toBe("120")
    expect(h.quota.snapshot("sub", h.clock.now())).toBeNull()
  })
})

describe("an overloaded upstream", () => {
  test("answers 503 upstream_overloaded with the stated wait, and strikes nothing", async () => {
    const h = fastRouter(() =>
      anthropicError(529, "overloaded_error", "Overloaded", { "retry-after": "9" }),
    )
    const { response, error, router } = await ask(h)
    expect(response.status).toBe(503)
    expect(error.type).toBe("overloaded_error")
    expect(error.message).toBe("upstream overloaded (claude-sdk:overloaded)")
    expect(router).toMatchObject({
      wall: "clock",
      scope: "account",
      signal: "claude-sdk:overloaded",
      retryable: true,
      reset_at: null,
      retry_after_s: 9,
    })
    expect(response.headers.get("retry-after")).toBe("9")
    expect(breaker(h)).toBe("active")
  })

  test("no header takes the operator's wait", async () => {
    const h = fastRouter(() => anthropicError(529, "overloaded_error", "Overloaded"), {
      unknownResetRetryAfterSeconds: 47,
    })
    const { response, router } = await ask(h)
    expect(response.status).toBe(503)
    expect(router.retry_after_s).toBe(47)
    expect(router.reset_at).toBeNull()
  })
})
