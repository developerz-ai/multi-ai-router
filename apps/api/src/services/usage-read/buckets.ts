import { KeyOwnerKind } from "@multi-ai-router/core"
import type { UsageGroupRow, UsageGroupSeriesPoint, UsageKeyAttribution } from "@multi-ai-router/db"
import { breakdownRow } from "./summary-view"
import type { KeyLabel, UsageBreakdownRow, UsageOwnerRow } from "./types"

/**
 * The key-to-label map the owner and tool queries fold on, from the labels already loaded for the
 * request. Parallel arrays, one bind each (`packages/db/.../usage-attribution.ts`).
 */
export function attributionOf(keys: ReadonlyMap<string, KeyLabel>): UsageKeyAttribution {
  const entries = [...keys]
  return {
    ids: entries.map(([id]) => id),
    owners: entries.map(([, key]) => key.owner),
    ownerKinds: entries.map(([, key]) => key.ownerKind),
    tools: entries.map(([, key]) => key.tool),
  }
}

const NOTES = ["unassigned", "deleted", "none"] as const
type BucketNote = (typeof NOTES)[number]

/** A `#`-prefixed group key is a non-owner bucket; its note is the rest. Slugs cannot start with `#`. */
function bucketNote(id: string | null): BucketNote | undefined {
  if (id === null || !id.startsWith("#")) return undefined
  return NOTES.find((note) => note === id.slice(1))
}

/**
 * Wire rows for the owner breakdown. Series are matched on the group key, and only then is a
 * bucket's id nulled for the wire: three null ids would be indistinguishable to the join.
 */
export function ownerRows(
  rows: readonly UsageGroupRow[],
  axis: readonly string[],
  points: readonly UsageGroupSeriesPoint[],
): UsageOwnerRow[] {
  return rows.map((row) => {
    const base = breakdownRow(row, axis, points)
    const note = bucketNote(row.id)
    if (note !== undefined) return { ...base, id: null, label: null, note, ownerKind: null }
    const id = row.id ?? ""
    const slash = id.indexOf("/")
    // `unknown` is the group segment for an owner with no kind; it is outside the enum on purpose.
    const kind = KeyOwnerKind.safeParse(id.slice(0, slash))
    return {
      ...base,
      label: id.slice(slash + 1),
      note: null,
      ownerKind: kind.success ? kind.data : null,
    }
  })
}

export function toolRows(
  rows: readonly UsageGroupRow[],
  axis: readonly string[],
  points: readonly UsageGroupSeriesPoint[],
): UsageBreakdownRow[] {
  return rows.map((row) => {
    const base = breakdownRow(row, axis, points)
    const note = bucketNote(row.id)
    if (note !== undefined) return { ...base, id: null, label: null, note }
    return { ...base, label: row.id, note: null }
  })
}
