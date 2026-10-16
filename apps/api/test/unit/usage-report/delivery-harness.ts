import type { AuditEventInput } from "../../../src/services/admin/audit"
import type {
  ReportDeliveryDeps,
  ReportDeliveryService,
} from "../../../src/services/usage-report/delivery"
import { createReportDeliveryService } from "../../../src/services/usage-report/delivery"
import {
  auditSpy,
  type CapturedEvent,
  captureSpy,
  type MemoryReportStore,
  memoryReportStore,
  REPORT_PERIOD,
  reportRow,
  STUB_WEBHOOK_URL,
  type StubRequest,
  webhookStub,
} from "../../support/report-delivery"

/**
 * Shared harness for the delivery state-machine tests (issue #229). Pure in-process doubles —
 * the database semantics of the conditional writes are pinned separately in
 * `packages/db/test/integration/usage-reports`.
 */

export const NOW = new Date("2026-10-12T01:00:00.000Z")

export interface Harness {
  readonly service: ReportDeliveryService
  readonly store: MemoryReportStore
  readonly requests: StubRequest[]
  readonly captured: CapturedEvent[]
  readonly audits: AuditEventInput[]
  readonly row: () => ReturnType<MemoryReportStore["rows"]["get"]>
}

export type RowSeed = Parameters<typeof reportRow>

export function setup(over: Partial<ReportDeliveryDeps> = {}, ...rows: RowSeed[]): Harness {
  const stub = webhookStub()
  const spy = captureSpy()
  const aud = auditSpy()
  const store =
    over.store ??
    memoryReportStore(...(rows.length > 0 ? rows.map(([p, o]) => reportRow(p, o)) : [reportRow()]))
  const deps: ReportDeliveryDeps = {
    store,
    audit: aud.audit,
    webhookUrl: STUB_WEBHOOK_URL,
    maxDeliveryAttempts: 6,
    publicUrl: null,
    timeoutMs: 1_000,
    now: () => NOW,
    fetchImpl: stub.fetchImpl,
    capture: spy.capture,
    ...over,
  }
  return {
    service: createReportDeliveryService(deps),
    store: store as MemoryReportStore,
    requests: stub.requests,
    captured: spy.events,
    audits: aud.events,
    row: () => (store as MemoryReportStore).rows.get(REPORT_PERIOD),
  }
}

/** The store double with its claim rigged to miss — "another deliverer got there first". */
export function contendedStore(): MemoryReportStore {
  const inner = memoryReportStore(reportRow())
  return { ...inner, claimForDelivery: async () => undefined }
}
