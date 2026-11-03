import { describe, expect, test } from "bun:test"
import { account, jsonResponse, subscriptionAccount } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, KEY, MESSAGE, post, settle } from "./harness"

/**
 * `POST /v1/messages/count_tokens`, end to end: real Hono, real middleware, real routing, **mocked
 * upstreams**.
 *
 * Claude Code calls this before a turn to decide when to compact, so a router that 404s it is a
 * router that client half-works against. The rules this suite pins down:
 *
 *  - it is an ordinary data-plane request — same key, same scope, same failover chain;
 *  - a count is a statement about one provider's tokenizer, so an account that can count answers
 *    with **its own number**, relayed byte for byte;
 *  - a scope holding **nothing but Claude subscriptions** cannot be asked (the Agent SDK exposes
 *    no counting call), and there the router answers itself — with an **explicitly labelled
 *    estimate**, never a bare number a client could mistake for a measurement;
 *  - any other scope that cannot count is refused **by name**, never approximated for;
 *  - the number measures a prompt nobody ran, so it is never priced and never counted as tokens.
 */

const COUNT = JSON.stringify({
  model: "claude-opus-5",
  messages: [{ role: "user", content: "how many tokens is this" }],
})

const COUNTED = () => jsonResponse(200, { input_tokens: 4531 })

/** The body an estimate answers with: Anthropic's shape plus the label that says it is ours. */
interface EstimatedCount {
  readonly input_tokens: number
  readonly estimated: boolean
  readonly estimate_basis: string
}

async function estimateOf(res: Response): Promise<EstimatedCount> {
  return (await res.json()) as EstimatedCount
}

/** A subscription pool that would spawn a CLI if anything ever asked it to. */
function subscriptionPool(ids: readonly string[] = ["sub"]) {
  const invoked: string[] = []
  return {
    invoked,
    options: {
      accounts: ids.map((id) => subscriptionAccount(id)),
      responses: [COUNTED],
      invokeSdk: async ({ configDir }: { configDir: string }) => {
        invoked.push(configDir)
        return jsonResponse(200, {})
      },
    },
  }
}

describe("passthrough", () => {
  test("forwards the body byte for byte to Anthropic's own suffix", async () => {
    const { app, upstream } = harness({ responses: [COUNTED] })

    const res = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))

    expect(res.status).toBe(200)
    // Exactly the provider's body: a measurement carries no label, because it is not one of ours.
    expect(await res.json()).toEqual({ input_tokens: 4531 })
    const call = upstream.calls[0]
    expect(call?.url).toBe("https://upstream.test/v1/messages/count_tokens")
    expect(call?.method).toBe("POST")
    expect(call?.body).toBe(COUNT)
    // The router key never leaves; the account's credential is what the upstream sees.
    expect(call?.headers.get("x-api-key")).toBe("sk-one")
    expect(call?.headers.get("authorization")).toBeNull()
  })

  test("accepts the Anthropic key form too, and answers in the Anthropic error shape", async () => {
    const { app } = harness({ responses: [COUNTED] })

    expect(
      (await app.request("/v1/messages/count_tokens", post(COUNT, { "x-api-key": KEY }))).status,
    ).toBe(200)

    const unauthorized = await app.request("/v1/messages/count_tokens", post(COUNT))
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toMatchObject({
      type: "error",
      error: { type: "authentication_error" },
    })
  })

  test("applies the account's alias map, because the count must name the model upstream bills", async () => {
    const { app, upstream } = harness({
      accounts: [
        account("acct-1", {
          provider: "anthropic-compatible",
          apiKey: "sk-compat",
          cipher: CRYPTOR,
          modelAliases: { "claude-opus-5": "some-other-model" },
        }),
      ],
      responses: [COUNTED],
    })

    await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))

    const sent = JSON.parse(upstream.calls[0]?.body ?? "{}") as Record<string, unknown>
    expect(sent.model).toBe("some-other-model")
  })

  test("relays the upstream's own refusal instead of inventing a number", async () => {
    // An Anthropic-compatible vendor that never implemented the endpoint. Its 404 is the honest
    // answer and it reaches the client unchanged.
    const { app } = harness({
      accounts: [
        account("compat", {
          provider: "anthropic-compatible",
          apiKey: "sk-compat",
          cipher: CRYPTOR,
        }),
      ],
      responses: [() => jsonResponse(404, { type: "error", error: { type: "not_found_error" } })],
    })

    const res = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { type: "not_found_error" } })
  })
})

describe("routing", () => {
  test("fails over exactly like inference does", async () => {
    const { app, upstream, usage } = harness({
      accounts: [
        account("acct-1", { apiKey: "sk-one", cipher: CRYPTOR }),
        account("acct-2", { apiKey: "sk-two", cipher: CRYPTOR }),
      ],
      responses: [() => jsonResponse(429, {}), COUNTED],
    })

    const res = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect(upstream.calls).toHaveLength(2)
    expect(upstream.calls[1]?.url).toContain("/count_tokens")
    expect(usage.rows.map((row) => row.outcome)).toEqual(["quota_exhausted", "success"])
  })

  test("a mixed pool answers off the one account that can count", async () => {
    const invoked: string[] = []
    const { app, upstream } = harness({
      accounts: [subscriptionAccount("sub"), account("api", { apiKey: "sk-api", cipher: CRYPTOR })],
      responses: [COUNTED],
      invokeSdk: async ({ configDir }) => {
        invoked.push(configDir)
        return jsonResponse(200, {})
      },
    })

    const res = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))

    expect(res.status).toBe(200)
    // The provider's own measurement, not an estimate of ours: one account in the pool can count,
    // so there is nothing to estimate.
    expect(await res.json()).toEqual({ input_tokens: 4531 })
    expect(upstream.calls[0]?.headers.get("x-api-key")).toBe("sk-api")
    // The subscription was dropped at planning, never attempted — no subprocess, ever.
    expect(invoked).toEqual([])
  })

  test("scope still decides the candidate set", async () => {
    const { app, upstream } = harness({
      accounts: [account("acct-1", { apiKey: "sk-one", cipher: CRYPTOR })],
      scope: "accounts",
      accountIds: [],
      responses: [COUNTED],
    })

    expect((await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))).status).toBe(403)
    expect(upstream.calls).toHaveLength(0)
  })
})

describe("a scope of nothing but Claude subscriptions", () => {
  test("answers with an explicitly labelled estimate, never a bare number", async () => {
    const { invoked, options } = subscriptionPool()
    const { app } = harness(options)

    const res = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))
    const body = await estimateOf(res)

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    // The Anthropic field name, so an unmodified client reads it as a compaction threshold …
    expect(body.input_tokens).toBeGreaterThan(0)
    expect(Number.isInteger(body.input_tokens)).toBe(true)
    // … and the label, so nobody can mistake it for a measurement a provider made.
    expect(body.estimated).toBe(true)
    expect(typeof body.estimate_basis).toBe("string")
    expect(body.estimate_basis.length).toBeGreaterThan(0)
    expect(body.estimate_basis.length).toBeLessThan(100)
    // The three travel together, always: an estimate that answered with `input_tokens` alone
    // would be a fabricated measurement wearing a provider's field name.
    expect(Object.keys(body).sort()).toEqual(["estimate_basis", "estimated", "input_tokens"])
    // Nothing was forged at api.anthropic.com and no subprocess was launched to guess a count.
    expect(invoked).toEqual([])
  })

  test("leaves the subscription healthy — an estimate is not an outage", async () => {
    const { invoked, options } = subscriptionPool()
    const { app, health, upstream } = harness(options)

    await (await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))).text()
    await settle()

    // No upstream was addressed, so no account was touched: not cooled down, not failed, not
    // left with an attempt in flight.
    expect(upstream.calls).toHaveLength(0)
    expect(invoked).toEqual([])
    const state = health.stateOf("sub")
    expect(state.breaker.status).toBe("active")
    expect(state.breaker.cooldownUntil).toBeUndefined()
    expect(state.breaker.consecutiveFailures).toBe(0)
    expect(state.inFlight).toBe(0)
  })

  test("is a pure function of the body: the same body estimates the same, a bigger one more", async () => {
    const { options } = subscriptionPool()
    const { app } = harness(options)

    const short = JSON.stringify({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hi" }],
    })
    const long = JSON.stringify({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "word ".repeat(400) }],
    })

    const first = await estimateOf(
      await app.request("/v1/messages/count_tokens", post(COUNT, bearer())),
    )
    const again = await estimateOf(
      await app.request("/v1/messages/count_tokens", post(COUNT, bearer())),
    )
    const fewer = await estimateOf(
      await app.request("/v1/messages/count_tokens", post(short, bearer())),
    )
    const bigger = await estimateOf(
      await app.request("/v1/messages/count_tokens", post(long, bearer())),
    )

    // No clock, no I/O, no store: the same bytes always produce the same number.
    expect(again.input_tokens).toBe(first.input_tokens)
    expect(again.estimate_basis).toBe(first.estimate_basis)
    // And it tracks the size of the prompt, which is the only thing it can see.
    expect(fewer.input_tokens).toBeLessThan(first.input_tokens)
    expect(bigger.input_tokens).toBeGreaterThan(first.input_tokens)
  })

  test("the estimate tracks punctuation the prompt grew by, not just its words", async () => {
    // The reviewer's fingerprint, end to end: punctuation inside a prompt string is prompt. An
    // estimate that filtered JSON punctuation characters out of the raw body also filtered them
    // out of prompt strings, so this content could grow by 100,000 colons and move no number —
    // and a client compacting on the estimate would compact too late.
    const { options } = subscriptionPool()
    const { app } = harness(options)

    const before = JSON.stringify({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hi" }],
    })
    const after = JSON.stringify({
      model: "claude-opus-5",
      messages: [{ role: "user", content: `hi${":".repeat(100000)}` }],
    })

    const fewer = await estimateOf(
      await app.request("/v1/messages/count_tokens", post(before, bearer())),
    )
    const bigger = await estimateOf(
      await app.request("/v1/messages/count_tokens", post(after, bearer())),
    )

    expect(bigger.input_tokens).toBeGreaterThan(fewer.input_tokens)
  })

  test("still estimates when the pool holds several subscriptions", async () => {
    const { invoked, options } = subscriptionPool(["sub-a", "sub-b"])
    const { app } = harness(options)

    const res = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))

    expect(res.status).toBe(200)
    expect((await estimateOf(res)).estimated).toBe(true)
    expect(invoked).toEqual([])
  })

  test("is not served when the key's scope reaches no subscription", async () => {
    // Scope is decided before anything is planned, so an estimate can never widen it.
    const { options } = subscriptionPool()
    const { app, upstream } = harness({ ...options, scope: "accounts", accountIds: [] })

    const res = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))

    expect(res.status).toBe(403)
    expect(upstream.calls).toHaveLength(0)
  })

  test("is not served over a clock-recoverable condition", async () => {
    // A subscription the router is waiting on is not one it may paper over with a number: the
    // condition is one a clock resolves, so the honest answer is a `429` with a `Retry-After`, not
    // an estimate that pretends the pool is fine.
    const { options } = subscriptionPool()
    const { app } = harness({
      ...options,
      accounts: [subscriptionAccount("sub", { snapshot: { status: "cooling_down" } })],
    })

    const res = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))
    const body = (await res.json()) as { error?: { type: string }; estimated?: boolean }

    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).not.toBeNull()
    expect(body.error?.type).toBe("rate_limit_error")
    expect(body).not.toHaveProperty("estimated")
    expect(body).not.toHaveProperty("input_tokens")
  })

  test("one cooling subscription beside a healthy one still holds the whole scope back", async () => {
    // The scope holds two subscriptions and one of them is cooling down. An account held back by
    // health is a fact about the pool that outranks the router's own arithmetic.
    const { options } = subscriptionPool()
    const { app } = harness({
      ...options,
      accounts: [
        subscriptionAccount("cool", { snapshot: { status: "cooling_down" } }),
        subscriptionAccount("warm"),
      ],
    })

    const res = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))
    const body = (await res.json()) as { error?: { type: string }; estimated?: boolean }

    expect(res.status).toBe(429)
    expect(body).not.toHaveProperty("estimated")
  })
})

describe("accounts that cannot count", () => {
  test("an openai-only pool is refused too, rather than counted with the wrong tokenizer", async () => {
    const { app, upstream } = harness({
      accounts: [account("o", { provider: "openai-api", apiKey: "sk-o", cipher: CRYPTOR })],
      responses: [COUNTED],
    })

    const res = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))
    const body = (await res.json()) as { error: { message: string } }

    expect(res.status).toBe(503)
    expect(body.error.message).toContain("cannot count tokens")
    expect(body.error.message).toContain("openai-chat")
    expect(upstream.calls).toHaveLength(0)
  })

  test("a subscription beside an OpenAI account does not make the scope estimable", async () => {
    // The scope is not one of subscriptions, so there is a provider-shaped gap in it and the
    // refusal says so. An estimate here would hide that gap behind a plausible number.
    const { app, upstream } = harness({
      accounts: [
        subscriptionAccount("sub"),
        account("o", { provider: "openai-api", apiKey: "sk-o", cipher: CRYPTOR }),
      ],
      responses: [COUNTED],
      invokeSdk: async () => jsonResponse(200, {}),
    })

    const res = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))
    const body = (await res.json()) as { error: { message: string }; estimated?: boolean }

    expect(res.status).toBe(503)
    expect(body.error.message).toContain("cannot count tokens")
    expect(body).not.toHaveProperty("estimated")
    expect(upstream.calls).toHaveLength(0)
  })

  test("inference over that same pool still works — only the count is narrowed", async () => {
    const { app } = harness({
      accounts: [account("o", { provider: "openai-api", apiKey: "sk-o", cipher: CRYPTOR })],
      responses: [
        () =>
          jsonResponse(200, {
            id: "chatcmpl-1",
            model: "claude-opus-5",
            choices: [
              { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 11, completion_tokens: 22 },
          }),
      ],
    })

    expect((await app.request("/v1/messages", post(MESSAGE, bearer()))).status).toBe(200)
  })
})

describe("an account that could count, held back by its health", () => {
  test("is a 429 with Retry-After, not a 503 saying no account can count", async () => {
    // The pool holds exactly one account that can count and one that never could. The countable one
    // cools down; the other is dropped at planning, so the chain empties. Reporting the *plan's*
    // reason there tells the operator to add an Anthropic account they already have, and hands the
    // client a permanent-looking refusal for a condition a clock fixes — the `cooling_down` vs
    // `exhausted` conflation non-negotiable 7 forbids, one layer up.
    const { app, usage } = harness({
      accounts: [
        account("anth", { apiKey: "sk-anth", cipher: CRYPTOR }),
        account("oai", { provider: "openai-api", apiKey: "sk-oai", cipher: CRYPTOR }),
      ],
      responses: [() => jsonResponse(429, {}, { "retry-after": "37" })],
    })

    // First request cools the countable account down.
    await (await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))).text()
    await settle()

    const res = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))
    const body = (await res.json()) as { error: { message: string; type: string } }
    await settle()

    expect(res.status).toBe(429)
    expect(res.status).not.toBe(503)
    expect(res.headers.get("Retry-After")).toBe("37")
    expect(body.error.type).toBe("rate_limit_error")
    // Names the account the operator would wait on, not the one that was never able to count.
    expect(body.error.message).toContain("anth")
    expect(body.error.message).not.toContain("cannot count tokens")
    expect(usage.rows.map((row) => row.outcome)).toEqual(["quota_exhausted", "quota_exhausted"])
  })

  test("a cooling subscription beside an account that cannot count is the named 503", async () => {
    // The scope holds one OpenAI account — which can never count — beside one Claude subscription
    // that is cooling down. A subscription's health says nothing about counting: the Agent SDK
    // states no token-count call, so the subscription could not have answered this request even
    // awake. There is no health verdict to report and no provider-shaped answer to give, so the
    // scope is refused **by name** — the `503` that says what is missing, not a `429` that blames a
    // subscription's cooldown for an operation it never had.
    const { app, upstream } = harness({
      accounts: [
        account("oai", { provider: "openai-api", apiKey: "sk-oai", cipher: CRYPTOR }),
        subscriptionAccount("sub", { snapshot: { status: "cooling_down" } }),
      ],
      responses: [COUNTED],
      invokeSdk: async () => jsonResponse(200, {}),
    })

    const res = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))
    const body = (await res.json()) as {
      error: { message: string; type: string }
      estimated?: boolean
      input_tokens?: number
    }

    expect(res.status).toBe(503)
    expect(body.error.message).toContain("cannot count tokens")
    expect(body.error.message).toContain("openai-chat")
    // Never the estimate, and never a number wearing Anthropic's field name.
    expect(body).not.toHaveProperty("estimated")
    expect(body).not.toHaveProperty("input_tokens")
    // No upstream was addressed and no subprocess was launched: nothing was attempted.
    expect(upstream.calls).toHaveLength(0)
  })

  test("a subscription beside it does not turn the 429 into an estimate", async () => {
    // The scope holds a subscription and a countable account, and the countable one is cooling
    // down. A health verdict on an account that could have counted outranks every answer the
    // router could give itself.
    const { app } = harness({
      accounts: [
        subscriptionAccount("sub"),
        account("anth", { apiKey: "sk-anth", cipher: CRYPTOR }),
      ],
      responses: [() => jsonResponse(429, {}, { "retry-after": "37" })],
      invokeSdk: async () => jsonResponse(200, {}),
    })

    await (await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))).text()
    await settle()

    const res = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))
    const body = (await res.json()) as { error?: { message: string } }

    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("37")
    expect(body.error?.message ?? "").toContain("anth")
    expect(body).not.toHaveProperty("estimated")
  })

  test("inference over that same cooling account still reports the same 429", async () => {
    const { app } = harness({
      accounts: [account("anth", { apiKey: "sk-anth", cipher: CRYPTOR })],
      responses: [() => jsonResponse(429, {}, { "retry-after": "37" })],
    })

    await (await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))).text()
    await settle()

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("37")
  })

  test("but a pool that genuinely cannot count still gets the named 503", async () => {
    // The regression guard for the fix above: an OpenAI account that is perfectly healthy must
    // still surface the operation gap, not be reinterpreted as a capacity problem.
    const { app } = harness({
      accounts: [account("oai", { provider: "openai-api", apiKey: "sk-oai", cipher: CRYPTOR })],
      responses: [COUNTED],
    })

    const res = await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))
    const body = (await res.json()) as { error: { message: string } }

    expect(res.status).toBe(503)
    expect(res.headers.get("Retry-After")).toBeNull()
    expect(body.error.message).toContain("cannot count tokens")
  })
})

describe("accounting", () => {
  test("counts as a request, but never as tokens spent", async () => {
    const { app, usage } = harness({ responses: [COUNTED] })

    await (await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))).text()
    await settle()

    expect(usage.rows).toHaveLength(1)
    // `input_tokens: 4531` measured a prompt nobody ran. Recording it would price a question as a
    // completion and inflate every spend report that sums the column.
    expect(usage.rows[0]).toMatchObject({
      outcome: "success",
      egressMode: "passthrough",
      accountId: "acct-1",
      model: "claude-opus-5",
      tokensIn: 0,
      tokensOut: 0,
      costEstimate: null,
    })
  })

  test("records no cost even on a model the price table knows", async () => {
    // The guard the assertion above cannot make: `claude-opus-5` is priced nowhere, so a row for it
    // comes back `null` whether or not anything decided it should. `claude-sonnet-5` *is* in the
    // shipped table, and zeroed counts against a known rate price as `metered $0.000000` — a free
    // completion, which is not what happened. Nothing was completed at all.
    const priced = JSON.stringify({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "how many tokens is this" }],
    })
    const { app, usage } = harness({ responses: [COUNTED] })

    await (await app.request("/v1/messages/count_tokens", post(priced, bearer()))).text()
    await settle()

    expect(usage.rows[0]).toMatchObject({
      model: "claude-sonnet-5",
      outcome: "success",
      costEstimate: null,
      costBasis: "unknown",
    })
  })

  test("does not price a count that failed either", async () => {
    const priced = JSON.stringify({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "how many tokens is this" }],
    })
    const { app, usage } = harness({
      responses: [() => jsonResponse(500, { type: "error", error: { type: "api_error" } })],
    })

    await (await app.request("/v1/messages/count_tokens", post(priced, bearer()))).text()
    await settle()

    expect(usage.rows[0]).toMatchObject({ costEstimate: null, costBasis: "unknown" })
  })

  test("an ordinary completion on that same model is still priced", async () => {
    // The other half of the rule: this is a narrowing of `count_tokens`, not of pricing.
    const { app, usage } = harness({
      responses: [
        () =>
          jsonResponse(200, {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5",
            content: [{ type: "text", text: "hi" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 11, output_tokens: 22 },
          }),
      ],
    })

    const message = JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
    })
    await (await app.request("/v1/messages", post(message, bearer()))).text()
    await settle()

    expect(usage.rows[0]?.costBasis).toBe("metered")
    expect(usage.rows[0]?.costEstimate).not.toBeNull()
  })

  test("an estimate is a successful request, not a routing failure", async () => {
    const { options } = subscriptionPool()
    const { app, usage } = harness(options)

    await (await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))).text()
    await settle()

    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({
      outcome: "success",
      // No upstream was addressed, so there is no egress path and no account to attribute it to.
      egressMode: null,
      accountId: null,
      provider: null,
      model: "claude-opus-5",
      ingressDialect: "anthropic",
      // The estimate measures a prompt nobody ran, exactly like the passthrough count.
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costEstimate: null,
      costBasis: "unknown",
    })
    // And above all: no row says the request failed for want of a healthy account.
    expect(usage.rows.some((row) => row.outcome === "no_healthy_account")).toBe(false)
    expect(usage.rows.some((row) => row.errorClass === "NoHealthyAccountError")).toBe(false)
    expect(usage.rows[0]?.errorClass ?? null).toBeNull()
  })

  test("an estimate on a model the price table knows is still never priced", async () => {
    // The guard the assertion above cannot make, for the same reason its counterpart exists: a
    // null provider would make the row unpriced whatever anything decided, so the only way to see
    // a priced estimate is a model the table knows *and* a row that claims a provider for it.
    // Zeroed counts against a known rate price as `metered $0.000000` — a free completion, which
    // is not what happened. Nothing was completed at all.
    const priced = JSON.stringify({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "how many tokens is this" }],
    })
    const { options } = subscriptionPool()
    const { app, usage } = harness(options)

    await (await app.request("/v1/messages/count_tokens", post(priced, bearer()))).text()
    await settle()

    expect(usage.rows[0]).toMatchObject({
      model: "claude-sonnet-5",
      outcome: "success",
      costEstimate: null,
      costBasis: "unknown",
    })
  })

  test("writes a row even when no account could count", async () => {
    const { app, usage } = harness({
      accounts: [account("oai", { provider: "openai-api", apiKey: "sk-oai", cipher: CRYPTOR })],
      responses: [COUNTED],
    })

    await app.request("/v1/messages/count_tokens", post(COUNT, bearer()))
    await settle()

    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({
      accountId: null,
      outcome: "no_healthy_account",
      errorClass: "NoHealthyAccountError",
    })
  })
})
