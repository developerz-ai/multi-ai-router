export function replace<T extends { id: string; updatedAt: Date }>(
  rows: T[],
  id: string,
  patch: object,
  now: Date,
): T | undefined {
  const index = rows.findIndex((row) => row.id === id)
  if (index === -1) return undefined
  const current = rows[index]
  if (current === undefined) return undefined
  const next = { ...current, ...defined(patch), updatedAt: now } as T
  rows[index] = next
  return next
}

/** Mirrors the repositories: an absent key changes nothing, `null` clears. */
function defined(patch: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
}

export function remove<T extends { id: string }>(rows: T[], id: string): boolean {
  const index = rows.findIndex((row) => row.id === id)
  if (index === -1) return false
  rows.splice(index, 1)
  return true
}

export function drop<T>(rows: T[], match: (row: T) => boolean): void {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row !== undefined && match(row)) rows.splice(index, 1)
  }
}
