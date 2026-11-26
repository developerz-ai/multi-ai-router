import { z } from "zod"

/** What an OpenRouter attempt cost, as OpenRouter states it. Sibling of `openrouter.ts`. */

/** USD credits: a finite, non-negative number. Anything else is a figure nobody can book. */
const Dollars = z.number().nonnegative()

/**
 * Provenance: openrouter.ai/docs/use-cases/usage-accounting — every completion's `usage` carries
 * `cost`, the credits charged for it, on a JSON body and on the final chunk of a stream alike;
 * `is_byok` marks a request served on the user's own provider key, where `cost` is OpenRouter's fee
 * alone and `cost_details.upstream_inference_cost` is what that provider charged the key. Blast
 * radius: the `cost_estimate` of every `openrouter` attempt no operator override prices. If
 * OpenRouter renames or drops the field, those attempts read `unknown` again, as before it was read;
 * nothing fails.
 */
const UpstreamShare = z.object({ cost_details: z.object({ upstream_inference_cost: Dollars }) })

/**
 * The dollars OpenRouter billed for one attempt, or `undefined` when its usage states none it can
 * be held to. A BYOK attempt is the fee plus the provider's charge, both of them spend: booking the
 * fee alone would show a BYOK route as nearly free. A BYOK statement whose provider share is missing
 * or malformed is no figure at all — unknown, never the fee passed off as the whole bill.
 */
export function readOpenRouterCost(usage: Record<string, unknown>): number | undefined {
  const cost = Dollars.safeParse(usage.cost)
  if (!cost.success) return undefined
  if (usage.is_byok !== true) return cost.data
  const share = UpstreamShare.safeParse(usage)
  return share.success ? cost.data + share.data.cost_details.upstream_inference_cost : undefined
}
