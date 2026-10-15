import { z } from "zod"

/**
 * Where a stored weekly usage report stands with delivery (issue #229).
 *
 * - `pending`: generated and not yet attempted. Every report starts here.
 * - `not_configured`: delivery is off, so there is nothing to attempt.
 * - `sent`: delivered; `delivered_at` is set.
 * - `failed`: the last attempt failed; `last_error` carries a redacted reason.
 *
 * Stored as `text` against this union rather than as a Postgres enum, the same convention as
 * `usageRecords.outcome`: delivery is a vocabulary that is expected to grow, and a Postgres enum
 * value can never be removed again, so adding one here costs a core change and no migration.
 */
export const UsageReportDeliveryStatus = z.enum(["pending", "not_configured", "sent", "failed"])
export type UsageReportDeliveryStatus = z.infer<typeof UsageReportDeliveryStatus>
