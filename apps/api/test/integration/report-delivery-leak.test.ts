import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { z } from "zod"

const fixture = fileURLToPath(new URL("../support/report-delivery-leak.ts", import.meta.url))

/**
 * The leak criterion, end to end (issue #229): the stub webhook throws a fetch error whose message
 * contains the full webhook URL, and the URL — id and token segment included — must appear in none
 * of the places a failure message can reach. The scenario runs in a subprocess (`support/
 * report-delivery-leak.ts`) because the Sentry SDK is process-global; the parent greps every raw
 * surface the child collected. Skipped without a `DATABASE_URL`, like the other live-Postgres
 * suites — and never a real Discord call: the webhook is a stub URL.
 */
const resultSchema = z.object({
  tickStatus: z.string(),
  stubRequests: z.array(z.string()),
  httpBodies: z.array(z.string()),
  logs: z.array(z.string()),
  lastError: z.string().nullable(),
  deliveredStatus: z.string().nullable(),
  attempts: z.number().nullable(),
  taskRunError: z.string().nullable(),
  settingsView: z.string(),
  settingsTasks: z.string(),
  envelopes: z.array(z.string()),
  secrets: z.array(z.string()),
})

type LeakResult = z.infer<typeof resultSchema>

async function run(): Promise<LeakResult> {
  const child = Bun.spawn([process.execPath, "--no-env-file", fixture], {
    // No inherited DSN or preloads can turn this into a real service event; the child's own env
    // sets the stub webhook and a stub DSN.
    env: { PATH: process.env.PATH ?? "", DATABASE_URL: process.env.DATABASE_URL ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exitCode, stderr).toBe(0)
  return resultSchema.parse(JSON.parse(stdout))
}

function expectClean(text: string, secrets: readonly string[], surface: string): void {
  for (const secret of secrets) {
    expect(text, `${surface} leaked ${secret}`).not.toContain(secret)
  }
}

describe.skipIf(!process.env.DATABASE_URL)(
  "weekly report delivery — the webhook URL never leaks",
  () => {
    test("a fetch error naming the full URL stays out of every surface", async () => {
      const result = await run()
      const secrets = result.secrets

      // The scenario itself: the task tick gave up, the re-send failed, and both posted to the stub.
      expect(result.tickStatus).toBe("failed")
      expect(result.stubRequests).toHaveLength(2)
      expect(result.deliveredStatus).toBe("failed")
      expect(result.attempts).toBe(2)
      // The redacted reason survives as the diagnostic half.
      expect(result.lastError).toContain("ECONNREFUSED")
      expect(result.lastError).toContain("[REDACTED]")

      // Log lines: the task's failure line is there, and clean.
      expect(result.logs.some((line) => line.includes("weekly usage report delivery failed"))).toBe(
        true,
      )
      for (const line of result.logs) expectClean(line, secrets, "a log line")

      // HTTP bodies: the re-send's 200-with-failed body and the one-week read.
      expect(result.httpBodies).toHaveLength(2)
      expect(result.httpBodies[0]).toContain("200")
      expect(result.httpBodies[0]).toContain('"deliveryStatus":"failed"')
      expect(result.httpBodies[1]).toContain("200")
      for (const body of result.httpBodies) expectClean(body, secrets, "an HTTP body")

      // The persisted column and the persisted task-run error.
      if (result.lastError === null) throw new Error("expected a stored last_error")
      expectClean(result.lastError, secrets, "usage_reports.last_error")
      if (result.taskRunError === null) throw new Error("expected a stored task-run error")
      expectClean(result.taskRunError, secrets, "scheduled_task_runs.error")

      // Settings: the URL never enters the view (configured yes/no only), and the task outcome the
      // health screen renders is the redacted string.
      expect(result.settingsView).toContain('"discordWebhookConfigured":true')
      expect(result.settingsView).toContain('"lastDeliveredAt":null')
      expectClean(result.settingsView, secrets, "the settings view")
      expect(result.settingsTasks).toContain("usage_weekly_report")
      expectClean(result.settingsTasks, secrets, "the settings task outcome")

      // Sentry: exactly one capture per failed transition — the task's give-up and the failed
      // re-send — each scrubbed by beforeSend before the stub transport saw it.
      expect(result.envelopes).toHaveLength(2)
      const serialized = result.envelopes.join("\n")
      expectClean(serialized, secrets, "a Sentry envelope")
      expect(serialized).toContain("weekly usage report delivery gave up for 2026-10-05")
      expect(serialized).toContain("weekly usage report re-send failed for 2026-10-05")
    }, 60_000)
  },
)
