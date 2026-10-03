import type { AutomaticRecoveryRequest, RecoveryOutcome } from "./types"

export function createRecoveryQueues(demandCapacity: number, outcomeCapacity: number) {
  const demands = new Map<string, number>()
  const automatic = new Map<string, AutomaticRecoveryRequest & { generationCandidate: string }>()
  const outcomes = new Map<string, RecoveryOutcome>()
  return {
    forget: (id: string): void => {
      demands.delete(id)
      automatic.delete(id)
      for (const [key, value] of outcomes) if (value.accountId === id) outcomes.delete(key)
    },
    demand(id: string, now: number): void {
      demands.delete(id)
      demands.set(id, now)
      while (demands.size > demandCapacity) {
        const oldest = demands.keys().next().value
        if (oldest === undefined) break
        demands.delete(oldest)
      }
    },
    automatic(value: AutomaticRecoveryRequest): boolean {
      const held = automatic.get(value.accountId)
      if (held !== undefined && held.expected.lifecycleVersion > value.expected.lifecycleVersion)
        return false
      if (held === undefined && automatic.size >= demandCapacity) return false
      if (
        held !== undefined &&
        held.expected.lifecycleVersion === value.expected.lifecycleVersion &&
        held.expected.authMaterial === value.expected.authMaterial &&
        held.expectedRecoveryRevision === value.expectedRecoveryRevision &&
        held.expected.status === value.expected.status &&
        held.reason === value.reason
      )
        return true
      automatic.set(value.accountId, {
        ...value,
        expected: { ...value.expected },
        generationCandidate: crypto.randomUUID(),
      })
      return true
    },
    automaticBatch: (limit: number) => [...automatic.values()].slice(0, limit),
    automaticCompleted: (
      value: AutomaticRecoveryRequest & { generationCandidate: string },
    ): void => {
      if (automatic.get(value.accountId) === value) automatic.delete(value.accountId)
    },
    demandIds(now: number, ttl: number): string[] {
      for (const [id, at] of demands) if (now - at > ttl) demands.delete(id)
      return [...demands.keys()]
    },
    demanded(id: string, now: number, ttl: number): boolean {
      const at = demands.get(id)
      if (at === undefined) return false
      if (now - at <= ttl) return true
      demands.delete(id)
      return false
    },
    satisfied: (id: string): void => {
      demands.delete(id)
    },
    outcome(value: RecoveryOutcome): boolean {
      const key = value.permitId
      const held = outcomes.get(key)
      // A late callback must not replace an already captured terminal observation.
      if (held !== undefined)
        return held.generation === value.generation && held.accountId === value.accountId
      if (outcomes.size >= outcomeCapacity) return false
      outcomes.set(key, { ...value, expected: { ...value.expected } })
      return true
    },
    batch: (limit: number): RecoveryOutcome[] => [...outcomes.values()].slice(0, limit),
    completed: (value: RecoveryOutcome): void => {
      if (outcomes.get(value.permitId) === value) outcomes.delete(value.permitId)
    },
  }
}
