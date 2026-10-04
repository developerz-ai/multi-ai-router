import { z } from "zod"

/** Explicit deployment-owned pairs; arbitrary client model text cannot create these series. */
export const MAX_METRIC_INVENTORY_PAIRS = 256
const inventory = z
  .record(z.string().min(1).max(128), z.array(z.string().min(1).max(128)).min(1))
  .superRefine((value, context) => {
    const count = Object.values(value).reduce((total, models) => total + models.length, 0)
    if (count > MAX_METRIC_INVENTORY_PAIRS)
      context.addIssue({ code: "custom", message: "must contain at most 256 pool/model pairs" })
    for (const models of Object.values(value)) {
      if (new Set(models).size !== models.length)
        context.addIssue({ code: "custom", message: "duplicate models are not allowed" })
    }
  })
export const METRIC_INVENTORY_ENV_FIELDS = {
  METRIC_POOL_MODEL_INVENTORY: z
    .string()
    .max(65_536)
    .transform((text, context) => {
      try {
        return JSON.parse(text) as unknown
      } catch {
        context.addIssue({ code: "custom", message: "must be a JSON pool-to-model-array object" })
        return z.NEVER
      }
    })
    .pipe(inventory)
    .optional(),
}
export type MetricInventory = Readonly<Record<string, readonly string[]>>
export function readMetricInventoryEnv(raw: { METRIC_POOL_MODEL_INVENTORY?: MetricInventory }) {
  return { metricInventory: raw.METRIC_POOL_MODEL_INVENTORY ?? {} }
}
