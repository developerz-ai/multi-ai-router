import { describe, expect, test } from "bun:test"
import {
  expectNoWebhookLeak,
  memoryReportStore,
  REPORT_PERIOD,
  STUB_WEBHOOK_URL,
  webhookStub,
} from "../../support/report-delivery"
import { contendedStore, NOW, setup } from "./delivery-harness"

/** The task's path through the delivery state machine (issue #229). */

describe("deliverDue — the task's path", () => {
  test("a 2xx marks the row sent, once, and carries the embed plus the CSV", async () => {
    const h = setup()
    expect(await h.service.deliverDue(REPORT_PERIOD)).toEqual({ action: "sent", attempts: 1 })
    expect(h.row()).toMatchObject({
      deliveryStatus: "sent",
      deliveryAttempts: 1,
      deliveredAt: NOW,
      lastError: null,
    })
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]?.url).toBe(STUB_WEBHOOK_URL)
    expect(h.requests[0]?.csv?.filename).toBe("usage-report-2026-10-05.csv")
    expect(h.requests[0]?.csv?.body).toContain("key_name")
    expect(JSON.stringify(h.requests[0]?.payloadJson)).toContain("embeds")
    expect(h.captured).toHaveLength(0)
    // The task is not an operator act: no audit row.
    expect(h.audits).toHaveLength(0)
  })

  test("a 5xx below the cap leaves the row pending for a later tick, uncaptured", async () => {
    const s = webhookStub({ status: 503 })
    const h = setup({ fetchImpl: s.fetchImpl })
    expect(await h.service.deliverDue(REPORT_PERIOD)).toEqual({
      action: "retry",
      attempts: 1,
      reason: "discord webhook answered 503",
    })
    expect(h.row()).toMatchObject({ deliveryStatus: "pending", deliveryAttempts: 1 })
    expect(h.captured).toHaveLength(0)
  })

  test("429 then 2xx: retried on the next tick and sent, with no capture", async () => {
    const s = webhookStub({ status: 429 }, { status: 200 })
    const h = setup({ fetchImpl: s.fetchImpl })
    expect((await h.service.deliverDue(REPORT_PERIOD)).action).toBe("retry")
    expect(await h.service.deliverDue(REPORT_PERIOD)).toEqual({ action: "sent", attempts: 2 })
    expect(s.requests).toHaveLength(2)
    expect(h.captured).toHaveLength(0)
  })

  test("the cap ends it: the attempt that reaches it fails and captures in the same tick", async () => {
    const s = webhookStub({ status: 500 }, { status: 500 }, { status: 500 })
    const h = setup({ fetchImpl: s.fetchImpl, maxDeliveryAttempts: 2 })
    expect((await h.service.deliverDue(REPORT_PERIOD)).action).toBe("retry")
    expect((await h.service.deliverDue(REPORT_PERIOD)).action).toBe("failed")
    expect(h.row()).toMatchObject({
      deliveryStatus: "failed",
      deliveryAttempts: 2,
      lastError: "discord webhook answered 500",
    })
    expect(h.captured).toHaveLength(1)
    // Later ticks neither post nor capture again: the row is failed, not pending.
    expect((await h.service.deliverDue(REPORT_PERIOD)).action).toBe("skipped")
    expect(s.requests).toHaveLength(2)
    expect(h.captured).toHaveLength(1)
  })

  test("the attempt that lands ON the cap gives up in that same call", async () => {
    const s = webhookStub({ status: 500 })
    const h = setup({ fetchImpl: s.fetchImpl, maxDeliveryAttempts: 6 }, [
      REPORT_PERIOD,
      { deliveryAttempts: 5 },
    ])
    expect(await h.service.deliverDue(REPORT_PERIOD)).toMatchObject({
      action: "failed",
      attempts: 6,
    })
    expect(h.captured).toHaveLength(1)
    expect(h.row()?.deliveryStatus).toBe("failed")
  })

  test("a non-429 4xx stops at once and captures once", async () => {
    const s = webhookStub({ status: 404, body: '{"message": "Unknown Webhook"}' })
    const h = setup({ fetchImpl: s.fetchImpl })
    expect((await h.service.deliverDue(REPORT_PERIOD)).action).toBe("failed")
    expect(h.row()).toMatchObject({ deliveryStatus: "failed", deliveryAttempts: 1 })
    expect(h.row()?.lastError).toContain("404")
    expect(h.row()?.lastError).toContain("Unknown Webhook")
    expect(h.captured).toHaveLength(1)
    expect(s.requests).toHaveLength(1)
  })

  test("a network failure is retryable and its message is scrubbed", async () => {
    const s = webhookStub({ throws: new Error(`fetch failed: POST ${STUB_WEBHOOK_URL}`) })
    const h = setup({ fetchImpl: s.fetchImpl })
    const result = await h.service.deliverDue(REPORT_PERIOD)
    expect(result.action).toBe("retry")
    if (result.action === "retry") expectNoWebhookLeak(result.reason)
    expectNoWebhookLeak(h.row()?.lastError ?? "")
    expect(h.row()?.deliveryStatus).toBe("pending")
    expect(h.captured).toHaveLength(0)
  })

  test("an unset webhook makes no request and flips a pending row to not_configured", async () => {
    const h = setup({ webhookUrl: null })
    expect(await h.service.deliverDue(REPORT_PERIOD)).toEqual({
      action: "not_configured",
      recorded: true,
    })
    expect(h.requests).toHaveLength(0)
    expect(h.row()).toMatchObject({ deliveryStatus: "not_configured", deliveryAttempts: 0 })
    // Idempotent on later ticks, and it never un-sends: a sent row is left alone.
    expect(await h.service.deliverDue(REPORT_PERIOD)).toEqual({
      action: "not_configured",
      recorded: false,
    })
    const sent = setup({ webhookUrl: null }, [REPORT_PERIOD, { deliveryStatus: "sent" }])
    await sent.service.deliverDue(REPORT_PERIOD)
    expect(sent.row()?.deliveryStatus).toBe("sent")
  })

  test("a lost claim makes no request", async () => {
    const h = setup({ store: contendedStore() })
    expect((await h.service.deliverDue(REPORT_PERIOD)).action).toBe("skipped")
    expect(h.requests).toHaveLength(0)
    expect(h.captured).toHaveLength(0)
  })

  test("only a pending row is due: sent, failed and not_configured rows are skipped", async () => {
    for (const status of ["sent", "failed", "not_configured"] as const) {
      const h = setup({}, [REPORT_PERIOD, { deliveryStatus: status }])
      expect((await h.service.deliverDue(REPORT_PERIOD)).action).toBe("skipped")
      expect(h.requests).toHaveLength(0)
    }
  })

  test("a pending row already at the cap is skipped, not posted — its exit is the re-send", async () => {
    const h = setup({ maxDeliveryAttempts: 6 }, [REPORT_PERIOD, { deliveryAttempts: 6 }])
    expect((await h.service.deliverDue(REPORT_PERIOD)).action).toBe("skipped")
    expect(h.requests).toHaveLength(0)
  })

  test("an absent period is skipped, silently", async () => {
    const h = setup({ store: memoryReportStore() })
    expect((await h.service.deliverDue(REPORT_PERIOD)).action).toBe("skipped")
    expect(h.requests).toHaveLength(0)
  })

  test("a corrupt payload fails with a static reason and makes no request", async () => {
    const h = setup({}, [REPORT_PERIOD, { payload: { version: 9 } }])
    expect((await h.service.deliverDue(REPORT_PERIOD)).action).toBe("failed")
    expect(h.requests).toHaveLength(0)
    expect(h.captured).toHaveLength(1)
    expect(h.row()?.lastError).toBe("the stored payload is not a v1 weekly report")
  })
})
