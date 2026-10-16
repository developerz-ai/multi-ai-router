import { QueryBoundary } from "../../components/QueryBoundary"
import { TableSkeleton } from "../../components/TableSkeleton"
import { formatTimestamp } from "../../lib/format"
import { useSettings } from "../../lib/queries/settings"
import styles from "./WeeklyReportSection.module.scss"

/**
 * The weekly usage report's Discord delivery, read-only (issue #229).
 *
 * The webhook URL is a credential, so this panel shows exactly two facts: whether one is
 * configured, and when a report last reached the channel. The value itself never enters a view —
 * the server answers a boolean, not the URL. Configuration lives in the deployment's environment
 * (`USAGE_REPORT_DISCORD_WEBHOOK_URL`); the per-week delivery state lives on the Usage screen's
 * weekly-reports list, where the re-send button is.
 */
export function WeeklyReportSection() {
  const settings = useSettings()

  return (
    <section aria-labelledby="weekly-report-heading" class={styles.section}>
      <h2 class={styles.heading} id="weekly-report-heading">
        Weekly report delivery
      </h2>
      <p class={styles.note}>
        The stored weekly usage report is posted to a Discord channel by the scheduler. Per-week
        delivery state and the re-send button are on the Usage screen.
      </p>

      <QueryBoundary
        errorTitle="Settings could not be loaded"
        loading={<TableSkeleton label="Loading settings" rows={2} />}
        query={settings}
      >
        {(view) => (
          <dl class={styles.facts}>
            <div class={styles.fact}>
              <dt class={styles.term}>Discord webhook</dt>
              <dd class={styles.value}>
                {view.usageReport.discordWebhookConfigured ? "Configured" : "Not configured"}
                <span class={styles.hint}>
                  {view.usageReport.discordWebhookConfigured
                    ? "Reports post to the channel after each week is generated."
                    : "Reports store as not_configured and nothing makes a network call."}
                </span>
                <code class={styles.env}>USAGE_REPORT_DISCORD_WEBHOOK_URL</code>
              </dd>
            </div>
            <div class={styles.fact}>
              <dt class={styles.term}>Last delivered</dt>
              <dd class={styles.value}>
                {formatTimestamp(view.usageReport.lastDeliveredAt)}
                <span class={styles.hint}>
                  The newest stored delivery, by any path — the task or an operator's re-send.
                </span>
              </dd>
            </div>
          </dl>
        )}
      </QueryBoundary>
    </section>
  )
}
