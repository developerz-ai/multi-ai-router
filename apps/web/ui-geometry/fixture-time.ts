// Time and label constants shared by the fixture modules. Split from `fixture.ts` so neither file
// outgrows the 300-line cap.

/** Days-to-ms, for the timestamps below. */
export const DAY = 86_400_000
/** 118 characters exactly — the reported worst-case label. */
const LONG_LABEL_BASE =
  "platform-relay-eu-west-primary-long-haul-account-with-an-operator-chosen-descriptive-name-"
export const LONG_LABEL = (LONG_LABEL_BASE + "0".repeat(118)).slice(0, 118)
if (LONG_LABEL.length !== 118) {
  // The length is a fixture requirement, not an accident — #223 names 118 chars.
  throw new Error(`fixture label must be 118 chars, got ${LONG_LABEL.length}`)
}

/** The instant the browser clock is pinned to — relative dates render from it. */
export const NOW = Date.parse("2026-10-14T12:00:00Z")
export const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString()

/** Seven daily buckets ending "now", oldest first — the shape `axis` promises. */
export const AXIS = Array.from({ length: 7 }, (_, i) => iso((i - 6) * DAY))
