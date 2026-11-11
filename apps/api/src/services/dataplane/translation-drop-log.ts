import type { Logger } from "../../logging/logger"
import type { TranslationDrop } from "../translate/shared/drops"
import { dropSignature } from "../translate/shared/drops"

/**
 * One `translation dropped fields` warn per (key, dialect pair, drop signature) per window: tesote
 * logged 15,379 identical lines (plan 101, 12.15) for one client re-sending one body. Repeats inside
 * the window go to `debug`. Bounded: the oldest signature is forgotten once `maxEntries` are held.
 */

/** `TRANSLATION_DROP_LOG_WINDOW_SECONDS` default. */
export const DEFAULT_DROP_LOG_WINDOW_MS = 3_600_000
/** Distinct signatures remembered; a bound on memory, not an operator knob. */
const MAX_ENTRIES = 4_096

export function createTranslationDropLog(options: {
  readonly windowMs?: number | undefined
  readonly now: () => number
}) {
  const windowMs = options.windowMs ?? DEFAULT_DROP_LOG_WINDOW_MS
  // Insertion order is age order: a re-warned signature is deleted and re-set to the back.
  const warnedAt = new Map<string, number>()
  return {
    /** True when this signature has not been warned about inside the window. */
    shouldWarn(signature: string): boolean {
      const now = options.now()
      const last = warnedAt.get(signature)
      if (last !== undefined && now - last < windowMs) return false
      warnedAt.delete(signature)
      warnedAt.set(signature, now)
      if (warnedAt.size > MAX_ENTRIES) {
        const oldest = warnedAt.keys().next()
        if (oldest.done !== true) warnedAt.delete(oldest.value)
      }
      return true
    },
  }
}

/** Dropped fields one log line spells out; bounds one field, not an operator knob. */
const MAX_REPORTED_DROPS = 20

/** The drop sink a request's translation reports to: warn once per signature, then `debug`. */
export function dropReporter(
  dropLog: ReturnType<typeof createTranslationDropLog>,
  log: Logger | undefined,
  keyId: string,
) {
  return (
    pair: { readonly ingress: string; readonly egress: string },
    drops: readonly TranslationDrop[],
  ): void => {
    const signature = `${keyId}|${pair.ingress}|${pair.egress}|${dropSignature(drops)}`
    // `warn`: the caller was answered without something it sent (06-protocol-translation.md).
    const line = dropLog.shouldWarn(signature) ? log?.warn : log?.debug
    line?.call(log, "translation dropped fields", {
      component: "translate",
      ingress: pair.ingress,
      egress: pair.egress,
      dropped: drops.length,
      fields: drops.slice(0, MAX_REPORTED_DROPS).map((drop) => `${drop.field} ${drop.reason}`),
    })
  }
}
