import { describe, expect, test } from "bun:test"
import type { ErrorEvent } from "@sentry/bun"
import { REDACTED } from "../../../src/logging/redact"
import { redactSentryEvent } from "../../../src/observability/sentry"

/**
 * `redactSentryEvent` is the `beforeSend` that stands between a Sentry SDK — which scrapes request
 * headers, request bodies, breadcrumbs and exception messages onto every event — and the
 * credential-leak rule this router is built on (non-negotiable #3). These are the vectors that would
 * carry an upstream API key, an OAuth token or a session cookie out to GlitchTip if the scrubber
 * missed them, pinned so a future change to either module cannot reopen one silently.
 *
 * The scrubber is the logger's `redact()` reused verbatim: it catches credentials by field name
 * (`authorization`, `cookie`, `x-api-key`, `*token*`) and by self-identifying value shape (`sk-…`,
 * `Bearer …`, JWTs). The shapes below are exactly those; a bare refresh-token value with no
 * recognisable prefix, quoted in free text under an innocent name, is the redactor's known boundary,
 * not something this layer widens.
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
      { type: "Error", value: "upstream timed out: Authorization: Bearer at-credinexception" },
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
