/**
 * "Account X needs reconnecting" in the rendered error (`errors/reconnect.ts`): which failures name
 * it, the sentence a person reads in both dialects, `error.router.reconnect`, and the header value.
 * The thrown message is never edited, so every frozen sentence (`frozen-sentences.test.ts`) still
 * opens the rendered one verbatim — developerz.ai's unanchored readers see what they always saw.
 */

import { describe, expect, test } from "bun:test"
import {
  CreditsExhaustedError,
  InvalidRequestError,
  NoHealthyAccountError,
  QuotaExhaustedError,
  type RouterError,
} from "@multi-ai-router/core"
import { opaqueAccountRef } from "../../../src/errors/account-ref"
import { consoleAccountsUrl, reconnectOf } from "../../../src/errors/reconnect"
import { toErrorResponse } from "../../../src/errors/render"
import { noteRequestFacts } from "../../../src/errors/router-object"
import { reconnectHeaders } from "../../../src/services/dataplane/router-headers"
import type { RejectedCandidate } from "../../../src/services/routing"
import { noCandidatesError } from "../../../src/services/routing"
import { at, NOW } from "../routing/fixtures"

const URL = "https://router.example.com/accounts"
const KIMI = { accountId: "id-kimi", label: "kimi", provider: "kimi" } as const

function rejected(
  label: string,
  reason: RejectedCandidate["reason"],
  extra: Partial<RejectedCandidate> = {},
): RejectedCandidate {
  return { accountId: `id-${label}`, label, reason, ...extra }
}

function pool(entries: readonly RejectedCandidate[]): RouterError {
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
  })
}

function messageOf(error: unknown, consoleUrl: string | null = URL): string {
  return toErrorResponse(error, "anthropic", null, consoleUrl).body.error.message
}

describe("routing/no-candidates.ts — the pool verdict carries who needs reconnecting", () => {
  test("only the needs-reauth members, with their provider", () => {
    const error = pool([
      rejected("zai", "cooling-down", { resetsAt: at(30_000), resetSource: "estimated" }),
      rejected("kimi", "needs-reauth", { provider: "kimi" }),
      rejected("or", "disabled"),
    ])
    expect(error.detail.reconnect).toEqual([KIMI])
  })

  test("absent when nothing needs reconnecting", () => {
    expect(pool([rejected("or", "disabled")]).detail.reconnect).toBeUndefined()
  })
})

describe("errors/render.ts — the sentence a person reads", () => {
  test("a 503 of disabled and lost-login members: both dialects, the frozen sentence first", () => {
    const error = pool([rejected("a", "disabled"), rejected("kimi", "needs-reauth", KIMI)])
    const sentence = `no eligible account in pool cn: a disabled, kimi needs re-auth. Reconnect needed: account kimi (kimi) lost its login — a router admin must reconnect it at ${URL}`

    const anthropic = toErrorResponse(error, "anthropic", "req-1", URL)
    expect(anthropic.status).toBe(503)
    expect(anthropic.body).toMatchObject({
      type: "error",
      error: { type: "overloaded_error", message: sentence },
    })
    expect(anthropic.body.error.router?.reconnect).toEqual([
      { account: opaqueAccountRef("id-kimi"), label: "kimi", provider: "kimi", url: URL },
    ])

    const openai = toErrorResponse(error, "openai-chat", "req-1", URL)
    expect(openai.body).toMatchObject({
      error: { type: "server_error", code: "no_healthy_account", param: null, message: sentence },
    })
    expect(openai.body.error.router?.reconnect).toEqual(anthropic.body.error.router?.reconnect)
    expect(sentence.startsWith(error.message)).toBe(true)
  })

  test("a 429 with a lost-login remainder: the reset clause stays where readers find it", () => {
    const error = pool([
      rejected("zai", "cooling-down", { resetsAt: at(30_000), resetSource: "estimated" }),
      rejected("kimi", "needs-reauth", KIMI),
    ])
    const message = messageOf(error)
    expect(message).toBe(
      `${error.message}. Reconnect needed: account kimi (kimi) lost its login — a router admin must reconnect it at ${URL}`,
    )
    expect(message).toMatch(/1 of 2 accounts in pool cn is rate limited/)
    expect(message).toMatch(/earliest reset \d{4}-\d{2}-\d{2}T[\d:.]+Z \(estimated\)\./)
  })

  test("a 402 with a lost-login remainder", () => {
    const error = pool([rejected("or", "exhausted"), rejected("kimi", "needs-reauth", KIMI)])
    expect(error).toBeInstanceOf(CreditsExhaustedError)
    expect(messageOf(error)).toEndWith(
      `. Reconnect needed: account kimi (kimi) lost its login — a router admin must reconnect it at ${URL}`,
    )
  })

  test("nothing needs reconnecting: the rendered sentence is the thrown one, unchanged", () => {
    const error = pool([rejected("a", "disabled")])
    expect(messageOf(error)).toBe(error.message)
    expect(toErrorResponse(error, "anthropic", null, URL).body.error.router?.reconnect).toEqual([])
  })
})

describe("errors/reconnect.ts — which failures name what selection saw", () => {
  test("a failure a reconnected account could have served names it", () => {
    for (const error of [
      new QuotaExhaustedError("upstream rate limited (anthropic:rate_limit_error)"),
      new NoHealthyAccountError("every attempt failed"),
    ]) {
      noteRequestFacts(error, { attempts: 1, accounts: [], pools: [], reconnect: [KIMI] })
      expect(messageOf(error)).toEndWith(`must reconnect it at ${URL}`)
    }
  })

  test("a refusal of the request itself does not: no reconnect fixes a bad body", () => {
    const error = new InvalidRequestError("messages: field required")
    noteRequestFacts(error, { attempts: 1, accounts: [], pools: [], reconnect: [KIMI] })
    expect(messageOf(error)).toBe("messages: field required")
    expect(reconnectOf(error, [KIMI])).toEqual([])
  })

  test("an operator label is scrubbed like the sentence it also appears in", () => {
    const leaky = { accountId: "id-x", label: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }
    const error = new NoHealthyAccountError("x", { detail: { reconnect: [leaky] } })
    const router = toErrorResponse(error, "anthropic", null, URL).body.error.router
    expect(router?.reconnect[0]?.label).not.toContain("abcdefghijklmnop")
  })

  test("the console link is PUBLIC_URL's Accounts page, however the URL ends", () => {
    expect(consoleAccountsUrl("https://router.example.com")).toBe(URL)
    expect(consoleAccountsUrl("https://router.example.com//")).toBe(URL)
    expect(consoleAccountsUrl(null)).toBeNull()
  })
})

describe("x-router-reconnect-needed", () => {
  test("each label URI-encoded, so any operator text is a valid header value", () => {
    expect(reconnectHeaders([{ label: "Claude Max, sebi" }, { label: "Kimí" }])).toEqual({
      "x-router-reconnect-needed": "Claude%20Max%2C%20sebi, Kim%C3%AD",
    })
    expect(() =>
      new Headers().set("x", Object.values(reconnectHeaders([{ label: "日本 ✓" }]))[0] ?? ""),
    ).not.toThrow()
  })

  test("absent when nothing needs reconnecting", () => {
    expect(reconnectHeaders(undefined)).toEqual({})
    expect(reconnectHeaders([])).toEqual({})
  })
})
