import { describe, expect, test } from "bun:test"
import {
  expectNoWebhookLeak,
  memoryReportStore,
  REPORT_PERIOD,
  STUB_WEBHOOK_URL,
  webhookStub,
} from "../../support/report-delivery"
import { contendedStore, NOW, setup } from "./delivery-harness"

/** The admin re-send's contract (issue #229): any status may go again, the cap never applies. */

describe("redeliver — the admin re-send", () => {
  test.each(["2026-10-06", "nope", "", "2026-13-01"])(
    "400 on a malformed period %p",
    async (param) => {
      const h = setup()
      const result = await h.service.redeliver(param)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.failure.status).toBe(400)
      expect(h.requests).toHaveLength(0)
    },
  )

  test("a webhook URL as the period parameter is refused without echoing it", async () => {
    const h = setup()
    const result = await h.service.redeliver(STUB_WEBHOOK_URL)
    expect(result.ok).toBe(false)
    if (!result.ok) expectNoWebhookLeak(result.failure.message)
  })

  test("404 on an absent week: no network, no generation", async () => {
    const h = setup({ store: memoryReportStore() })
    const result = await h.service.redeliver(REPORT_PERIOD)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.status).toBe(404)
    expect(h.requests).toHaveLength(0)
    expect(h.store.rows.size).toBe(0)
    expect(h.audits).toHaveLength(0)
  })

  test("an unset webhook answers not_configured, makes no request and writes no audit row", async () => {
    const h = setup({ webhookUrl: null })
    expect(await h.service.redeliver(REPORT_PERIOD)).toEqual({
      ok: true,
      value: {
        periodStart: REPORT_PERIOD,
        deliveryStatus: "not_configured",
        deliveryAttempts: 0,
        deliveredAt: null,
      },
    })
    expect(h.requests).toHaveLength(0)
    expect(h.row()?.deliveryStatus).toBe("not_configured")
    expect(h.audits).toHaveLength(0)
  })

  test("a pending row posts, answers 200 and writes exactly one audit row", async () => {
    const h = setup()
    expect(await h.service.redeliver(REPORT_PERIOD)).toEqual({
      ok: true,
      value: {
        periodStart: REPORT_PERIOD,
        deliveryStatus: "sent",
        deliveryAttempts: 1,
        deliveredAt: NOW.toISOString(),
      },
    })
    expect(h.requests).toHaveLength(1)
    expect(h.audits).toEqual([
      {
        kind: "usage_report.delivered",
        subjectType: "usage_report",
        subjectId: REPORT_PERIOD,
        detail: { outcome: "sent", attempts: 1 },
      },
    ])
    expect(h.captured).toHaveLength(0)
  })

  test("re-sending a sent week posts again and stays sent", async () => {
    const before = new Date("2026-10-12T00:45:00.000Z")
    const h = setup({}, [
      REPORT_PERIOD,
      { deliveryStatus: "sent", deliveryAttempts: 1, deliveredAt: before },
    ])
    const result = await h.service.redeliver(REPORT_PERIOD)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toMatchObject({ deliveryStatus: "sent", deliveryAttempts: 2 })
    }
    expect(h.requests).toHaveLength(1)
    expect(h.row()?.deliveredAt).toEqual(NOW)
  })

  test("the cap never limits a re-send", async () => {
    const h = setup({ maxDeliveryAttempts: 6 }, [REPORT_PERIOD, { deliveryAttempts: 50 }])
    const result = await h.service.redeliver(REPORT_PERIOD)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.deliveryAttempts).toBe(51)
    expect(h.requests).toHaveLength(1)
  })

  test("a lost claim answers 409 and makes no request", async () => {
    const h = setup({ store: contendedStore() })
    const result = await h.service.redeliver(REPORT_PERIOD)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.status).toBe(409)
      expect(result.failure.code).toBe("delivery_claim_lost")
    }
    expect(h.requests).toHaveLength(0)
    expect(h.captured).toHaveLength(0)
    expect(h.audits).toHaveLength(0)
  })

  test("a failed re-send answers 200 failed — never a 5xx the error handler would capture twice", async () => {
    const s = webhookStub({ status: 500 })
    const h = setup({ fetchImpl: s.fetchImpl })
    const result = await h.service.redeliver(REPORT_PERIOD)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.deliveryStatus).toBe("failed")
      expect(result.value.lastError).toBe("discord webhook answered 500")
    }
    expect(h.row()).toMatchObject({
      deliveryStatus: "failed",
      lastError: "discord webhook answered 500",
    })
    expect(h.captured).toHaveLength(1)
    expect(h.audits).toHaveLength(1)
    expect(h.audits[0]?.detail).toMatchObject({ outcome: "failed", priorStatus: "pending" })
  })

  test.each([
    ["sent", { deliveryStatus: "sent", deliveryAttempts: 2 }],
    ["failed", { deliveryStatus: "failed", deliveryAttempts: 3 }],
    ["not_configured", { deliveryStatus: "not_configured", deliveryAttempts: 0 }],
  ] as const)(
    "a failed re-send of a %s week marks it failed, capturing exactly once",
    async (_label, over) => {
      const s = webhookStub({ status: 502 })
      const h = setup({ fetchImpl: s.fetchImpl }, [REPORT_PERIOD, { ...over }])
      const result = await h.service.redeliver(REPORT_PERIOD)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.deliveryStatus).toBe("failed")
      expect(h.row()?.deliveryStatus).toBe("failed")
      expect(h.row()?.deliveryAttempts).toBe(over.deliveryAttempts + 1)
      expect(h.captured).toHaveLength(1)
      expect(h.audits).toHaveLength(1)
    },
  )

  test("two failed re-sends capture once each — per call, not per period", async () => {
    const s = webhookStub({ status: 500 }, { status: 500 })
    const h = setup({ fetchImpl: s.fetchImpl })
    await h.service.redeliver(REPORT_PERIOD)
    await h.service.redeliver(REPORT_PERIOD)
    expect(h.captured).toHaveLength(2)
    expect(h.audits).toHaveLength(2)
    expect(s.requests).toHaveLength(2)
  })

  test("a network failure scrubs the webhook URL out of the response, the row and the capture", async () => {
    const s = webhookStub({
      throws: new Error(`request to ${STUB_WEBHOOK_URL}?wait=true failed`, {
        cause: new Error(`connect ECONNREFUSED while posting ${STUB_WEBHOOK_URL}`),
      }),
    })
    const h = setup({ fetchImpl: s.fetchImpl })
    const result = await h.service.redeliver(REPORT_PERIOD)
    expect(result.ok).toBe(true)
    if (result.ok) expectNoWebhookLeak(result.value.lastError ?? "")
    expectNoWebhookLeak(h.row()?.lastError ?? "")
    expect(h.captured).toHaveLength(1)
    const capturedError = h.captured[0]?.error
    expect(capturedError).toBeInstanceOf(Error)
    // String(Error) is "Error: <message>" — the scrubbed message must carry no webhook URL.
    expectNoWebhookLeak(String(capturedError))
  })

  test("a corrupt payload fails with no request, but still writes its audit row", async () => {
    const h = setup({}, [REPORT_PERIOD, { payload: { version: 9 } }])
    const result = await h.service.redeliver(REPORT_PERIOD)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.deliveryStatus).toBe("failed")
      expect(result.value.lastError).toBe("the stored payload is not a v1 weekly report")
    }
    expect(h.requests).toHaveLength(0)
    expect(h.captured).toHaveLength(1)
    expect(h.audits).toHaveLength(1)
  })

  test("the rendered post carries the Usage link only when PUBLIC_URL is configured", async () => {
    const withUrl = setup({ publicUrl: "https://router.example.test" })
    await withUrl.service.redeliver(REPORT_PERIOD)
    expect(JSON.stringify(withUrl.requests[0]?.payloadJson)).toContain("router.example.test")
    const without = setup({ publicUrl: null })
    await without.service.redeliver(REPORT_PERIOD)
    expect(JSON.stringify(without.requests[0]?.payloadJson)).not.toContain("Usage view")
  })
})
