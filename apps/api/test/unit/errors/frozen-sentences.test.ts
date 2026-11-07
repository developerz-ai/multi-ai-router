/**
 * THE OLD SENTENCES, FROZEN. `error.router` (`errors/router-object.ts`) is the contract a client
 * should read, but developerz.ai still matches these words with regexes
 * (`packages/domain/src/value-objects/llm-credential/failure.ts` there: `ROUTER_POOL_RECOVERABLE`,
 * `upstream rate limited`, `earliest reset … (estimated)`). Until it has migrated to the object,
 * a change to any string below breaks a consumer in production: edit one only in the same release
 * that tells developerz.ai, and delete this file once it reads `router` alone.
 *
 * One case per producer of a client-facing wall sentence: `routing/no-candidates.ts`,
 * `providers/failure/router-error.ts`, `dataplane/chain-finish.ts`, the admin plane
 * (`services/admin/result.ts`) and the router event that ends a broken stream
 * (`dataplane/relay-stream-end.ts`). Each also pins the detail it now carries beside the words.
 */

import { describe, expect, test } from "bun:test"
import type { RouterError } from "@multi-ai-router/core"
import { routerErrorObject } from "../../../src/errors/router-object"
import { toRouterError } from "../../../src/providers/failure/router-error"
import { failureBody } from "../../../src/services/admin"
import { finishChain } from "../../../src/services/dataplane/chain-finish"
import { streamEndEvent } from "../../../src/services/dataplane/relay-stream-end"
import type { RejectedCandidate } from "../../../src/services/routing"
import { noCandidatesError } from "../../../src/services/routing"
import { at, NOW } from "../routing/fixtures"

function rejected(
  label: string,
  reason: RejectedCandidate["reason"],
  extra: Partial<RejectedCandidate> = {},
): RejectedCandidate {
  return { accountId: `id-${label}`, label, reason, ...extra }
}

function pool(entries: readonly RejectedCandidate[], model?: string): RouterError {
  return noCandidatesError({
    scope: {
      scope: { kind: "pools", poolIds: ["cn"] },
      inScopeAccountIds: entries.map((entry) => entry.accountId),
      unresolvedTargetIds: [],
    },
    groups: [{ poolId: "cn", poolName: "cn", policy: "priority-failover", ordered: [], notes: [] }],
    rejected: entries,
    binding: { state: "none" },
    now: NOW,
    ...(model === undefined ? {} : { model }),
  })
}

const T30 = at(30_000).toISOString()

describe("routing/no-candidates.ts — the pool's own verdict", () => {
  test("recoverable, estimated reset, with a remainder", () => {
    const error = pool([
      rejected("zai", "quota-window-spent", { resetsAt: at(60_000), resetSource: "estimated" }),
      rejected("minimax", "cooling-down", { resetsAt: at(30_000), resetSource: "estimated" }),
      rejected("kimi", "needs-reauth"),
      rejected("or", "exhausted"),
    ])
    expect(error.message).toBe(
      `2 of 4 accounts in pool cn are rate limited or out of quota (zai, minimax); 1 more account out of credits and needs a top-up (or); 1 more needs a human (kimi needs re-auth), earliest reset ${T30} (estimated)`,
    )
    expect(error.detail).toEqual({
      signal: "cooling-down",
      resetSource: "estimated",
      pools: ["cn"],
      accounts: [
        { accountId: "id-zai", state: "quota-window-spent", resetsAt: at(60_000) },
        { accountId: "id-minimax", state: "cooling-down", resetsAt: at(30_000) },
        { accountId: "id-kimi", state: "needs-reauth" },
        { accountId: "id-or", state: "exhausted" },
      ],
    })
  })

  test("recoverable, reset unknown", () => {
    expect(pool([rejected("a", "probe-in-flight")]).message).toBe(
      "1 of 1 account in pool cn is settling a recovery probe (a), reset time unknown",
    )
  })

  test("recoverable, reported reset", () => {
    expect(pool([rejected("a", "cooling-down", { resetsAt: at(30_000) })]).message).toBe(
      `1 of 1 account in pool cn is rate limited or out of quota (a), earliest reset ${T30}`,
    )
  })

  test("all exhausted", () => {
    const error = pool([rejected("a", "exhausted"), rejected("b", "exhausted")])
    expect(error.message).toBe(
      "all 2 accounts in pool cn are out of credits and need a top-up (a, b)",
    )
    expect(error.detail.signal).toBe("exhausted")
  })

  test("no account serves the model", () => {
    const error = pool([rejected("a", "model-unsupported")], "glm-5")
    expect(error.message).toBe(
      'no account in pool cn serves model "glm-5" — a client change (1 account in scope: a)',
    )
    expect(error.detail.signal).toBe("model-unsupported")
    // A 503 a retry never clears: another model or key, not a wait.
    expect(routerErrorObject(error, null, null)).toMatchObject({ wall: "scope", retryable: false })
  })

  test("nothing eligible for another reason", () => {
    const error = pool([rejected("a", "disabled"), rejected("b", "needs-reauth")])
    expect(error.message).toBe("no eligible account in pool cn: a disabled, b needs re-auth")
    // Only an operator brings these back: a 503, but a person's wall.
    expect(routerErrorObject(error, null, null)).toMatchObject({ wall: "human", retryable: false })
  })

  test("a bound session's account is cooling", () => {
    const error = noCandidatesError({
      scope: { scope: { kind: "all" }, inScopeAccountIds: ["id-a"], unresolvedTargetIds: [] },
      groups: [],
      rejected: [],
      binding: {
        state: "blocked",
        accountId: "id-a",
        reason: "cooling-down",
        resetsAt: at(30_000),
        resetSource: "provider-reported",
      },
      now: NOW,
    })
    expect(error.message).toBe(
      `session is bound to account id-a, which is cooling down, earliest reset ${T30}`,
    )
    expect(error.detail).toMatchObject({ scope: "session", signal: "cooling-down" })
  })

  test("nothing in the key's scope", () => {
    const error = noCandidatesError({
      scope: {
        scope: { kind: "pools", poolIds: [] },
        inScopeAccountIds: [],
        unresolvedTargetIds: [],
      },
      groups: [],
      rejected: [],
      binding: { state: "none" },
      now: NOW,
    })
    expect(error.message).toBe("no account is reachable through this key's scope (pools)")
  })
})

describe("providers/failure/router-error.ts — one account's answer", () => {
  const classification = (kind: "rate-limited" | "credits-exhausted" | "auth", signal: string) => ({
    kind,
    status: kind === "rate-limited" ? 429 : kind === "auth" ? 401 : 402,
    retryable: true,
    signal,
    rateLimit: null,
  })

  test("rate limited", () => {
    const error = toRouterError(classification("rate-limited", "http-status:429"), {
      signal: { limited: true, resetsAt: at(30_000), resetSource: "estimated", windows: [] },
      now: NOW,
    })
    expect(error?.message).toBe("upstream rate limited (http-status:429)")
    expect(error?.detail).toEqual({
      scope: "account",
      signal: "http-status:429",
      resetSource: "estimated",
    })
  })

  test("rate limited, with the transport's own router-authored sentence", () => {
    const error = toRouterError(classification("rate-limited", "sdk:five_hour"), {
      signal: null,
      now: NOW,
      clientMessage: "Claude subscription usage limit reached",
    })
    expect(error?.message).toBe("Claude subscription usage limit reached (sdk:five_hour)")
  })

  test("out of credits", () => {
    const error = toRouterError(classification("credits-exhausted", "openai:insufficient_quota"))
    expect(error?.message).toBe(
      "upstream account is out of credits (openai:insufficient_quota) — needs a top-up, no timer will fix it",
    )
    expect(error?.detail).toEqual({ scope: "account", signal: "openai:insufficient_quota" })
  })

  test("credential rejected", () => {
    expect(toRouterError(classification("auth", "http-status:401"))?.message).toBe(
      "upstream rejected the account's credential (http-status:401) — the account needs re-authenticating, the presented router key was fine",
    )
  })
})

describe("dataplane/chain-finish.ts — a chain that ran out of candidates", () => {
  const thrown = (lastFailure: { kind: "client-error"; message: string } | null): string => {
    try {
      finishChain(null, lastFailure, () => undefined)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    throw new Error("finishChain answered instead of refusing")
  }

  test("every attempt failed", () => {
    expect(thrown({ kind: "client-error", message: "upstream timed out" })).toBe(
      "every attempt failed: upstream timed out",
    )
  })

  test("nothing could be attempted", () => {
    expect(thrown(null)).toBe("no candidate account could be attempted")
  })
})

describe("services/admin/result.ts — an admin refusal", () => {
  test("keeps its sentence and code, and carries router beside them", () => {
    expect(
      failureBody({ status: 404, code: "not_found", message: "pool not found" }, "req-admin"),
    ).toEqual({
      error: {
        message: "pool not found",
        type: "invalid_request_error",
        param: null,
        code: "not_found",
        router: {
          wall: "request",
          scope: "request",
          retryable: false,
          reset_at: null,
          reset_source: null,
          retry_after_s: null,
          accounts: [],
          pools: [],
          signal: null,
          attempts: 0,
          request_id: "req-admin",
        },
      },
    })
  })
})

describe("dataplane/relay-stream-end.ts — a stream that broke after its first byte", () => {
  const facts = { requestId: "req-1", attempt: 2, accountId: "acct-a" }

  test("anthropic: an error event, the upstream's transport fault named", () => {
    const event = streamEndEvent("anthropic", new Error("reset"), facts)
    expect(event.startsWith("\n\nevent: error\ndata: ")).toBe(true)
    const data = JSON.parse(event.slice("\n\nevent: error\ndata: ".length)) as {
      error: { message: string; router: { wall: string; signal: string; attempts: number } }
    }
    expect(data.error.message).toBe(
      "the upstream stream failed after the response began (upstream_error); not retried, bytes were already sent",
    )
    expect(data.error.router).toMatchObject({
      wall: "capacity",
      signal: "upstream_error",
      attempts: 2,
    })
  })

  test("openai-chat: an error chunk, then [DONE]", () => {
    const timeout = new DOMException("silent", "TimeoutError")
    const event = streamEndEvent("openai-chat", timeout, facts)
    expect(event.endsWith("\n\ndata: [DONE]\n\n")).toBe(true)
    const data = JSON.parse(event.slice("\n\ndata: ".length).split("\n")[0] as string) as {
      error: { message: string; code: string; router: { signal: string } }
    }
    expect(data.error.message).toBe(
      "the upstream stream failed after the response began (upstream_timeout); not retried, bytes were already sent",
    )
    expect(data.error.code).toBe("upstream_timeout")
    expect(data.error.router.signal).toBe("upstream_timeout")
  })

  test("openai-responses: the Responses error event, router at its top level", () => {
    const event = streamEndEvent("openai-responses", new Error("reset"), facts)
    const data = JSON.parse(event.slice("\n\nevent: error\ndata: ".length)) as {
      type: string
      code: string
      router: { wall: string }
    }
    expect(data).toMatchObject({
      type: "error",
      code: "upstream_error",
      router: { wall: "capacity" },
    })
  })
})
