/**
 * The settings screen: environment configuration as read at boot, the price-override table, the
 * scheduler's last-run records, and the audit feed. Callers import from here; nothing outside this
 * directory reaches into a module inside it.
 */

export type { PriceOverrideDiff } from "./audit"
export { diffPriceOverrides, PRICE_OVERRIDES_SETTING, priceOverrideAuditDetail } from "./audit"
export type {
  AuditEventView,
  AuditQuery,
  AuditView,
  PriceOverrideView,
  PriceRateView,
  PricesView,
  SettingsView,
  TaskHealth,
  TaskHealthView,
  TaskRunView,
  TaskStatusView,
  UpdatePriceOverridesInput,
} from "./schema"
export {
  AUDIT_LIMIT_DEFAULT,
  AUDIT_LIMIT_MAX,
  AUDIT_LIMIT_MIN,
  auditQuery,
  MAX_PRICE_OVERRIDES,
  priceOverrideInput,
  updatePriceOverridesBody,
} from "./schema"
export type { SettingsService, SettingsServiceDeps } from "./service"
export { createSettingsService } from "./service"
export type { TaskHealthInput, TaskStatusInput } from "./tasks"
export { classifyTaskHealth, toTaskStatusView } from "./tasks"
