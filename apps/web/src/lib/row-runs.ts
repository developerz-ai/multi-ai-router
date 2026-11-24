import { type Accessor, createSignal } from "solid-js"

export interface RowRuns<T> {
  /** Rows with a run in flight. */
  readonly pending: Accessor<ReadonlySet<string>>
  /** Why each row's last run failed, until that row runs again. */
  readonly errors: Accessor<ReadonlyMap<string, unknown>>
  /** What each row's last run to succeed answered. */
  readonly results: Accessor<ReadonlyMap<string, T>>
  /** Settles when the run does and never rejects. A row already running is left alone. */
  readonly run: (id: string, start: () => Promise<T>) => Promise<void>
  /** Forgets what one row has to say. */
  readonly reset: (id: string) => void
}

/**
 * One action, many rows. A mutation observer reports its latest call only: press it on a second
 * row and the first loses its spinner, its answer and its error. Here each row keeps its own.
 */
export function createRowRuns<T>(): RowRuns<T> {
  const [pending, setPending] = createSignal<ReadonlySet<string>>(new Set())
  const [errors, setErrors] = createSignal<ReadonlyMap<string, unknown>>(new Map())
  const [results, setResults] = createSignal<ReadonlyMap<string, T>>(new Map())

  const mark = (id: string, running: boolean) =>
    setPending((current) => {
      const next = new Set(current)
      if (running) next.add(id)
      else next.delete(id)
      return next
    })

  return {
    pending,
    errors,
    results,
    run: async (id, start) => {
      if (pending().has(id)) return
      mark(id, true)
      setErrors((current) => without(current, id))
      try {
        const result = await start()
        setResults((current) => new Map(current).set(id, result))
      } catch (failure) {
        setErrors((current) => new Map(current).set(id, failure))
      } finally {
        mark(id, false)
      }
    },
    reset: (id) => {
      setErrors((current) => without(current, id))
      setResults((current) => without(current, id))
    },
  }
}

function without<V>(map: ReadonlyMap<string, V>, id: string): ReadonlyMap<string, V> {
  if (!map.has(id)) return map
  const next = new Map(map)
  next.delete(id)
  return next
}
