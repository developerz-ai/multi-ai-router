import type { QuotaWindowKind } from "@multi-ai-router/core"
import { For, Show } from "solid-js"
import { TextField } from "../../components/Field"
import type { AccountView, ProviderTransport } from "../../lib/api/types"
import {
  QUOTA_WINDOW_DISPLAY_ORDER,
  quotaWindowLabel,
  quotaWindowTitle,
} from "../../lib/quota-windows"
import styles from "./QuotaCeilingFields.module.scss"

/**
 * The operator's per-window token ceilings — the one write that makes the measured quota bar
 * exist at all. The API has accepted `windowTokenLimits` since the column shipped; without these
 * boxes the whole measured-bar path (`quota-windows.ts`, `MEASURED_NOTE`, the sparkline) had no
 * writer and was unreachable from the console.
 *
 * Shown only for Agent-SDK accounts: named quota windows are what Claude subscriptions report,
 * and a ceiling on an account with no windows draws nothing — a control that visibly does
 * nothing is worse than no control. `overage` is likewise excluded: it has no span (core's
 * `QUOTA_WINDOW_SPAN_MS`), so no bar is ever drawn for it and a box would be a silent no-op.
 *
 * These are estimates the operator owns, never provider facts — Anthropic publishes no numeric
 * limit. The bars they produce are labelled *configured/measured* wherever drawn, and nothing in
 * routing reads them.
 */

/** String state of the ceiling boxes, keyed by window. Absent and `""` both mean no ceiling. */
export type CeilingInputs = Readonly<Partial<Record<QuotaWindowKind, string>>>

/** The windows a ceiling can measure against — every spanned window, in reading order. */
export const CEILING_WINDOWS = QUOTA_WINDOW_DISPLAY_ORDER.filter((kind) => kind !== "overage")

/** Matches the API schema's bound, so a typo fails in the browser rather than as a 400. */
const CEILING_MAX = 1_000_000_000_000

/** Stored limits → box contents. A window with no ceiling opens empty, not as `0`. */
export function seedCeilings(limits: AccountView["windowTokenLimits"] | undefined): CeilingInputs {
  const seeded: Partial<Record<QuotaWindowKind, string>> = {}
  for (const kind of CEILING_WINDOWS) {
    const stored = limits?.[kind]
    if (typeof stored === "number" && Number.isFinite(stored)) seeded[kind] = String(stored)
  }
  return seeded
}

/**
 * Box contents → the update body's field. Every empty box is "no ceiling for that window", and
 * all-empty is `null` — the clear-everything spelling the PATCH schema defines, which removes
 * the bars rather than zeroing them. `min`/`step` on the inputs refuse a non-positive or
 * fractional value in the browser first, same contract as the weight/priority pair.
 */
export function parseCeilings(
  values: CeilingInputs,
): Readonly<Partial<Record<QuotaWindowKind, number>>> | null {
  const limits: Partial<Record<QuotaWindowKind, number>> = {}
  for (const kind of CEILING_WINDOWS) {
    const raw = (values[kind] ?? "").trim()
    if (raw.length === 0) continue
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed) || parsed <= 0) continue
    limits[kind] = parsed
  }
  return Object.keys(limits).length > 0 ? limits : null
}

export interface QuotaCeilingFieldsProps {
  /** Gates the whole group: only `agent-sdk` accounts report the windows a ceiling measures. */
  readonly transport: ProviderTransport | undefined
  readonly values: CeilingInputs
  readonly onChange: (window: QuotaWindowKind, value: string) => void
}

export function QuotaCeilingFields(props: QuotaCeilingFieldsProps) {
  return (
    <Show when={props.transport === "agent-sdk"}>
      <fieldset class={styles.group}>
        <legend class={styles.legend}>Window token ceilings</legend>
        <p class={styles.note}>
          Your own estimate of each window's token allowance — the provider states no number. Sets
          the scale of the measured usage bar on this account's quota rows; it never affects
          routing. Empty means no bar for that window.
        </p>
        <div class={styles.fields}>
          <For each={CEILING_WINDOWS}>
            {(kind) => (
              <TextField
                hint={quotaWindowTitle(kind)}
                inputmode="numeric"
                label={`${quotaWindowLabel(kind)} tokens`}
                max={CEILING_MAX}
                min={1}
                onInput={(event) => props.onChange(kind, event.currentTarget.value)}
                step={1}
                type="number"
                value={props.values[kind] ?? ""}
              />
            )}
          </For>
        </div>
      </fieldset>
    </Show>
  )
}
