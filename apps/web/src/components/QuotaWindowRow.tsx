import { Show } from "solid-js"
import type { QuotaWindowDisplay } from "../lib/quota-windows"
import { quotaWindowTone } from "../lib/quota-windows"
import { formatAbsolute, type ResetQualifier } from "../lib/reset-countdown"
import { Badge, type BadgeTone } from "./Badge"
import { QuotaGauge } from "./QuotaGauge"
import styles from "./QuotaWindowRow.module.scss"
import { Sparkline } from "./Sparkline"

export interface QuotaWindowRowProps {
  readonly window: QuotaWindowDisplay
  /** Names the gauge for assistive tech — the account label, so two rows are distinguishable. */
  readonly owner: string
}

/**
 * One quota window, as every surface renders it.
 *
 * Shared rather than written per screen because the rules that make it correct are easy to lose
 * one at a time, and they were: reset shown as **absolute time and countdown together**, the source
 * labelled on **every** row including `unknown`, the blocking window marked with an edge *and* a
 * word rather than colour alone, and a gauge with no reading drawn as explicitly unread. Two copies
 * of this drifted apart on exactly those points before it was lifted here.
 *
 * The `exhausted` rule is not enforced here — `describeQuotaWindows` has already collapsed those
 * rows to "needs top-up" with no instant, so there is nothing left for a template to leak.
 */
export function QuotaWindowRow(props: QuotaWindowRowProps) {
  const window = () => props.window

  return (
    <li class={styles.row} data-spent={window().spent ? "true" : "false"}>
      <span class={styles.label} title={window().title}>
        {window().label}
      </span>

      <QuotaGauge
        label={`${props.owner}, ${window().title} utilization`}
        note={window().utilizationNote}
        text={window().utilizationText}
        tone={quotaWindowTone(window())}
        value={window().utilization}
      />

      {/*
        Only where the bar is the router's own count — `describeQuotaWindow` empties the series
        beside a provider-reported percentage, because a curve about one accounting next to a
        number from another is two measurements pretending to be one.

        It earns its space by answering what the bar cannot: two windows both two-thirds spent
        look identical until one of them shows the whole two-thirds went in the first hour.
      */}
      <Show when={window().tokenSeries.length > 0}>
        <span
          class={styles.trend}
          title="Tokens this router recorded across the window's span, oldest first. Same measurement as the bar — these slices are what it sums."
        >
          <Sparkline
            label={`${props.owner}, ${window().title} consumption over the window`}
            points={[...window().tokenSeries]}
          />
        </span>
      </Show>

      <span class={styles.reset}>
        <span class={window().reset.kind === "needs_topup" ? styles.topUp : styles.text}>
          {window().reset.text}
        </span>

        <Show when={window().resetsAtMs !== null}>
          <span class={styles.absolute}>{formatAbsolute(window().resetsAtMs ?? 0)}</span>
        </Show>

        <Badge
          title={QUALIFIER_HINT[window().resetLabel]}
          tone={QUALIFIER_TONE[window().resetLabel]}
        >
          {window().resetLabel}
        </Badge>

        <Show when={window().spent}>
          <Badge title="This window is what is holding the account out of routing." tone="danger">
            spent
          </Badge>
        </Show>
      </span>
    </li>
  )
}

// Keyed exhaustively over the qualifier union, for the same reason `describeReset` keys its own:
// a fallback branch is what silently relabels an unrecognised source as a trustworthy one.
const QUALIFIER_TONE: Readonly<Record<ResetQualifier, BadgeTone>> = {
  reported: "neutral",
  estimated: "warn",
  unknown: "warn",
}

const QUALIFIER_HINT: Readonly<Record<ResetQualifier, string>> = {
  reported: "The provider stated this reset time.",
  estimated: "Derived from observed behaviour — not stated by the provider.",
  unknown: "No reset instant is known for this window. The router retries with backoff.",
}
