import { describe, expect, test } from "bun:test"
import { QuotaExhaustedError } from "@multi-ai-router/core"
import { type ErrorBody, toErrorResponse } from "../../../src/errors/render"
import type { RouterErrorObject } from "../../../src/errors/router-object"
import { toRouterError } from "../../../src/providers/failure/router-error"
import { providerModelFamily } from "../../../src/providers/registry"
import { type AccountSnapshot, selectAccounts } from "../../../src/services/routing"
import { account, health, NOW, snapshot } from "./fixtures"

/**
 * The `Retry-After` header and `error.router.reset_at` describe one instant: the reset of the
 * nearest account that can serve the model the request named, inside the caller's scope.
 *
 * Reported from the platform side (2026-11-16 01:49 UTC): a Claude model refused with a ~30 s reset
 * in the body while `Retry-After` carried a ChatGPT account's weekly reset. These pin the property
 * on every producer of a router-authored `429` reached by routing: the scope-wide verdict
 * (`no-candidates.ts`) in both orders of the two resets, and the account's own upstream answer
 * (`providers/failure/router-error.ts`); and that a model nothing in scope serves gets no wait at all.
 */

const DAY_MS = 86_400_000
const CLAUDE_MODEL = "claude-sonnet-4-5"

function withFamily(id: string, provider: AccountSnapshot["provider"], overrides = {}) {
  const family = providerModelFamily(provider)
  return account(id, {
    provider,
    ...(family === undefined ? {} : { modelFamily: family }),
    ...overrides,
  })
}

function cooling(untilMs: number) {
  return {
    status: "cooling_down" as const,
    health: health({
      cooldownUntil: new Date(NOW.getTime() + untilMs),
      cooldownSource: "provider-reported",
    }),
  }
}

function refuse(accounts: readonly AccountSnapshot[], model: string) {
  const selection = selectAccounts(snapshot([...accounts]), {
    sessionKey: "s",
    model,
    keyScope: { kind: "accounts", accountIds: accounts.map((entry) => entry.id) },
    rotationCounter: 0,
  })
  if (selection.ok) throw new Error("expected a refusal")
  const rendered = toErrorResponse(selection.error, "anthropic")
  const router = routerOf(rendered.body)
  return { rendered, router }
}

function routerOf(body: ErrorBody): RouterErrorObject {
  const router = body.error.router
  if (router === undefined) throw new Error("expected error.router")
  return router
}

function headerInstant(retryAfterSeconds: number | null): number | null {
  return retryAfterSeconds === null ? null : NOW.getTime() + retryAfterSeconds * 1000
}

describe("a pool-wide refusal: header and body name the same, model-relevant reset", () => {
  test("Claude cooling 30 s, ChatGPT cooling a week: both say 30 s", () => {
    const { rendered, router } = refuse(
      [
        withFamily("claude-sub", "anthropic-oauth", cooling(30_000)),
        withFamily("chatgpt", "openai-oauth", cooling(6 * DAY_MS)),
      ],
      CLAUDE_MODEL,
    )
    expect(rendered.status).toBe(429)
    expect(rendered.retryAfterSeconds).toBe(30)
    expect(router.reset_at).toBe(new Date(NOW.getTime() + 30_000).toISOString())
    expect(headerInstant(rendered.retryAfterSeconds)).toBe(Date.parse(String(router.reset_at)))
  })

  test("Claude cooling a week, ChatGPT cooling 30 s: the ChatGPT clock is not the answer", () => {
    const { rendered, router } = refuse(
      [
        withFamily("claude-sub", "anthropic-oauth", cooling(6 * DAY_MS)),
        withFamily("chatgpt", "openai-oauth", cooling(30_000)),
      ],
      CLAUDE_MODEL,
    )
    expect(rendered.retryAfterSeconds).toBe((6 * DAY_MS) / 1000)
    expect(router.reset_at).toBe(new Date(NOW.getTime() + 6 * DAY_MS).toISOString())
  })

  test("a model nothing in scope can serve gets no Retry-After and is not retryable", () => {
    const { rendered, router } = refuse(
      [withFamily("chatgpt", "openai-oauth", cooling(30_000))],
      CLAUDE_MODEL,
    )
    expect(rendered.status).toBe(404)
    expect(rendered.retryAfterSeconds).toBeNull()
    expect(router.retryable).toBe(false)
    expect(router.reset_at).toBeNull()
  })
})

describe("one account's own 429: header and body name the same instant", () => {
  test("a short Retry-After beside a weekly window reset still renders one instant", () => {
    // The shape of a reply that states both: a short `retry-after` and a weekly window's reset.
    const weekly = new Date(NOW.getTime() + 6 * DAY_MS)
    const error = toRouterError(
      {
        kind: "rate-limited",
        status: 429,
        retryable: true,
        signal: "http-status:429",
        rateLimit: {
          limited: true,
          retryAfterSeconds: 30,
          resetsAt: weekly,
          resetSource: "provider-reported",
          windows: [],
        },
      },
      { signal: null, now: NOW },
    )
    if (!(error instanceof QuotaExhaustedError)) throw new Error("expected a quota error")
    const rendered = toErrorResponse(error, "anthropic")
    const router = routerOf(rendered.body)
    if (router.reset_at === null) {
      expect(rendered.retryAfterSeconds).not.toBeNull()
      return
    }
    const header = headerInstant(rendered.retryAfterSeconds) ?? 0
    // Whole seconds on the header; the body may carry the provider's sub-second instant.
    expect(Math.abs(header - Date.parse(String(router.reset_at)))).toBeLessThan(1_000)
  })
})
