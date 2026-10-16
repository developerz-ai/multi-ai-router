import { expect } from "bun:test"
import type { UsageReportRow } from "@multi-ai-router/db"
import type { AuditEventInput, AuditRecorder } from "../../src/services/admin/audit"
import type { ReportDeliveryStore } from "../../src/services/usage-report/delivery"
import { storedPayload } from "./weekly-report"

/**
 * In-process doubles for the report-delivery tests (issue #229): a memory store with the real
 * repository's conditional-write semantics, a scripted webhook stub that parses the multipart
 * form, and capture/audit spies. A stub webhook URL with a recognisable token — leak assertions
 * grep for both, and nothing here ever names a real endpoint.
 */

export const STUB_WEBHOOK_ID = "9876543210"
export const STUB_WEBHOOK_TOKEN = "STUB-TOKEN_do-not-leak"
export const STUB_WEBHOOK_URL = `https://discord.com/api/webhooks/${STUB_WEBHOOK_ID}/${STUB_WEBHOOK_TOKEN}`

export const REPORT_PERIOD = "2026-10-05"

export function reportRow(
  periodStart: string = REPORT_PERIOD,
  over: Partial<UsageReportRow> = {},
): UsageReportRow {
  const end = new Date(Date.parse(`${periodStart}T00:00:00Z`) + 7 * 86_400_000)
  return {
    id: crypto.randomUUID(),
    periodStart,
    periodEnd: end.toISOString().slice(0, 10),
    generatedAt: new Date("2026-10-12T00:30:00.000Z"),
    payload: storedPayload(),
    deliveryStatus: "pending",
    deliveryAttempts: 0,
    deliveredAt: null,
    lastError: null,
    ...over,
  }
}

export interface MemoryReportStore extends ReportDeliveryStore {
  /** Live view of the rows — assertions read this directly. */
  readonly rows: Map<string, UsageReportRow>
}

/** Mirrors `createUsageReportRepository`'s claim and conditional-outcome semantics exactly. */
export function memoryReportStore(...rows: readonly UsageReportRow[]): MemoryReportStore {
  const map = new Map(rows.map((row) => [row.periodStart, { ...row }]))
  const row = (periodStart: string): UsageReportRow | undefined => map.get(periodStart)
  return {
    rows: map,
    async findByPeriodStart(periodStart) {
      const found = row(periodStart)
      // A detached copy: the caller's read snapshot must not see later writes, same as Postgres.
      return found === undefined ? undefined : { ...found }
    },
    async claimForDelivery(periodStart, readStatus, readAttempts) {
      const found = row(periodStart)
      if (
        found === undefined ||
        found.deliveryStatus !== readStatus ||
        found.deliveryAttempts !== readAttempts
      ) {
        return undefined
      }
      found.deliveryAttempts += 1
      return found.deliveryAttempts
    },
    async markDelivered(periodStart, claimedAttempts, deliveredAt) {
      const found = row(periodStart)
      if (found === undefined || found.deliveryAttempts !== claimedAttempts) return false
      found.deliveryStatus = "sent"
      found.deliveredAt = deliveredAt
      found.lastError = null
      return true
    },
    async markPendingFailed(periodStart, claimedAttempts, lastError) {
      const found = row(periodStart)
      if (
        found === undefined ||
        found.deliveryStatus !== "pending" ||
        found.deliveryAttempts !== claimedAttempts
      ) {
        return false
      }
      found.deliveryStatus = "failed"
      found.lastError = lastError
      return true
    },
    async markFailed(periodStart, claimedAttempts, lastError) {
      const found = row(periodStart)
      if (found === undefined || found.deliveryAttempts !== claimedAttempts) return false
      found.deliveryStatus = "failed"
      found.lastError = lastError
      return true
    },
    async recordNotConfigured(periodStart, pendingOnly) {
      const found = row(periodStart)
      if (found === undefined || found.deliveryStatus === "not_configured") return false
      if (pendingOnly && found.deliveryStatus !== "pending") return false
      found.deliveryStatus = "not_configured"
      return true
    },
  }
}

export interface StubRequest {
  readonly url: string
  readonly method: string
  readonly payloadJson: unknown
  readonly csv: { readonly filename: string; readonly body: string } | null
}

export interface StubOutcome {
  readonly status?: number
  readonly body?: string
  readonly throws?: unknown
}

export interface WebhookStub {
  readonly fetchImpl: typeof globalThis.fetch
  readonly requests: StubRequest[]
  /** Queue one more scripted answer; when the queue runs dry the stub answers 204. */
  respond(outcome: StubOutcome): void
}

export function webhookStub(...outcomes: readonly StubOutcome[]): WebhookStub {
  const queue: StubOutcome[] = [...outcomes]
  const requests: StubRequest[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const form = await new Request(String(input), init).formData()
    const file = form.get("files[0]")
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      payloadJson: JSON.parse(String(form.get("payload_json"))),
      csv: file instanceof File ? { filename: file.name, body: await file.text() } : null,
    })
    const next = queue.shift() ?? { status: 204 }
    if (next.throws !== undefined) throw next.throws
    const status = next.status ?? 204
    // A 204 with a body is a TypeError in the web API, and Discord answers 204 to webhooks.
    return new Response(status === 204 ? null : (next.body ?? ""), { status })
  }) as typeof globalThis.fetch
  return { fetchImpl, requests, respond: (outcome) => queue.push(outcome) }
}

export interface CapturedEvent {
  readonly error: unknown
  readonly context?: {
    readonly tags?: Record<string, string | number | null>
    readonly extra?: Record<string, unknown>
  }
}

export function captureSpy(): {
  readonly capture: (error: unknown, context?: CapturedEvent["context"]) => void
  readonly events: CapturedEvent[]
} {
  const events: CapturedEvent[] = []
  return { events, capture: (error, context) => void events.push({ error, context }) }
}

export function auditSpy(): { readonly audit: AuditRecorder; readonly events: AuditEventInput[] } {
  const events: AuditEventInput[] = []
  return { events, audit: { record: async (event) => void events.push(event) } }
}

/** Asserts a piece of text carries no part of the stub webhook credential. */
export function expectNoWebhookLeak(text: string): void {
  expect(text).not.toContain(STUB_WEBHOOK_TOKEN)
  expect(text).not.toContain(STUB_WEBHOOK_ID)
  expect(text).not.toContain("webhooks/")
}
