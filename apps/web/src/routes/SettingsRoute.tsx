import { PageHeader } from "../components/PageHeader"
import { Placeholder } from "../components/Placeholder"

export default function SettingsRoute() {
  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Router configuration, price overrides, retention windows and background task health."
      />
      <Placeholder
        icon="settings"
        summary="Everything the operator tunes, plus the proof that background work is still running."
        items={[
          "Price table overrides on top of the shipped static table",
          "Retention windows for usage records, audit events, sessions and OAuth state",
          "Latest run per scheduled task in plain language; a stale task is called out",
          "Audit log of admin-plane mutations, append-only and credential-free",
        ]}
      />
    </>
  )
}
