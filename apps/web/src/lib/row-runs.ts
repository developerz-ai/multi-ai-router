import { type Accessor, createSignal } from "solid-js"

export interface RowRuns<T> {
  /** Rows with a run in flight. */
  readonly pending: Accessor<ReadonlySet<string>>
  readonly isError: boolean
  readonly error: unknown
  readonly isSuccess: boolean
  /** What the last run to succeed answered. */
  readonly data: T | undefined
  /** Settles when the run does and never rejects. A row already running is left alone. */
  readonly run: (
    id: string,
    start: () => Promise<T>,
    handlers?: {
      readonly onSuccess?: (data: T) => void
      readonly onError?: (error: unknown) => void
    },
  ) => Promise<void>
  readonly reset: () => void
}

/**
 * One action, many rows. A mutation observer reports its latest call only: press it on a second
 * row and the first loses its spinner, its error and every callback passed to `mutate`.
 */
export function createRowRuns<T>(): RowRuns<T> {
  const [pending, setPending] = createSignal<ReadonlySet<string>>(new Set())
  const [error, setError] = createSignal<unknown>(null)
  const [data, setData] = createSignal<T | undefined>()

  const mark = (id: string, running: boolean) =>
    setPending((current) => {
      const next = new Set(current)
      if (running) next.add(id)
      else next.delete(id)
      return next
    })

  return {
    pending,
    get isError() {
      return error() !== null
    },
    get error() {
      return error()
    },
    get isSuccess() {
      return data() !== undefined
    },
    get data() {
      return data()
    },
    run: async (id, start, handlers) => {
      if (pending().has(id)) return
      mark(id, true)
      setError(null)
      try {
        const result = await start()
        setData(() => result)
        handlers?.onSuccess?.(result)
      } catch (failure) {
        setError(failure)
        handlers?.onError?.(failure)
      } finally {
        mark(id, false)
      }
    },
    reset: () => {
      setError(null)
      setData(undefined)
    },
  }
}
