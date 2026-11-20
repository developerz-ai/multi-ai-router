import { boolean, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core"

export const adminLoginThrottleNamespaces = pgTable("admin_login_throttle_namespaces", {
  namespace: text("namespace").primaryKey(),
  sweptAt: timestamp("swept_at", { withTimezone: true }).notNull(),
  saturationUntil: timestamp("saturation_until", { withTimezone: true }).notNull(),
})

export const adminLoginThrottleBuckets = pgTable(
  "admin_login_throttle_buckets",
  {
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    attempts: integer("attempts").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    locked: boolean("locked").notNull(),
    denialReported: boolean("denial_reported").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.namespace, table.key] }),
    index("admin_login_throttle_expiry_idx").on(table.namespace, table.expiresAt),
  ],
)
