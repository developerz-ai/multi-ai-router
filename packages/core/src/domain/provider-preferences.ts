import { z } from "zod"

/**
 * An account's standing preferences for **which upstream endpoint an aggregator routes to** —
 * OpenRouter's request `provider` object, field for field and spelled as on its wire, so a stored
 * value is sent without a mapping. The router still never picks or renames the model (non-negotiable
 * 4): this narrows how the account's upstream serves the model the client named, as a base URL does.
 *
 * Provenance: openrouter.ai/docs/features/provider-routing, read 2026-11-14 — `sort` (`price` |
 * `throughput` | `latency`), `quantizations` (the enum below), `allow_fallbacks`, `order`, `only`,
 * `ignore`, `require_parameters`. Only these seven are accepted; OpenRouter's other fields
 * (`max_price`, `data_collection`, the object form of `sort`, …) stay the client's to send per
 * request until an operator needs one on an account. Strict, so a misspelt field is a `400` at the
 * admin write rather than a preference silently never applied.
 *
 * Which accounts may carry one is the driver's answer (`ProviderSurface.providerPreferences`), and
 * how it meets a client's own `provider` is `dataplane/body/provider-preferences.ts`.
 */

/** OpenRouter's documented quantization levels. An unknown one would match no endpoint at all. */
export const ProviderQuantization = z.enum([
  "int4",
  "int8",
  "fp4",
  "mxfp4",
  "nvfp4",
  "fp6",
  "fp8",
  "mxfp8",
  "fp16",
  "bf16",
  "fp32",
  "unknown",
])
export type ProviderQuantization = z.infer<typeof ProviderQuantization>

/** A provider slug (`deepinfra`, `novita`). Bounded: a list of slugs, not a corpus. */
const SLUG = z.string().trim().min(1).max(200)
const SLUGS = z.array(SLUG).min(1).max(100)

const distinct = (values: readonly string[]) => new Set(values).size === values.length

export const ProviderPreferences = z
  .object({
    sort: z.enum(["price", "throughput", "latency"]).optional(),
    quantizations: z
      .array(ProviderQuantization)
      .min(1)
      .refine(distinct, "quantizations lists a level twice")
      .optional(),
    allow_fallbacks: z.boolean().optional(),
    order: SLUGS.optional(),
    only: SLUGS.optional(),
    ignore: SLUGS.optional(),
    require_parameters: z.boolean().optional(),
  })
  .strict()
  // `{}` would be stored, merged into every request and change nothing: `null` is how to clear.
  .refine((value) => Object.keys(value).length > 0, {
    message: "provider preferences state no field; send null to clear them",
  })
export type ProviderPreferences = z.infer<typeof ProviderPreferences>
