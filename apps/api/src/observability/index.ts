/**
 * Metrics. Callers import from here; nothing outside this directory reaches into a module inside
 * it.
 *
 * The layer is deliberately one-directional: it reads values other layers already produce — a
 * usage record, a scheduler tick, the warm account catalog — and nothing in those layers imports
 * this one. A router that stops exporting metrics keeps routing.
 */

export {
  type AccountMetric,
  createMetrics,
  type MetricsOptions,
  type RouterMetrics,
  type UsageQueueSample,
} from "./metrics"
export {
  type Counter,
  createRegistry,
  DEFAULT_MAX_SERIES_PER_METRIC,
  type Gauge,
  type Histogram,
  type HistogramSpec,
  type LabelNames,
  type Labels,
  type MetricSpec,
  type Registry,
  type RegistryOptions,
} from "./registry"
export { createRuntimeMetrics, type RuntimeMetricsDeps } from "./runtime"
export { createSeries, type RouterSeries } from "./series"
