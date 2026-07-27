/**
 * `<input type="datetime-local">` ↔ ISO-8601, in both directions.
 *
 * The control speaks **local wall time with no zone**; the admin API speaks
 * ISO-8601 with an offset (`services/keys/schemas.ts`). Handing one to the other
 * unconverted is not a formatting slip — it moves the instant by the operator's
 * UTC offset, so a key set to expire at 18:00 in Berlin expires at 20:00, and
 * every round-trip through the form drifts it again.
 *
 * Both directions live here together because they are one rule read twice: a
 * value that leaves through `fromDateTimeInput` and comes back through
 * `toDateTimeInput` must name the same minute it did before.
 */

/** ISO-8601 → what the control displays. `null` — never expires — is an empty box. */
export function toDateTimeInput(iso: string | null): string {
  if (iso === null) return ""
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ""
  const pad = (value: number) => String(value).padStart(2, "0")
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  return `${date}T${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * What the control holds → ISO-8601 with an offset. An empty box means "never
 * expires", which the update body spells `null`.
 *
 * A value the platform cannot read reads as empty as well. The control refuses
 * to hold one — it is a date picker, not a text box — so this is the shape of a
 * value that never arrives rather than a silent coercion of a real one.
 */
export function fromDateTimeInput(value: string): string | null {
  if (value.trim().length === 0) return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}
