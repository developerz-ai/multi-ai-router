/**
 * A small Prometheus registry: three metric kinds and one text exposition, hand-rolled.
 *
 * Hand-rolled rather than `prom-client` because what this router needs from a metrics library is
 * about ninety lines of it — three families, an in-memory series map, and the 0.0.4 text format.
 * A dependency here would ship an event-loop-lag collector, a cluster aggregator, and a GC
 * observer into an image whose whole point is a small, auditable attack surface.
 *
 * Two properties the rest of the layer relies on:
 *
 * - **Label names are declared once, at metric construction, and checked by the compiler.** A
 *   series is written through `Labels<L>`, so a `session_id` or a `request_id` cannot be attached
 *   to a metric by accident — the label discipline in docs/idea/08-observability.md is a type
 *   error here, not a review comment.
 * - **Cardinality is bounded.** A label value that turns out to be unbounded stops creating
 *   series at `maxSeriesPerMetric` and reports once, rather than growing until the process dies.
 *   Metrics are diagnostics; they may degrade, they may not take the router with them.
 *
 * Everything is synchronous and allocation-light: an observation is a map lookup and an add.
 */

export type LabelNames = readonly string[]

/** Exactly the labels a metric declared — no more, no fewer. */
export type Labels<L extends LabelNames> = Readonly<Record<L[number], string>>

export interface MetricSpec<L extends LabelNames> {
  readonly name: string
  /** The `# HELP` line. One sentence, present tense. */
  readonly help: string
  readonly labels: L
}

export interface HistogramSpec<L extends LabelNames> extends MetricSpec<L> {
  /** Ascending upper bounds in the metric's own unit. `+Inf` is appended for you. */
  readonly buckets: readonly number[]
}

export interface Counter<L extends LabelNames> {
  /** Adds to a monotonic total. A negative delta is ignored — a counter never goes backwards. */
  inc(labels: Labels<L>, value?: number): void
}

export interface Gauge<L extends LabelNames> {
  set(labels: Labels<L>, value: number): void
  /**
   * Drops every series. A gauge rebuilt from a snapshot on each scrape must forget the accounts
   * that went away, or a deleted account keeps reporting its last known status forever.
   */
  clear(): void
}

export interface Histogram<L extends LabelNames> {
  observe(labels: Labels<L>, value: number): void
}

export interface RegistryOptions {
  /** Ceiling per metric. Not a policy knob: it bounds memory when a label value misbehaves. */
  readonly maxSeriesPerMetric?: number
  /** Called once per metric that hits the ceiling, so the drop has a log line. */
  readonly onSeriesLimit?: (metric: string) => void
}

export const DEFAULT_MAX_SERIES_PER_METRIC = 4_096

export interface Registry {
  counter<const L extends LabelNames>(spec: MetricSpec<L>): Counter<L>
  gauge<const L extends LabelNames>(spec: MetricSpec<L>): Gauge<L>
  histogram<const L extends LabelNames>(spec: HistogramSpec<L>): Histogram<L>
  /**
   * Registers a callback run at the start of every `expose()`, in registration order. This is
   * where a gauge sampled from live state belongs: reading the account catalog once per scrape
   * costs nothing, and reading it on every request would put bookkeeping on the critical path.
   */
  onCollect(collect: () => void): void
  /** The 0.0.4 text exposition, in metric registration order. */
  expose(): string
}

/** One metric family: how it renders itself, given whatever series it has accumulated. */
interface Family {
  render(out: string[]): void
}

export function createRegistry(options: RegistryOptions = {}): Registry {
  const maxSeries = options.maxSeriesPerMetric ?? DEFAULT_MAX_SERIES_PER_METRIC
  const families: Family[] = []
  const collectors: (() => void)[] = []

  /**
   * The series map shared by all three kinds. The key is the label values in declared order, so
   * two metrics never collide and the rendered order is the order series first appeared.
   */
  const store = <T>(spec: MetricSpec<LabelNames>, make: () => T) => {
    const series = new Map<string, { readonly values: readonly string[]; readonly state: T }>()
    let reported = false
    return {
      series,
      clear: () => {
        series.clear()
        reported = false
      },
      /** The series for these labels, or null once the metric is at its ceiling. */
      find: (labels: Readonly<Record<string, string>>): T | null => {
        const values = spec.labels.map((name) => labels[name] ?? "")
        // NUL-joined: a separator a label value could itself contain would let
        // {a="x y",b="z"} and {a="x",b="y z"} collapse into one series.
        const key = values.join("\u0000")
        const existing = series.get(key)
        if (existing !== undefined) return existing.state
        if (series.size >= maxSeries) {
          if (!reported) {
            reported = true
            options.onSeriesLimit?.(spec.name)
          }
          return null
        }
        const state = make()
        series.set(key, { values, state })
        return state
      },
    }
  }

  return {
    counter(spec) {
      const held = store(spec, () => ({ value: 0 }))
      families.push({
        render(out) {
          header(out, spec, "counter")
          for (const { values, state } of held.series.values()) {
            out.push(`${spec.name}${renderLabels(spec.labels, values)} ${format(state.value)}`)
          }
        },
      })
      return {
        inc(labels, value = 1) {
          if (value < 0) return
          const state = held.find(labels)
          if (state !== null) state.value += value
        },
      }
    },

    gauge(spec) {
      const held = store(spec, () => ({ value: 0 }))
      families.push({
        render(out) {
          header(out, spec, "gauge")
          for (const { values, state } of held.series.values()) {
            out.push(`${spec.name}${renderLabels(spec.labels, values)} ${format(state.value)}`)
          }
        },
      })
      return {
        set(labels, value) {
          const state = held.find(labels)
          if (state !== null) state.value = value
        },
        clear: held.clear,
      }
    },

    histogram(spec) {
      const bounds = [...spec.buckets].sort((a, b) => a - b)
      const held = store(spec, () => ({
        counts: new Array<number>(bounds.length).fill(0),
        sum: 0,
        count: 0,
      }))
      families.push({
        render(out) {
          header(out, spec, "histogram")
          for (const { values, state } of held.series.values()) {
            let cumulative = 0
            for (const [index, bound] of bounds.entries()) {
              cumulative += state.counts[index] ?? 0
              const labels = renderLabels([...spec.labels, "le"], [...values, format(bound)])
              out.push(`${spec.name}_bucket${labels} ${format(cumulative)}`)
            }
            const infinite = renderLabels([...spec.labels, "le"], [...values, "+Inf"])
            out.push(`${spec.name}_bucket${infinite} ${format(state.count)}`)
            out.push(`${spec.name}_sum${renderLabels(spec.labels, values)} ${format(state.sum)}`)
            out.push(
              `${spec.name}_count${renderLabels(spec.labels, values)} ${format(state.count)}`,
            )
          }
        },
      })
      return {
        observe(labels, value) {
          if (!Number.isFinite(value)) return
          const state = held.find(labels)
          if (state === null) return
          state.sum += value
          state.count += 1
          // Bucket counts are kept exclusive and summed into cumulative ones at render time:
          // one add per observation instead of one per bucket.
          const index = bounds.findIndex((bound) => value <= bound)
          if (index >= 0) state.counts[index] = (state.counts[index] ?? 0) + 1
        },
      }
    },

    onCollect(collect) {
      collectors.push(collect)
    },

    expose() {
      for (const collect of collectors) collect()
      const out: string[] = []
      for (const family of families) family.render(out)
      return out.length === 0 ? "" : `${out.join("\n")}\n`
    },
  }
}

function header(out: string[], spec: MetricSpec<LabelNames>, type: string): void {
  out.push(`# HELP ${spec.name} ${escapeHelp(spec.help)}`, `# TYPE ${spec.name} ${type}`)
}

function renderLabels(names: LabelNames, values: readonly string[]): string {
  if (names.length === 0) return ""
  const pairs = names.map((name, index) => `${name}="${escapeLabel(values[index] ?? "")}"`)
  return `{${pairs.join(",")}}`
}

function escapeHelp(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n")
}

function escapeLabel(value: string): string {
  return escapeHelp(value).replaceAll('"', '\\"')
}

/** Prometheus spells infinity `+Inf`; everything else is the plain JS rendering. */
function format(value: number): string {
  if (Number.isNaN(value)) return "NaN"
  if (value === Number.POSITIVE_INFINITY) return "+Inf"
  if (value === Number.NEGATIVE_INFINITY) return "-Inf"
  return String(value)
}
