import { For } from "solid-js"
import { QueryBoundary } from "../../components/QueryBoundary"
import { TableSkeleton } from "../../components/TableSkeleton"
import type { SettingsView } from "../../lib/api/settings"
import { useSettings } from "../../lib/queries/settings"
import styles from "./RetentionSection.module.scss"

interface Window {
  readonly label: string
  readonly value: string
  /** The environment variable that sets it, verbatim — the operator greps for this. */
  readonly env: string
  /** What it controls, in one line. */
  readonly note: string
}

/**
 * The janitor's windows, the log level and the sweep interval, read-only.
 *
 * Every one of these is an environment variable read once at boot
 * (docs/idea/09-deployment.md), so this section renders **no input**: a field the
 * server would refuse is worse than a printed fact, and a retention window is not
 * something an operator should discover by watching rows disappear.
 */
export function RetentionSection() {
  const settings = useSettings()

  return (
    <section aria-labelledby="retention-heading" class={styles.section}>
      <h2 class={styles.heading} id="retention-heading">
        Retention and boot settings
      </h2>
      <p class={styles.note}>
        Set as environment variables and read once at boot — changing one means editing the
        deployment's environment and restarting. They are shown here because the janitor's behaviour
        is not otherwise visible from the outside.
      </p>

      <QueryBoundary
        errorTitle="Settings could not be loaded"
        loading={<TableSkeleton label="Loading settings" rows={3} />}
        query={settings}
      >
        {(view) => (
          <dl class={styles.facts}>
            <For each={windows(view)}>
              {(window) => (
                <div class={styles.fact}>
                  <dt class={styles.term}>{window.label}</dt>
                  <dd class={styles.value}>
                    {window.value}
                    <span class={styles.hint}>{window.note}</span>
                    <code class={styles.env}>{window.env}</code>
                  </dd>
                </div>
              )}
            </For>
          </dl>
        )}
      </QueryBoundary>
    </section>
  )
}

function windows(view: SettingsView): readonly Window[] {
  return [
    {
      label: "Usage records",
      value: days(view.retention.usageDays),
      env: "RETENTION_USAGE_DAYS",
      note: "Raw per-attempt rows. They roll up to daily aggregates first, so lifetime totals survive the purge.",
    },
    {
      label: "Audit events",
      value: days(view.retention.auditDays),
      env: "RETENTION_AUDIT_DAYS",
      note: "How far back the log below reaches.",
    },
    {
      label: "Sessions",
      value: hours(view.retention.sessionsHours),
      env: "RETENTION_SESSIONS_HOURS",
      note: "Idle sticky-session and fingerprint entries, measured from last use.",
    },
    {
      label: "Revoked keys",
      value: days(view.retention.revokedKeysDays),
      env: "RETENTION_REVOKED_KEYS_DAYS",
      note: "How long a revoked key row survives so its usage history stays joinable.",
    },
    {
      label: "OAuth state",
      value: minutes(view.retention.oauthStateMinutes),
      env: "RETENTION_OAUTH_STATE_MINUTES",
      note: "TTL for one-shot state and PKCE verifiers. Claude subscriptions never hold one.",
    },
    {
      label: "Janitor interval",
      value: minutes(view.janitorIntervalMinutes),
      env: "JANITOR_INTERVAL_MINUTES",
      note: "Base sweep cadence; the scheduler jitters around it so sweeps never land together.",
    },
    {
      label: "Log level",
      value: view.logLevel,
      env: "LOG_LEVEL",
      note: "Structured JSON at every level. Prompts, bodies and credentials are never logged at any of them.",
    },
  ]
}

const days = (value: number): string => (value === 1 ? "1 day" : `${value} days`)
const hours = (value: number): string => (value === 1 ? "1 hour" : `${value} hours`)
const minutes = (value: number): string => (value === 1 ? "1 minute" : `${value} minutes`)
