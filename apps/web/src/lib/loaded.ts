/**
 * What a query last answered, or `undefined` before its first answer.
 *
 * Not `isSuccess`: a refetch that fails flips the status to `error` while keeping the data, so a
 * screen gated on success went blank, and dropped its banners and dialogs, on one failed poll.
 */
export function loadedData<T>(query: {
  readonly isPending: boolean
  readonly data: T | undefined
}): T | undefined {
  return query.isPending ? undefined : query.data
}
