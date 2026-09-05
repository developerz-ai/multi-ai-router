import { describe, expect, test } from "bun:test"
import {
  CredentialDecryptError,
  CreditsExhaustedError,
  NoHealthyAccountError,
  QuotaExhaustedError,
  TranslationError,
  UpstreamAuthError,
  UpstreamTimeoutError,
} from "@multi-ai-router/core"
import type { FailureClassification } from "../../../src/providers"
import {
  answeredFailure,
  type ChainFailure,
  foldChainFailure,
  routerFailure,
  type UpstreamError,
} from "../../../src/services/dataplane"

/**
 * Which of several failed attempts a chain reports. The whole point is that it is *not* the last
 * one: a broken account late in the chain must never bury the answer an account earlier in it gave.
 */

function upstream(status: number, bodyText = "{}"): UpstreamError {
  return {
    status,
    headers: new Headers({ "content-type": "application/json" }),
    bodyText,
    contentType: "application/json",
  }
}

function fold(...failures: (ChainFailure | null)[]): ChainFailure | null {
  return failures.reduce<ChainFailure | null>(foldChainFailure, null)
}

/** The status a held failure would render as, which is the only thing the client sees. */
function status(failure: ChainFailure | null): number | null {
  if (failure === null) return null
  return failure.kind === "router" ? failure.error.status : failure.upstream.status
}

const RATE_LIMITED = routerFailure(new QuotaExhaustedError("spent", { retryAfterSeconds: 30 }))
const DRAINED = routerFailure(new CreditsExhaustedError("top up"))
const UNREADABLE = routerFailure(new CredentialDecryptError("acct-2: unreadable"))

describe("foldChainFailure", () => {
  test("holds the first failure when there is nothing to compare it to", () => {
    expect(fold(RATE_LIMITED)).toBe(RATE_LIMITED)
    expect(fold(null)).toBeNull()
  })

  test("a credential the router cannot read never buries an honest 429", () => {
    // The bug this exists for: candidate 1 answered `429` with a wait, candidate 3's stored
    // credential will not decrypt, and the client used to get a `500` with no `Retry-After`.
    const held = fold(RATE_LIMITED, UNREADABLE)

    expect(status(held)).toBe(429)
    expect(held).toBe(RATE_LIMITED)
  })

  test("a 429 anywhere in the chain outranks a drained balance elsewhere in it", () => {
    // Both directions, because "the last one wins" gets one of them right by accident. The pool is
    // serviceable again at its earliest reset, so `no timer will fix this` would be a lie.
    expect(status(fold(RATE_LIMITED, DRAINED))).toBe(429)
    expect(status(fold(DRAINED, RATE_LIMITED))).toBe(429)
  })

  test("a drained balance outranks an account that needs re-authenticating", () => {
    const reauth = routerFailure(new UpstreamAuthError("re-auth"))

    expect(status(fold(reauth, DRAINED))).toBe(402)
    expect(status(fold(DRAINED, reauth))).toBe(402)
  })

  test("the upstream's own answer outranks a refusal that never left the router", () => {
    const answered: ChainFailure = { kind: "upstream", upstream: upstream(503), dialect: null }

    expect(status(fold(answered, UNREADABLE))).toBe(503)
    expect(status(fold(UNREADABLE, answered))).toBe(503)
    expect(status(fold(routerFailure(new TranslationError("no field")), answered))).toBe(503)
  })

  test("a router-shaped verdict outranks the upstream body it arrived with", () => {
    const answered: ChainFailure = { kind: "upstream", upstream: upstream(503), dialect: null }

    expect(status(fold(answered, RATE_LIMITED))).toBe(429)
    expect(status(fold(RATE_LIMITED, answered))).toBe(429)
  })

  test("an unreadable credential is the floor, and surfaces only when it is all there is", () => {
    expect(status(fold(UNREADABLE))).toBe(500)
    expect(status(fold(UNREADABLE, routerFailure(new TranslationError("no field"))))).toBe(400)
    expect(status(fold(UNREADABLE, routerFailure(new NoHealthyAccountError("none"))))).toBe(503)
    expect(status(fold(UNREADABLE, routerFailure(new UpstreamTimeoutError("deadline"))))).toBe(504)
  })

  test("a candidate the router could not classify at all changes nothing", () => {
    // The dispatch catch hands `null` for a throw that is not a `RouterError`. That used to null the
    // held error out, which is the same bug wearing a different hat.
    expect(fold(RATE_LIMITED, null, null)).toBe(RATE_LIMITED)
    expect(fold(null, null)).toBeNull()
  })

  test("between two spent windows the sooner wait wins, and a stated wait beats none", () => {
    const soon = routerFailure(new QuotaExhaustedError("soon", { retryAfterSeconds: 5 }))
    const silent = routerFailure(new QuotaExhaustedError("no reset reported"))

    expect(fold(RATE_LIMITED, soon)).toBe(soon)
    expect(fold(soon, RATE_LIMITED)).toBe(soon)
    expect(fold(silent, RATE_LIMITED)).toBe(RATE_LIMITED)
    expect(fold(RATE_LIMITED, silent)).toBe(RATE_LIMITED)
  })

  test("a tie keeps the incumbent, so the account tried first is the one named", () => {
    const first = routerFailure(new CreditsExhaustedError("acct-1 is out"))
    const second = routerFailure(new CreditsExhaustedError("acct-2 is out"))

    expect(fold(first, second)).toBe(first)
  })
})

describe("answeredFailure", () => {
  function classified(kind: FailureClassification["kind"], status: number): FailureClassification {
    return { kind, status, retryable: true, signal: `http-status:${status}`, rateLimit: null }
  }

  test("prefers the driver's verdict over the body it came with", () => {
    const held = answeredFailure(classified("rate-limited", 429), upstream(429), null)

    expect(held?.kind).toBe("router")
    expect(status(held)).toBe(429)
  })

  test("relays the provider's own answer when the driver produced no verdict", () => {
    const held = answeredFailure(classified("server-error", 503), upstream(503), "anthropic")

    expect(held).toEqual({ kind: "upstream", upstream: upstream(503), dialect: "anthropic" })
  })

  test("contributes nothing when the upstream never spoke", () => {
    // A connect failure or a timeout: no body, no classification. It must leave an earlier
    // candidate's verdict standing rather than replacing it with silence.
    expect(answeredFailure(null, null, null)).toBeNull()
    expect(fold(RATE_LIMITED, answeredFailure(null, null, null))).toBe(RATE_LIMITED)
  })

  const NOW = new Date("2026-01-01T12:00:00.000Z")

  test("an SDK 429 carries the reset its own stream reported — never a blind retry", () => {
    // The SDK's reset instant rides the query stream as a `rate_limit_event`, never the throw, so
    // `classifySdkFailure` pins `classification.rateLimit` to null. Without the attempt's captured
    // signal, the rendered 429 had no Retry-After (non-negotiable 7).
    const held = answeredFailure(classified("rate-limited", 429), null, null, {
      rateLimit: {
        limited: true,
        resetsAt: new Date(NOW.getTime() + 90_000),
        resetSource: "provider-reported",
        windows: [],
      },
      now: NOW,
      clientMessage: "the account's Claude subscription window is spent",
    })

    expect(held?.kind).toBe("router")
    if (held?.kind !== "router") return
    expect(held.error).toBeInstanceOf(QuotaExhaustedError)
    const error = held.error as QuotaExhaustedError
    expect(error.resetsAt).toEqual(new Date(NOW.getTime() + 90_000))
    // Derived from the instant when the signal named no seconds of its own.
    expect(error.retryAfterSeconds).toBe(90)
  })

  test("the SDK's router-authored sentence is what a 429 says, so Extra Usage is named", () => {
    // The chain's last word when every subscription answered `claude-sdk:extra-usage-gated`.
    // "upstream rate limited (signal)" would tell a caller to wait for a window that is not the
    // thing that ran out; the remedy is a top-up at claude.ai/settings/usage, and only the
    // transport's own sentence knows that.
    const held = answeredFailure(classified("rate-limited", 429), null, null, {
      rateLimit: null,
      now: NOW,
      clientMessage:
        "no Claude subscription capacity is available right now — this request was metered against Extra Usage, which is spent; add more at claude.ai/settings/usage",
    })

    expect(held?.kind).toBe("router")
    if (held?.kind !== "router") return
    expect(held.error.message).toContain("claude.ai/settings/usage")
    expect(held.error.message).not.toStartWith("upstream rate limited")
  })

  test("an HTTP 429 keeps its own wording: that field carries a signal token, not a sentence", () => {
    // On the HTTP path `AttemptFailure.message` is the classification's signal — a log breadcrumb.
    // Rendering it into a client body would answer a rate limit with "anthropic:rate_limit".
    const held = answeredFailure(classified("rate-limited", 429), upstream(429), null, {
      rateLimit: null,
      now: NOW,
      clientMessage: "http-status:429",
    })

    expect(held?.kind).toBe("router")
    if (held?.kind !== "router") return
    expect(held.error.message).toBe("upstream rate limited (http-status:429)")
  })

  test("a deadline the HTTP transport hit is a 504, never the empty-pool 503", () => {
    // Production: every attempt in a chain timed out, `held` stayed null, and the client got
    // `503 no_healthy_account "every attempt failed"` with no verdict at all. The timeout is the
    // verdict — the account was reached and did not answer in time — and the rank table has held
    // `upstream_timeout` for it since the table was written.
    const timedOut = answeredFailure(null, null, null, {
      rateLimit: null,
      now: NOW,
      clientMessage: "upstream did not answer within its deadline",
      failureKind: "timeout",
    })

    expect(timedOut?.kind).toBe("router")
    if (timedOut?.kind !== "router") return
    expect(timedOut.error).toBeInstanceOf(UpstreamTimeoutError)
    expect(timedOut.error.status).toBe(504)
    // Still below a 429: the pool is free at the reset, and that is the cheaper next step.
    expect(status(fold(timedOut, RATE_LIMITED))).toBe(429)
    // But above a refusal specific to one account.
    expect(status(fold(UNREADABLE, timedOut))).toBe(504)
  })

  test("a connect failure still contributes nothing: the account was never reached", () => {
    expect(
      answeredFailure(null, null, null, {
        rateLimit: null,
        now: NOW,
        clientMessage: "upstream connection failed",
        failureKind: "connection",
      }),
    ).toBeNull()
  })

  test("a classified failure with no body keeps its status and its router-authored sentence", () => {
    // A subprocess crash, a busy session, an unclassifiable throw: classification, no upstream
    // body. Contributing nothing here collapsed every one of them into a generic 503
    // `NoHealthyAccountError` — a crashed subprocess indistinguishable from an empty pool.
    const held = answeredFailure(classified("server-error", 502), null, "anthropic", {
      rateLimit: null,
      now: NOW,
      clientMessage: "the Claude Agent SDK subprocess exited before answering",
    })

    expect(held?.kind).toBe("upstream")
    if (held?.kind !== "upstream") return
    expect(held.upstream.status).toBe(502)
    expect(held.upstream.bodyText).toContain("subprocess exited before answering")
    expect(held.dialect).toBe("anthropic")
  })

  test("the synthesized answer still loses to a real 429 elsewhere in the chain", () => {
    const crashed = answeredFailure(classified("server-error", 502), null, null, {
      rateLimit: null,
      now: NOW,
      clientMessage: "the Claude Agent SDK subprocess exited before answering",
    })

    expect(status(fold(RATE_LIMITED, crashed))).toBe(429)
    expect(status(fold(crashed, RATE_LIMITED))).toBe(429)
  })
})
