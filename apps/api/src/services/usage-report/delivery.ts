import type { UsageReportDeliveryStatus } from "@multi-ai-router/core"
import type { UsageReportRow } from "@multi-ai-router/db"
import { redactValue } from "../../logging/redact"
import { captureException } from "../../observability/sentry"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../admin/audit"
import { type AdminResult, conflict, invalid, notFound, ok } from "../admin/result"
import { postDelivery } from "./discord-post"
import { renderDiscordDelivery } from "./discord-render"
import { weeklyReportPayload } from "./payload-schema"
import { isoDay, parseReportWeek } from "./period"

/**
 * Discord delivery of the stored weekly report (issue #229). Two entry points over one claim:
 *
 * - {@link ReportDeliveryService.deliverDue} — the task's path. Only ever called for the latest
 *   period; only a `pending` row below the attempt cap is posted, so older `pending` or
 *   `not_configured` rows are never resurrected by a tick. Retryable failures (429, 5xx, network,
 *   timeout) leave the row `pending` for a later tick; giving up — cap reached or a terminal 4xx —
 *   writes `failed` and captures exactly once, tied to the conditional `pending → failed`
 *   transition so racing deliverers produce one capture per period.
 * - {@link ReportDeliveryService.redeliver} — the admin re-send. Any status may be re-sent (a
 *   `sent` week posts again), the attempt cap never applies, and every call that reaches the
 *   network writes exactly one audit row.
 *
 * Both claim before posting: the claim is a conditional `UPDATE ... RETURNING` on the status and
 * attempts the caller read, and **no claim, no request**. Every outcome write is conditional on
 * the claimed attempts value, so a stale writer's result is a no-op and the last claim wins.
 *
 * The webhook URL is a credential: it is only ever a fetch destination, and every message that
 * leaves this module (reasons, `last_error`, captures) is scrubbed by the redactor, which knows
 * Discord webhook URLs by shape.
 */

/** The repository subset delivery uses — structural, so a test double needs no database. */
export interface ReportDeliveryStore {
  findByPeriodStart(periodStart: string): Promise<UsageReportRow | undefined>
  claimForDelivery(
    periodStart: string,
    readStatus: UsageReportDeliveryStatus,
    readAttempts: number,
  ): Promise<number | undefined>
  markDelivered(periodStart: string, claimedAttempts: number, deliveredAt: Date): Promise<boolean>
  markPendingFailed(
    periodStart: string,
    claimedAttempts: number,
    lastError: string,
  ): Promise<boolean>
  markFailed(periodStart: string, claimedAttempts: number, lastError: string): Promise<boolean>
  recordNotConfigured(periodStart: string, pendingOnly: boolean): Promise<boolean>
}

export interface ReportDeliveryDeps {
  readonly store: ReportDeliveryStore
  readonly audit: AuditRecorder
  /** `env.usageReport.discordWebhookUrl`. `null` means delivery is off: no network, ever. */
  readonly webhookUrl: string | null
  /** The task's give-up threshold. Never limits a re-send. */
  readonly maxDeliveryAttempts: number
  /** `env.publicUrl` — for the filtered Usage link only; `null` omits the link. */
  readonly publicUrl: string | null
  readonly timeoutMs: number
  readonly now: () => Date
  readonly fetchImpl?: typeof globalThis.fetch
  readonly capture?: typeof captureException
}

export type DueDelivery =
  | { readonly action: "sent"; readonly attempts: number }
  | { readonly action: "retry"; readonly attempts: number; readonly reason: string }
  | { readonly action: "failed"; readonly attempts: number; readonly reason: string }
  | { readonly action: "not_configured"; readonly recorded: boolean }
  | { readonly action: "skipped"; readonly reason: string }

export interface RedeliverView {
  readonly periodStart: string
  readonly deliveryStatus: UsageReportDeliveryStatus
  readonly deliveryAttempts: number
  readonly deliveredAt: string | null
  /** Present only on a failed re-send: the redacted reason, identical to the stored `last_error`. */
  readonly lastError?: string
}

export interface ReportDeliveryService {
  deliverDue(periodStart: string): Promise<DueDelivery>
  /** The re-send endpoint's whole behaviour; the route renders the result and nothing else. */
  redeliver(periodStart: string): Promise<AdminResult<RedeliverView>>
}

const iso = (at: Date | null): string | null => at?.toISOString() ?? null

/** The payload is not a v1 report: a static reason, the same for the task and the re-send. */
const NOT_A_REPORT = "the stored payload is not a v1 weekly report"

export function createReportDeliveryService(deps: ReportDeliveryDeps): ReportDeliveryService {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const capture = deps.capture ?? captureException

  type PostAttempt =
    | { readonly kind: "posted" }
    /** Refused before any request: a payload that is not a v1 report, or no destination. */
    | { readonly kind: "refused"; readonly message: string }
    | { readonly kind: "answered"; readonly retryable: boolean; readonly message: string }

  async function attemptPost(payload: unknown): Promise<PostAttempt> {
    const parsed = weeklyReportPayload.safeParse(payload)
    if (!parsed.success) return { kind: "refused", message: NOT_A_REPORT }
    if (deps.webhookUrl === null) {
      // Unreachable: both entry points branch on the URL before claiming. Belt and braces — this
      // module must never guess a destination.
      return { kind: "refused", message: "delivery is not configured" }
    }
    const rendered = renderDiscordDelivery(parsed.data, { publicUrl: deps.publicUrl })
    const result = await postDelivery(rendered, {
      webhookUrl: deps.webhookUrl,
      timeoutMs: deps.timeoutMs,
      fetchImpl,
    })
    if (result.ok) return { kind: "posted" }
    return { kind: "answered", retryable: result.retryable, message: result.message }
  }

  async function giveUp(
    periodStart: string,
    claimed: number,
    reason: string,
  ): Promise<DueDelivery> {
    const transitioned = await deps.store.markPendingFailed(periodStart, claimed, reason)
    if (transitioned) {
      capture(new Error(`weekly usage report delivery gave up for ${periodStart}: ${reason}`), {
        tags: { usageReportPeriod: periodStart },
        extra: { attempts: claimed },
      })
    }
    return { action: "failed", attempts: claimed, reason }
  }

  async function deliverClaimed(
    periodStart: string,
    payload: unknown,
    claimed: number,
  ): Promise<DueDelivery> {
    const result = await attemptPost(payload)
    if (result.kind === "posted") {
      // A `false` here means a concurrent claim moved the row on; our post happened regardless
      // and the winner's outcome stands — the documented last-writer behaviour.
      await deps.store.markDelivered(periodStart, claimed, deps.now())
      return { action: "sent", attempts: claimed }
    }
    if (result.kind === "refused") return giveUp(periodStart, claimed, result.message)
    if (result.retryable && claimed < deps.maxDeliveryAttempts) {
      return { action: "retry", attempts: claimed, reason: result.message }
    }
    return giveUp(periodStart, claimed, result.message)
  }

  return {
    async deliverDue(periodStart) {
      if (deps.webhookUrl === null) {
        const recorded = await deps.store.recordNotConfigured(periodStart, true)
        return { action: "not_configured", recorded }
      }
      const row = await deps.store.findByPeriodStart(periodStart)
      if (row === undefined) return { action: "skipped", reason: "no report is stored" }
      if (row.deliveryStatus !== "pending") {
        return { action: "skipped", reason: `the row is ${row.deliveryStatus}` }
      }
      if (row.deliveryAttempts >= deps.maxDeliveryAttempts) {
        // A row can only sit here if a give-up write lost its race; the operator re-send is its
        // exit — the cap deliberately never clears itself on a timer.
        return { action: "skipped", reason: "the attempt cap is reached" }
      }
      const claimed = await deps.store.claimForDelivery(
        periodStart,
        "pending",
        row.deliveryAttempts,
      )
      if (claimed === undefined) {
        return { action: "skipped", reason: "another deliverer claimed the row first" }
      }
      return deliverClaimed(periodStart, row.payload, claimed)
    },

    async redeliver(periodStartParam) {
      const monday = parseReportWeek(periodStartParam)
      if (monday === undefined) {
        return invalid(
          `"${redactValue(periodStartParam)}" is not a report week: period_start is a UTC Monday ` +
            `written as YYYY-MM-DD`,
        )
      }
      const periodStart = isoDay(monday)
      const row = await deps.store.findByPeriodStart(periodStart)
      // Absent means absent: no network call and no generation — the task owns generation, and a
      // re-send must not become a second way to make a report exist.
      if (row === undefined) return notFound(`no report is stored for the week of ${periodStart}`)

      if (deps.webhookUrl === null) {
        await deps.store.recordNotConfigured(periodStart, false)
        return ok({
          periodStart,
          deliveryStatus: "not_configured",
          deliveryAttempts: row.deliveryAttempts,
          deliveredAt: iso(row.deliveredAt),
        })
      }

      const claimed = await deps.store.claimForDelivery(
        periodStart,
        row.deliveryStatus,
        row.deliveryAttempts,
      )
      if (claimed === undefined) {
        return conflict(
          "the report was claimed for delivery between this call's read and its claim; nothing " +
            "was posted — reload the list and try again",
          "delivery_claim_lost",
        )
      }

      const result = await attemptPost(row.payload)
      if (result.kind === "posted") {
        const deliveredAt = deps.now()
        await deps.store.markDelivered(periodStart, claimed, deliveredAt)
        await deps.audit.record({
          kind: AUDIT_KINDS.usageReportDelivered,
          subjectType: AUDIT_SUBJECTS.usageReport,
          subjectId: periodStart,
          detail: { outcome: "sent", attempts: claimed },
        })
        return ok({
          periodStart,
          deliveryStatus: "sent",
          deliveryAttempts: claimed,
          deliveredAt: deliveredAt.toISOString(),
        })
      }
      return failRedeliver(periodStart, row, claimed, result.message, result.kind === "refused")
    },
  }

  /**
   * A failed re-send answers **200 with `deliveryStatus: "failed"`** — not a 5xx. The middleware
   * error handler captures every 5xx it renders, and this failure is already captured exactly
   * once here; a 502 would make it twice for one operator click.
   */
  async function failRedeliver(
    periodStart: string,
    row: UsageReportRow,
    claimed: number,
    message: string,
    noRequest: boolean,
  ): Promise<AdminResult<RedeliverView>> {
    // Whatever the prior status was — a failed re-send of a sent week marks the week failed.
    await deps.store.markFailed(periodStart, claimed, message)
    capture(new Error(`weekly usage report re-send failed for ${periodStart}: ${message}`), {
      tags: { usageReportPeriod: periodStart },
      extra: { attempts: claimed, priorStatus: row.deliveryStatus },
    })
    // One audit row per re-send call that got past the claim. A refused payload never reached the
    // network but is still the operator's act, so it records like any failure.
    await deps.audit.record({
      kind: AUDIT_KINDS.usageReportDelivered,
      subjectType: AUDIT_SUBJECTS.usageReport,
      subjectId: periodStart,
      detail: {
        outcome: "failed",
        attempts: claimed,
        priorStatus: row.deliveryStatus,
        ...(noRequest ? { note: "the stored payload was refused; no request was made" } : {}),
      },
    })
    return ok({
      periodStart,
      deliveryStatus: "failed",
      deliveryAttempts: claimed,
      deliveredAt: iso(row.deliveredAt),
      lastError: message,
    })
  }
}
