import { describe, expect, test } from "bun:test"
import type { ErrorEvent } from "@sentry/bun"
import { REDACTED } from "../../../src/logging/redact"
import { redactSentryEvent } from "../../../src/observability/sentry"

/**
 * `redactSentryEvent` is the `beforeSend` that stands between a Sentry SDK — which scrapes request
 * headers, request bodies, breadcrumbs, exception messages and stack `vars` onto every event — and
 * the credential-leak rule this router is built on (non-negotiable #3). These pin the vectors that
 * would carry an upstream API key, an OAuth token or a session cookie out to GlitchTip if the
 * scrubber missed them, so a future change to either module cannot reopen one silently.
 *
 * Two properties are pinned, and the second is the one the depth ceiling exists for: the scrubber
 * must (1) catch credentials by field name (`authorization`, `cookie`, `x-api-key`, `*token*`) and
 * by self-identifying value shape (`sk-…`, `Bearer …`, JWTs), and (2) still let a Sentry event's
 * stack trace through. A Sentry event nests its stack at `exception.values[].stacktrace.frames[]`
 * — depth 4 lands on `stacktrace`, so the log scrubber's default ceiling would redact the whole
 * trace; the fixture below carries a populated stack exactly so that regression cannot hide.
 */

const credentialEvent = {
  event_id: "a".repeat(32),
  level: "error",
  release: "2.4.0",
  environment: "production",
  request: {
    method: "POST",
    url: "https://router.ai.developerz.ai/v1/messages",
    headers: {
      authorization: "Bearer sk-ant-credinheader",
      "x-api-key": "sk-apikeyinheader",
      cookie: "session=deadbeef",
      "x-request-id": "req-1",
    },
    // A credential the upstream quoted back inside a JSON body — caught by the `sk-` value shape.
    data: '{"model":"claude","note":"leaked sk-credinbody inside body"}',
  },
  breadcrumbs: [
    {
      type: "http",
      category: "fetch",
      data: {
        url: "https://api.anthropic.com/v1/messages",
        authorization: "Bearer sk-ant-credinbreadcrumb",
      },
    },
    // A bearer-shaped token quoted in a free-text breadcrumb message — caught by the value shape.
    { message: "upstream rejected Authorization: Bearer at-credinmessage" },
  ],
  exception: {
    values: [
      {
        type: "Error",
        value: "upstream timed out: Authorization: Bearer at-credinexception",
        // The shape @sentry/bun assembles: a mechanism and a populated stacktrace. Both sit at
        // depth 4 under the event root, so a depth-4 walk redacts them whole — the regression the
        // populated stack here exists to catch.
        mechanism: { type: "generic", handled: false },
        stacktrace: {
          frames: [
            {
              filename: "apps/api/src/services/dataplane/chain.ts",
              function: "dispatch",
              module: "multi-ai-router:chain",
              lineno: 142,
              colno: 7,
              in_app: true,
              // Local variables the SDK attaches to a frame. A credential here is the leak vector a
              // depth-4 cap would either miss (if it walked) or vaporise wholesale (as it does).
              vars: {
                requestId: "req-1",
                apiKey: "sk-credinframevar",
                model: "claude-3-5-sonnet",
              },
            },
            {
              filename: "node:internal/process",
              function: "processTicksAndRejections",
              lineno: 1,
              in_app: false,
            },
          ],
        },
      },
    ],
  },
} as unknown as ErrorEvent

describe("redactSentryEvent — credential-leak security gate", () => {
  test("scrubs request headers by name and keeps the safe ones", () => {
    const safe = redactSentryEvent(credentialEvent)

    expect(safe.request?.headers).toEqual({
      authorization: REDACTED,
      "x-api-key": REDACTED,
      cookie: REDACTED,
      "x-request-id": "req-1",
    })
  })

  test("scrubs a credential that rode in inside the request body", () => {
    const safe = redactSentryEvent(credentialEvent)

    expect(JSON.stringify(safe.request?.data)).not.toContain("sk-credinbody")
  })

  test("scrubs upstream headers and free-text bearer tokens in breadcrumbs", () => {
    const safe = redactSentryEvent(credentialEvent)
    const serialized = JSON.stringify(safe.breadcrumbs)

    expect(serialized).not.toContain("sk-ant-credinbreadcrumb")
    expect(serialized).not.toContain("at-credinmessage")
  })

  test("scrubs a bearer token inside the exception message", () => {
    const safe = redactSentryEvent(credentialEvent)
    const serialized = JSON.stringify(safe.exception)

    expect(serialized).not.toContain("at-credinexception")
    expect(serialized).toContain(REDACTED)
  })

  test("leaves no scrubbed credential anywhere in the serialized event", () => {
    const serialized = JSON.stringify(redactSentryEvent(credentialEvent))

    for (const secret of [
      "sk-ant-credinheader",
      "sk-apikeyinheader",
      "sk-credinbody",
      "sk-ant-credinbreadcrumb",
      "at-credinmessage",
      "at-credinexception",
      "sk-credinframevar",
      "session=deadbeef",
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  test("preserves the non-credential structure an operator reads an event by", () => {
    const safe = redactSentryEvent(credentialEvent)

    expect(safe.event_id).toBe("a".repeat(32))
    expect(safe.release).toBe("2.4.0")
    expect(safe.environment).toBe("production")
    expect(safe.request?.method).toBe("POST")
    expect(safe.request?.url).toBe("https://router.ai.developerz.ai/v1/messages")
  })

  test("does not mutate the event it was given — a dropped capture must not alter caller state", () => {
    const before = JSON.parse(JSON.stringify(credentialEvent)) as ErrorEvent

    redactSentryEvent(credentialEvent)

    expect(credentialEvent).toEqual(before)
  })
})

describe("redactSentryEvent — the stack trace survives", () => {
  // The depth-4 regression: a Sentry event's stack lives at depth 4, and a walk that redacts
  // objects at that depth ships every error with `[REDACTED]` where its frames, file paths and line
  // numbers should be. An error tracker without a stack is decorative, so this is the gate that
  // says the deeper Sentry walk is doing its job.

  test("frames keep their filename, function, line and module — not redacted to a stub", () => {
    const safe = redactSentryEvent(credentialEvent)
    const frame = safe.exception?.values?.[0]?.stacktrace?.frames?.[0]

    expect(frame?.filename).toBe("apps/api/src/services/dataplane/chain.ts")
    expect(frame?.function).toBe("dispatch")
    expect(frame?.module).toBe("multi-ai-router:chain")
    expect(frame?.lineno).toBe(142)
    expect(frame?.colno).toBe(7)
    expect(frame?.in_app).toBe(true)
    // The whole trace is intact, not collapsed.
    expect(safe.exception?.values?.[0]?.stacktrace?.frames).toHaveLength(2)
    expect(safe.exception?.values?.[0]?.mechanism).toEqual({ type: "generic", handled: false })
  })

  test("a credential in a frame var is scrubbed while a safe var survives", () => {
    const safe = redactSentryEvent(credentialEvent)
    const vars = safe.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars as
      | Record<string, unknown>
      | undefined

    expect(vars?.apiKey).toBe(REDACTED)
    expect(vars?.requestId).toBe("req-1")
    expect(vars?.model).toBe("claude-3-5-sonnet")
  })
})
