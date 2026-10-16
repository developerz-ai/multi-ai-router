import { createEffect, createSignal, Show } from "solid-js"
import { Button } from "../../components/Button"
import { isCustomRange, type UsageRange } from "../../lib/api/usage"
import { fromDateTimeInput, toDateTimeInput } from "../../lib/datetime-input"
import styles from "./UsageCustomRange.module.scss"

export interface UsageCustomRangeProps {
  readonly range: UsageRange
  readonly onApply: (range: UsageRange) => void
}

/**
 * The fifth window: a `from`/`to` the server has always accepted, reachable from the console.
 * A `<form>` rather than a live-updating pair of inputs — nothing fires until the operator presses
 * Apply, so a half-typed date never sends a request for a nonsense range. The inputs follow the
 * range in the URL: a deep link to a custom range shows the dates it is showing, and a named
 * window shows empty inputs rather than the dates of a range the page has left.
 */
export function UsageCustomRange(props: UsageCustomRangeProps) {
  const [from, setFrom] = createSignal("")
  const [to, setTo] = createSignal("")
  const [error, setError] = createSignal<string | null>(null)

  createEffect(() => {
    const range = props.range
    if (isCustomRange(range)) {
      setFrom(toDateTimeInput(range.from))
      setTo(toDateTimeInput(range.to))
    } else {
      // A named window leaves the inputs holding the last custom dates: clear them, so the form
      // never offers to re-apply a range the page has already left (#258).
      setFrom("")
      setTo("")
    }
    setError(null)
  })

  function apply(event: SubmitEvent) {
    event.preventDefault()
    const start = fromDateTimeInput(from())
    const end = fromDateTimeInput(to())
    if (start === null || end === null) {
      setError("Both from and to are required.")
      return
    }
    if (Date.parse(start) >= Date.parse(end)) {
      setError("From must be before to.")
      return
    }
    setError(null)
    props.onApply({ from: start, to: end })
  }

  return (
    <form class={styles.customRange} onSubmit={apply}>
      <span class={styles.caption}>Custom range</span>
      <label class={styles.field}>
        From
        <input
          class={styles.input}
          onInput={(event) => setFrom(event.currentTarget.value)}
          type="datetime-local"
          value={from()}
        />
      </label>
      <label class={styles.field}>
        To
        <input
          class={styles.input}
          onInput={(event) => setTo(event.currentTarget.value)}
          type="datetime-local"
          value={to()}
        />
      </label>
      <Button size="sm" tone="neutral" type="submit">
        Apply
      </Button>
      <Show when={isCustomRange(props.range)}>
        <span class={styles.active}>Showing a custom range</span>
      </Show>
      <Show when={error()}>{(message) => <span class={styles.err}>{message()}</span>}</Show>
    </form>
  )
}
