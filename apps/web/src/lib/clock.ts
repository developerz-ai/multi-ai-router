import { type Accessor, createSignal, onCleanup } from "solid-js"

/**
 * A ticking clock as a signal, for the one thing that genuinely needs one: a
 * reset countdown has to move without a refetch.
 *
 * The clock is **never read inside a formatter** — `describeReset(input, nowMs)`
 * and `formatRelative(iso, nowMs)` both take the instant as an argument, which
 * is what keeps them pure and unit-testable against a fixed time. This is the
 * only place `Date.now()` is called on a timer, and the interval is torn down
 * with its owner.
 */
export function createNow(intervalMs = 1000): Accessor<number> {
  const [now, setNow] = createSignal(Date.now())
  const handle = setInterval(() => setNow(Date.now()), intervalMs)
  onCleanup(() => clearInterval(handle))
  return now
}
