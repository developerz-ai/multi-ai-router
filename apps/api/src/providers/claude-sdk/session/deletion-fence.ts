/** Active leases retain revocation, never permanent account tombstones. */
export function createSessionDeletionFence(historyLimit: number) {
  const accounts = new Map<string, Set<{ valid: boolean }>>()
  const reads = new Set<number>()
  const deleted = new Map<string, number>()
  let sequence = 0
  let floor = -1
  const prune = () => {
    let oldest = sequence
    for (const ticket of reads) oldest = Math.min(oldest, ticket)
    for (const [id, at] of deleted) if (at <= oldest) deleted.delete(id)
  }
  return {
    hold(accountId: string | null) {
      const state = { valid: true }
      let group = accountId === null ? undefined : accounts.get(accountId)
      if (accountId !== null && group === undefined) {
        group = new Set()
        accounts.set(accountId, group)
      }
      group?.add(state)
      return {
        valid: () => state.valid,
        release: () => {
          group?.delete(state)
          if (accountId !== null && group?.size === 0 && accounts.get(accountId) === group)
            accounts.delete(accountId)
        },
      }
    },
    read() {
      // Unique tickets also distinguish simultaneous reads at the same deletion epoch.
      const ticket = ++sequence
      reads.add(ticket)
      return {
        valid: (accountId: string | null) =>
          ticket >= floor && (accountId === null || (deleted.get(accountId) ?? -1) <= ticket),
        release: () => {
          reads.delete(ticket)
          prune()
        },
      }
    },
    invalidate(accountId: string) {
      for (const lease of accounts.get(accountId) ?? []) lease.valid = false
      accounts.delete(accountId)
      if (reads.size === 0) return
      deleted.delete(accountId)
      deleted.set(accountId, ++sequence)
      prune()
      // Only under history pressure do older unknown-account reads fail closed.
      while (deleted.size > historyLimit) {
        const first = deleted.entries().next().value
        if (first === undefined) break
        floor = Math.max(floor, first[1])
        deleted.delete(first[0])
      }
    },
    get retainedAccounts() {
      return accounts.size
    },
    get retainedDeletions() {
      return deleted.size
    },
  }
}
