import { AdminAuthError } from "@multi-ai-router/core"
import {
  createDatabase,
  createScheduledTaskRepository,
  createUsageHistoryRepository,
  createUsageRecentRepository,
  createUsageReportRepository,
  defaultMigrationsFolder,
  runMigrations,
  scheduledTask,
} from "@multi-ai-router/db"
import * as Sentry from "@sentry/bun"
import { Hono } from "hono"
import { parseEnv } from "../../src/config/env"
import { createLogger } from "../../src/logging/logger"
import type { AdminAuthEnv } from "../../src/middleware/adminAuth"
import { adminAuth } from "../../src/middleware/adminAuth"
import { errorHandler, notFoundHandler } from "../../src/middleware/errorHandler"
import { initSentry } from "../../src/observability/sentry"
import { ADMIN_USAGE_BASE_PATH, adminUsageRoutes } from "../../src/routes/admin/usage"
import { createScheduler } from "../../src/scheduler"
import { createUsageWeeklyReportTask } from "../../src/scheduler/tasks/usage-weekly-report"
import type { AuditRecorder } from "../../src/services/admin/audit"
import { createSettingsService } from "../../src/services/settings"
import { createUsageService } from "../../src/services/usage-read"
import { createUsageReportService } from "../../src/services/usage-report"
import { createReportDeliveryService } from "../../src/services/usage-report/delivery"
import { STUB_WEBHOOK_URL } from "./report-delivery"
import { storedPayload } from "./weekly-report"

/**
 * The webhook-URL leak scenario, end to end (issue #229's leak criterion), run in a subprocess
 * because the Sentry SDK is process-global (precedent: `sentry-transport.ts`). The stub webhook
 * throws a fetch error whose message contains the full URL; every surface the URL could land on —
 * log lines, HTTP bodies, `usage_reports.last_error`, `scheduled_task_runs.error`, the Settings
 * task outcome, and the captured Sentry event through `initSentry` with a stub transport — is
 * collected as raw text and printed for the parent to grep. A stub URL only; never a real webhook.
 *
 * Env in: `DATABASE_URL` (an admin connection; the fixture makes its own disposable database).
 */

const adminUrl = process.env.DATABASE_URL ?? ""
const logs: string[] = []
const logger = createLogger({ level: "debug", write: (line) => void logs.push(line) })

const env = parseEnv({
  DATABASE_URL: adminUrl,
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  SENTRY_DSN: "https://public@example.invalid/1",
  SENTRY_ENVIRONMENT: "report-delivery-leak",
  USAGE_REPORT_DISCORD_WEBHOOK_URL: STUB_WEBHOOK_URL,
  // One attempt: the tick's only post gives up in the same tick, so the run row records the
  // failure — the surface this scenario exists to inspect.
  USAGE_REPORT_MAX_DELIVERY_ATTEMPTS: "1",
})

const envelopes: string[] = []
initSentry(env, logger, (options) =>
  Sentry.createTransport(options, async (request) => {
    envelopes.push(
      typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body),
    )
    return { statusCode: 200 }
  }),
)

const name = `report_delivery_leak_${crypto.randomUUID().replaceAll("-", "")}`
const admin = createDatabase({ url: adminUrl, maxConnections: 1 })
await admin.sql.unsafe(`create database "${name}"`)
const uri = new URL(adminUrl)
uri.pathname = `/${name}`
await runMigrations({ url: uri.toString(), migrationsFolder: defaultMigrationsFolder() })
const handle = createDatabase({ url: uri.toString(), maxConnections: 4 })

try {
  const reports = createUsageReportRepository(handle.db)
  const taskRuns = createScheduledTaskRepository(handle.db)
  await reports.insertIfAbsent({
    periodStart: "2026-10-05",
    periodEnd: "2026-10-12",
    generatedAt: new Date("2026-10-12T00:30:00.000Z"),
    payload: storedPayload(),
  })

  // The webhook stub: records the request, then a fetch error quoting the whole URL — message and
  // cause — the way a real `fetch` failure names the address it tried.
  const stubRequests: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    stubRequests.push(String(input))
    throw new Error(
      `request to ${STUB_WEBHOOK_URL}?wait=true failed, reason: connect ECONNREFUSED`,
      { cause: new Error(`posting to ${STUB_WEBHOOK_URL} hit ECONNREFUSED 10.0.0.1:443`) },
    )
  }) as typeof globalThis.fetch

  const audit: AuditRecorder = { record: async () => undefined }
  const now = () => new Date("2026-10-12T01:00:00.000Z")
  const delivery = createReportDeliveryService({
    store: reports,
    audit,
    webhookUrl: env.usageReport.discordWebhookUrl,
    maxDeliveryAttempts: env.usageReport.maxDeliveryAttempts,
    publicUrl: env.publicUrl,
    timeoutMs: env.usageReport.deliveryTimeoutMs,
    now,
    fetchImpl,
  })

  // The real scheduler and the real run-record repository, so `scheduled_task_runs.error` is the
  // persisted surface an operator reads. The lock is always free: exclusion is not under test.
  const scheduler = createScheduler({
    tasks: [
      createUsageWeeklyReportTask({
        reports: {
          exists: (periodStart) => reports.exists(periodStart),
          generate: () => Promise.resolve(false),
        },
        anchorOffsetMs: 30 * 60_000,
        intervalMs: 60 * 60_000,
        delivery,
      }),
    ],
    repo: taskRuns,
    logger,
    lock: async (_key, work) => ({ acquired: true, value: await work() }),
    jitterFraction: 0,
    now,
  })
  const tick = await scheduler.runNow("usage_weekly_report")

  // The admin plane over the same database: the re-send endpoint and the one-week read.
  const labels = async () => ({ keys: new Map(), accounts: new Map(), pools: new Map() })
  const usage = createUsageService({
    history: createUsageHistoryRepository(handle.db),
    recent: createUsageRecentRepository(handle.db),
    labels,
    now,
    exportMaxRows: 1000,
  })
  const reportService = createUsageReportService({
    reports,
    history: createUsageHistoryRepository(handle.db),
    labels,
    pools: async () => [],
    upstreamTimeoutMs: 600_000,
    upstreamStreamTimeoutMs: 600_000,
    maxRows: 1000,
    listLimit: 10,
    now,
  })
  const app = new Hono<AdminAuthEnv>()
  app.onError(errorHandler(logger))
  app.notFound(notFoundHandler())
  app.route(
    ADMIN_USAGE_BASE_PATH,
    adminUsageRoutes({
      service: usage,
      reports: reportService,
      delivery,
      guard: adminAuth(
        {
          authenticate: async () => ({
            id: "s",
            username: "admin",
            csrfToken: "csrf",
            createdAtMs: Date.now(),
            lastSeenAtMs: Date.now(),
          }),
          assertCsrf: (_session, token) => {
            if (token !== "csrf") throw new AdminAuthError("CSRF token invalid")
          },
        },
        true,
      ),
    }),
  )
  const httpBodies: string[] = []
  const deliver = await app.request(`${ADMIN_USAGE_BASE_PATH}/reports/2026-10-05/deliver`, {
    method: "POST",
    headers: { "x-csrf-token": "csrf" },
  })
  httpBodies.push(`${deliver.status} ${await deliver.text()}`)
  const one = await app.request(`${ADMIN_USAGE_BASE_PATH}/reports/2026-10-05`)
  httpBodies.push(`${one.status} ${await one.text()}`)

  // Settings: the weekly-report panel (configured yes/no, never the URL) and the task outcome.
  const settings = createSettingsService({
    prices: { list: async () => [], replaceAll: async () => [] },
    scheduledTasks: taskRuns,
    auditEvents: { list: async () => [], listForSubject: async () => [] },
    audit,
    usageReports: reports,
    env,
    intervals: Object.fromEntries(scheduledTask.enumValues.map((task) => [task, 3_600_000])),
    now,
  })
  const settingsView = await settings.read()
  const settingsTasks = await settings.tasks()

  const row = await reports.findByPeriodStart("2026-10-05")
  const run = await taskRuns.lastRun("usage_weekly_report")
  await Sentry.flush(2_000)
  await Sentry.close(2_000)

  process.stdout.write(
    JSON.stringify({
      tickStatus: tick.status,
      stubRequests,
      httpBodies,
      logs,
      lastError: row?.lastError ?? null,
      deliveredStatus: row?.deliveryStatus ?? null,
      attempts: row?.deliveryAttempts ?? null,
      taskRunError: run?.error ?? null,
      settingsView: JSON.stringify(settingsView),
      settingsTasks: JSON.stringify(settingsTasks),
      envelopes,
      secrets: [STUB_WEBHOOK_URL, "STUB-TOKEN_do-not-leak", "9876543210"],
    }),
  )
} finally {
  await handle.close()
  await admin.sql.unsafe(`drop database if exists "${name}" with (force)`)
  await admin.close()
}
