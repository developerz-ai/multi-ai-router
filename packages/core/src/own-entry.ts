/** Read a dictionary entry without accepting values from its prototype chain. */
export function ownEntry<T>(
  record: Readonly<Record<string, T>> | null | undefined,
  key: string,
): T | undefined {
  if (record === null || record === undefined || !Object.hasOwn(record, key)) return undefined
  return record[key]
}
