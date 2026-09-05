import type { AccountStatus, ProviderId } from "@multi-ai-router/core"
import { For } from "solid-js"
import { STATUS_DISPLAY_ORDER, statusLabel } from "../../lib/account-status"
import type { ProviderDescriptor } from "../../lib/api/types"
import { providerDisplayName } from "../../lib/provider-display"
import styles from "./AccountsFilters.module.scss"

export interface AccountsFiltersProps {
  readonly status: AccountStatus | ""
  readonly provider: ProviderId | ""
  /** From `GET /providers` — never a list kept in the console. */
  readonly providers: readonly ProviderDescriptor[]
  readonly onStatus: (status: AccountStatus | "") => void
  readonly onProvider: (provider: ProviderId | "") => void
}

/**
 * Status and provider, as two selects. Both narrow the whole grouped page: a provider filter
 * leaves one section, a status filter leaves the rows that match inside every section.
 */
export function AccountsFilters(props: AccountsFiltersProps) {
  return (
    <form class={styles.filters}>
      <label class={styles.filter}>
        <span class={styles.filterLabel}>Status</span>
        <select
          class={styles.select}
          onChange={(event) => props.onStatus(event.currentTarget.value as AccountStatus | "")}
          value={props.status}
        >
          <option value="">Any status</option>
          <For each={STATUS_DISPLAY_ORDER}>
            {(value) => <option value={value}>{statusLabel(value)}</option>}
          </For>
        </select>
      </label>

      <label class={styles.filter}>
        <span class={styles.filterLabel}>Provider</span>
        <select
          class={styles.select}
          onChange={(event) => props.onProvider(event.currentTarget.value as ProviderId | "")}
          value={props.provider}
        >
          <option value="">Any provider</option>
          <For each={props.providers}>
            {(descriptor) => (
              <option value={descriptor.id}>
                {providerDisplayName(descriptor.id)} ({descriptor.id})
              </option>
            )}
          </For>
        </select>
      </label>
    </form>
  )
}
