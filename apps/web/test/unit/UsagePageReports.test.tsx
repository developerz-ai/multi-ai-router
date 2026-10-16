import { afterEach, describe, expect, test } from "bun:test"
import { mount, requests, resetUsagePage, settle, stub } from "../support/usage-page"
import { wireReport } from "../support/usage-wire"

/** The Usage page's read-only weekly reports list (issue #228): every stored week and status. */

afterEach(resetUsagePage)

describe("Usage page weekly reports", () => {
  test("lists each stored week with its period and delivery status, all four statuses", async () => {
    stub({
      summary: {},
      reports: [
        wireReport("2026-10-05", "2026-10-12", "pending"),
        wireReport("2026-09-28", "2026-10-05", "not_configured"),
        wireReport("2026-09-21", "2026-09-28", "sent", {
          deliveredAt: "2026-09-28T02:00:00.000Z",
        }),
        wireReport("2026-09-14", "2026-09-21", "failed", {
          deliveryAttempts: 3,
          lastError: "secret-looking detail that must not render",
        }),
      ],
    })
    const { container, dispose } = mount()
    try {
      await settle()
      const reports = container.querySelector('[aria-label="Weekly reports"]')
      const text = reports?.textContent ?? ""
      for (const start of ["2026-10-05", "2026-09-28", "2026-09-21", "2026-09-14"]) {
        expect(text).toContain(start)
      }
      for (const status of ["Pending", "Not configured", "Sent", "Failed"]) {
        expect(text).toContain(status)
      }
      // Every row carries the Resend control (#229), and the failure detail stays out of the
      // page: a row names the delivery state, never the webhook error text.
      expect(reports?.querySelectorAll("button")).toHaveLength(4)
      expect(text).not.toContain("secret-looking")
      expect(requests.some((url) => url.pathname.endsWith("/usage/reports"))).toBe(true)
    } finally {
      dispose()
    }
  })

  test("says so when no week has been generated", async () => {
    stub({ summary: {}, reports: [] })
    const { container, dispose } = mount()
    try {
      await settle()
      const reports = container.querySelector('[aria-label="Weekly reports"]')
      expect(reports?.textContent).toContain("No weekly report")
    } finally {
      dispose()
    }
  })
})
