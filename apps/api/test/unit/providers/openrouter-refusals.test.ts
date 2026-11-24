import { describe, expect, test } from "bun:test"
import { httpDriver } from "../../../src/providers"
import { response } from "./fixtures"

const openrouter = httpDriver("openrouter")

function classify(status: number, message: string) {
  return openrouter?.classifyFailure(
    response(status, { body: { error: { message, code: status } } }),
  )
}

const unaffordable = (limit: string) =>
  `This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 3041. To increase, visit https://openrouter.ai/settings/keys and create a key with a higher ${limit} limit`

describe("a key cap that cannot cover the request (#441)", () => {
  test.each(["daily", "weekly", "monthly"])("a %s cap reopens on a clock", (limit) => {
    const result = classify(402, unaffordable(limit))

    expect(result?.kind).toBe("rate-limited")
    expect(result?.signal).toBe("openrouter:key-limit-window")
    expect(result?.rateLimit?.retryAfterSeconds).toBe(3600)
    expect(result?.rateLimit?.resetSource).toBe("estimated")
  })

  test("a total cap, and a drained balance, stay a human's", () => {
    expect(classify(402, unaffordable("total"))?.kind).toBe("credits-exhausted")
    expect(classify(402, "Insufficient credits. Add more using …")?.kind).toBe("credits-exhausted")
  })
})

/** A refusal as OpenRouter documents it, with its `error.metadata`. */
function stated(status: number, message: string, metadata: Record<string, unknown>) {
  const reply = response(status, { body: { error: { message, code: status, metadata } } })
  return openrouter?.classifyFailure(reply)
}

describe("whether a credits refusal may be the key's own cap (review of #504)", () => {
  test.each([
    unaffordable("total"),
    "Key limit exceeded (total limit). Manage it using https://openrouter.ai/workspaces/x/keys",
    "This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 3041.",
  ])("names the key, or nothing: %s", (message) => {
    const result = classify(message.startsWith("Key") ? 403 : 402, message)

    expect(result?.kind).toBe("credits-exhausted")
    expect(result?.keyCap).toBe(true)
  })

  test.each([
    "Insufficient credits. Add more using https://openrouter.ai/settings/credits",
    "Insufficient credits. This account never purchased credits. Make sure your key is on the correct account or org, and if so, purchase more at https://openrouter.ai/settings/credits",
    "This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 1600. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account",
    "This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 1600. To increase, visit https://openrouter.ai/settings/credits and add more credits",
  ])("names the balance, which no key reset refills: %s", (message) => {
    const result = classify(402, message)

    expect(result?.kind).toBe("credits-exhausted")
    expect(result?.keyCap).toBeUndefined()
  })

  test("limit_source decides over the wording", () => {
    const bare = "This request requires more credits, or fewer max_tokens."
    const balance = stated(402, bare, { limit_source: "openrouter_credits" })
    expect(balance?.kind).toBe("credits-exhausted")
    expect(balance?.keyCap).toBeUndefined()

    const key = stated(402, `${bare} Add more using https://openrouter.ai/settings/credits`, {
      limit_source: "openrouter_key_limit",
    })
    expect(key?.kind).toBe("credits-exhausted")
    expect(key?.keyCap).toBe(true)
  })
})

describe("what error.metadata states", () => {
  const resetsAt = "2126-10-12T00:00:00.000Z"

  test.each([
    ["openrouter_key_limit", "Key limit exceeded (total limit)."],
    ["openrouter_guardrail_budget", "Org member budget limit exceeded (weekly limit)."],
    ["openrouter_workspace_budget", "Workspace budget limit exceeded (monthly limit)."],
  ])("a %s that names its reset is a clock, with that reset", (source, message) => {
    const result = stated(403, message, { limit_source: source, resets_at: resetsAt })

    expect(result?.kind).toBe("rate-limited")
    expect(result?.rateLimit?.resetsAt).toEqual(new Date(resetsAt))
    expect(result?.rateLimit?.resetSource).toBe("provider-reported")
  })

  test("a lifetime budget is a human's, never a refused credential", () => {
    const result = stated(403, "Workspace budget limit exceeded (total limit).", {
      limit_source: "openrouter_workspace_budget",
      resets_at: null,
    })

    expect(result?.kind).toBe("credits-exhausted")
    expect(result?.keyCap).toBeUndefined()
  })

  test("requests in flight fill a budget that settles by itself", () => {
    const message =
      "This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits."
    const body = {
      error: {
        code: 402,
        message,
        metadata: {
          reason: "in_flight_budget_exhausted",
          limit_source: "openrouter_in_flight_budget",
        },
      },
    }
    const result = openrouter?.classifyFailure(
      response(402, { body, headers: { "retry-after": "20" } }),
    )

    expect(result?.kind).toBe("rate-limited")
    expect(result?.rateLimit?.retryAfterSeconds).toBe(20)
  })

  test("one request larger than the whole budget parks no account", () => {
    const result = stated(402, "This request would exceed your available credits.", {
      reason: "weight_exceeds_budget",
      limit_source: "openrouter_credits",
    })

    expect(result?.kind).toBe("invalid-request")
    expect(result?.accountScoped).toBe(true)
  })

  test("a metadata field of another shape costs only itself", () => {
    const result = stated(402, "Insufficient credits. Add more using …", {
      limit_source: 7,
      resets_at: "soon",
    })
    expect(result?.kind).toBe("credits-exhausted")
  })

  test("metadata on any other status decides nothing", () => {
    const result = stated(400, "bad request", {
      limit_source: "openrouter_key_limit",
      resets_at: resetsAt,
    })
    expect(result?.kind).toBe("invalid-request")
    expect(result?.rateLimit).toBeNull()
  })
})

test("a prompt too large for what a resetting cap has left waits for the cap", () => {
  const result = classify(
    402,
    "Prompt tokens limit exceeded: 13485 > 561. To increase, visit https://openrouter.ai/workspaces/x/keys/y and adjust the key's monthly limit",
  )
  expect(result?.kind).toBe("rate-limited")
  expect(result?.signal).toBe("openrouter:key-limit-window")
  expect(result?.keyCap).toBe(true)
})

describe("no endpoint left", () => {
  test.each([
    "No endpoints found for the request with quantization: fp8,bf16. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection",
    "No endpoints found that support tool use. To learn more about provider routing, visit: https://openrouter.ai/docs/provider-routing",
    "No endpoints found matching your data policy (Free model training).",
  ])("the account's own filters move it to the next account, sibling included: %s", (message) => {
    const result = classify(404, message)

    expect(result?.kind).toBe("invalid-request")
    expect(result?.accountScoped).toBe(true)
    expect(result?.providerScoped).toBeUndefined()
  })

  test("an id nothing serves is the model's", () => {
    const result = classify(404, "No endpoints found for inception/mercury-2.")

    expect(result?.kind).toBe("model-unsupported")
    expect(result?.accountScoped).toBeUndefined()
  })

  test("any other 404 is still the client's", () => {
    expect(classify(404, "Not found")?.accountScoped).toBeUndefined()
  })
})

// Review of #506: `openrouter_credits` had no verdict of its own. A `403` naming it in neutral
// words, with no numeric `error.code`, matched no wording rule and fell to the status: `auth`, a
// refused credential, for an account that only needs a top-up.
describe("the balance, as limit_source states it", () => {
  const neutral = (status: number, metadata: Record<string, unknown>) =>
    openrouter?.classifyFailure(
      response(status, {
        body: { error: { message: "Request could not be completed", metadata } },
      }),
    )

  test.each([402, 403])(
    "a %d naming openrouter_credits is a spent balance, whatever it says",
    (s) => {
      const result = neutral(s, { limit_source: "openrouter_credits" })

      expect(result?.kind).toBe("credits-exhausted")
      expect(result?.signal).toBe("openrouter:credits")
      expect(result?.namesBalance).toBe(true)
      expect(result?.keyCap).toBeUndefined()
    },
  )

  test("one request larger than the in-flight budget is still that request's, not the balance", () => {
    const result = neutral(402, {
      limit_source: "openrouter_credits",
      reason: "weight_exceeds_budget",
    })

    expect(result?.kind).toBe("invalid-request")
    expect(result?.signal).toBe("openrouter:request-over-budget")
    expect(result?.namesBalance).toBeUndefined()
  })

  test("the balance decides over wording that names a key limit", () => {
    const result = stated(402, unaffordable("daily"), { limit_source: "openrouter_credits" })

    expect(result?.kind).toBe("credits-exhausted")
    expect(result?.namesBalance).toBe(true)
    expect(result?.keyCap).toBeUndefined()
  })

  test("wording alone that names the balance carries the same evidence", () => {
    const worded = classify(
      402,
      "Insufficient credits. Add more using https://openrouter.ai/settings/credits",
    )

    expect(worded?.kind).toBe("credits-exhausted")
    expect(worded?.namesBalance).toBe(true)
    expect(worded?.keyCap).toBeUndefined()
  })

  test("a refusal naming the key, or nothing, does not claim the balance", () => {
    expect(classify(402, unaffordable("total"))?.namesBalance).toBeUndefined()
    expect(stated(402, "x", { limit_source: "openrouter_key_limit" })?.namesBalance).toBeUndefined()
  })
})
