import type { UtilizationSource } from "@multi-ai-router/core"
import type { QuotaUtilizationSource, QuotaWindowView } from "./api/types"

// Whose figure a quota gauge shows, and why it reads what it reads. Split from `quota-windows.ts`,
// which assembles a window's whole description.

/**
 * Why a gauge reads what it reads. Keyed exhaustively over core's enum plus `gauge` for the same
 * drift reason as `NAMING`; a value outside both is answered by `utilizationNote`'s fallback.
 */
const UTILIZATION_NOTE: Readonly<Record<UtilizationSource | "gauge", string>> = {
  // `continuous` is what the SDK's plan-usage readings arrive as — the subscription's own usage
  // endpoint, a real percentage at any point in the window. `gauge` is kept as its synonym in
  // case core names it that later; both render the same way.
  continuous:
    "From the subscription's usage endpoint — the provider's own accounting, reported as a percentage of the window at any point in it.",
  gauge:
    "From the subscription's usage endpoint — the provider's own accounting, reported as a percentage of the window at any point in it.",
  "threshold-triggered":
    "The provider only reports near the limit, so an empty gauge here is normal, not a fault.",
  // `none` is per-window state, not a provider verdict: no reading has ever arrived for THIS
  // window (claude-sdk's `utilizationSourceOf` maps "no value yet" to `none`). A provider with
  // genuinely no signal has no windows at all, so its rows are never invented and this note
  // never shows for it. Claiming "the provider exposes no signal" for a never-read Claude sub
  // sent operators hunting a provider problem that did not exist (#69).
  none: "No reading yet — readings arrive as the account serves traffic, or on a Test now.",
}

/** The fallback names the fact it lacks: a reading arrived, and this build cannot say from where. */
const UNLABELLED_NOTE =
  "Reported for this window by a source this console version does not label. The figure is the provider's; only its origin is unnamed."

export function utilizationNote(source: QuotaUtilizationSource): string {
  return Object.hasOwn(UTILIZATION_NOTE, source)
    ? UTILIZATION_NOTE[source as UtilizationSource | "gauge"]
    : UNLABELLED_NOTE
}

/**
 * The one word beside the figure saying whose number it is. `reported` for the provider's own
 * reading (gauge or continuous), `measured` for the router's count against a configured ceiling,
 * `unlabelled` for a source this build does not know — and null where there is no figure at all,
 * so an empty gauge never carries a qualifier claiming otherwise.
 */
export type UtilizationQualifier = "reported" | "measured" | "unlabelled"

export function utilizationQualifier(
  window: Pick<QuotaWindowView, "utilization" | "utilizationSource">,
  measured: number | null,
): UtilizationQualifier | null {
  if (window.utilization !== null && Number.isFinite(window.utilization)) {
    const source = window.utilizationSource
    if (source === "gauge" || source === "continuous" || source === "threshold-triggered") {
      return "reported"
    }
    return "unlabelled"
  }
  return measured === null ? null : "measured"
}
