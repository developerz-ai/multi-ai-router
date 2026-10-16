import { describe, expect, test } from "bun:test"
import { postDelivery } from "../../../src/services/usage-report/discord-post"
import type { DiscordDelivery } from "../../../src/services/usage-report/discord-render"
import {
  STUB_WEBHOOK_ID,
  STUB_WEBHOOK_TOKEN,
  STUB_WEBHOOK_URL,
} from "../../support/report-delivery"

/**
 * The webhook POST's error snippet (issue #229): bounded, and redacted *before* the bound —
 * `describeRedacted`'s rule. Slicing first can cut a webhook URL into a fragment no redaction
 * shape matches, and the head of a credential — scheme, host, path — survives into `last_error`,
 * log lines and Sentry. Stub webhook only; nothing here contacts Discord.
 */

const rendered: DiscordDelivery = {
  payloadJson: '{"embeds":[],"attachments":[]}',
  csvFilename: "usage-report-2026-10-05.csv",
  csvBody: "section\r\n",
}

function targetAnswering(body: string, status = 400) {
  return {
    webhookUrl: STUB_WEBHOOK_URL,
    timeoutMs: 1_000,
    fetchImpl: (async () => new Response(body, { status })) as typeof globalThis.fetch,
  }
}

describe("postDelivery — the error snippet", () => {
  test("a cut landing inside a webhook URL leaks nothing: redaction runs before the cap", async () => {
    // 170 filler chars plus a space put the URL at index 171, so the 200-char cap cuts it at
    // "https://discord.com/api/webho" — mid-path, before the shape the redactor matches. Slice
    // first and that head survives verbatim; redact first and the whole URL is already
    // "[REDACTED]" before any cut.
    const body = `${"x".repeat(170)} ${STUB_WEBHOOK_URL}`
    const outcome = await postDelivery(rendered, targetAnswering(body))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.message).toContain("discord webhook answered 400")
    expect(outcome.message).toContain("[REDACTED]")
    expect(outcome.message).not.toContain("discord.com")
    expect(outcome.message).not.toContain(STUB_WEBHOOK_ID)
    expect(outcome.message).not.toContain(STUB_WEBHOOK_TOKEN)
  })

  test("a URL wholly inside the cap is still redacted", async () => {
    const outcome = await postDelivery(
      rendered,
      targetAnswering(`{"message": "Unknown Webhook", "url": "${STUB_WEBHOOK_URL}"}`),
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.message).toContain("[REDACTED]")
    expect(outcome.message).not.toContain(STUB_WEBHOOK_TOKEN)
  })

  test("the snippet stays capped at 200 chars", async () => {
    const outcome = await postDelivery(rendered, targetAnswering("y".repeat(5_000), 500))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.retryable).toBe(true)
    expect(outcome.message).toContain("y".repeat(200))
    expect(outcome.message).not.toContain("y".repeat(201))
  })
})
