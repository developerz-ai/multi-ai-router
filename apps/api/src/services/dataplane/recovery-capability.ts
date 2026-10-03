import type { AccountObservation } from "@multi-ai-router/db"

/** Installed off-path; final provider admission consumes synchronously. */
export interface RecoveryCapability {
  readonly revision: number
  readonly accountId: string
  readonly generation: string
  readonly permitId: string
  readonly ownerBootId: string
  readonly ownershipEpoch: number
  readonly expected: AccountObservation
  readonly quotaRevisions: Readonly<Record<string, number>>
}
export interface CurrentRecoveryFacts extends AccountObservation {
  readonly generation: string
  readonly recoveryRevision: number
}
interface Held {
  readonly capability: RecoveryCapability
  consumed: boolean
}
export function createRecoveryCapabilities(
  bootId: string,
  readCurrent: (accountId: string) => CurrentRecoveryFacts | undefined,
) {
  const held = new Map<string, Held>()
  const matches = (capability: RecoveryCapability): boolean => {
    const current = readCurrent(capability.accountId)
    return (
      current !== undefined &&
      (current.status === "active" || current.status === "cooling_down") &&
      current.generation === capability.generation &&
      current.recoveryRevision === capability.revision &&
      current.lifecycleVersion === capability.expected.lifecycleVersion &&
      current.authMaterial === capability.expected.authMaterial
    )
  }
  return {
    install(capability: RecoveryCapability): boolean {
      if (capability.ownerBootId !== bootId || !matches(capability)) return false
      const current = held.get(capability.accountId)
      if (current !== undefined && capability.revision < current.capability.revision) return false
      if (
        current?.capability.generation === capability.generation &&
        current.capability.permitId === capability.permitId
      )
        return !current.consumed
      if (current !== undefined && capability.revision === current.capability.revision) return false
      held.set(capability.accountId, {
        capability: {
          ...capability,
          expected: { ...capability.expected },
          quotaRevisions: { ...capability.quotaRevisions },
        },
        consumed: false,
      })
      return true
    },
    available(accountId: string): RecoveryCapability | undefined {
      const current = held.get(accountId)
      return current !== undefined && !current.consumed && matches(current.capability)
        ? current.capability
        : undefined
    },
    consume(accountId: string, generation: string): RecoveryCapability | undefined {
      const current = held.get(accountId)
      if (
        current === undefined ||
        current.consumed ||
        current.capability.generation !== generation ||
        !matches(current.capability)
      )
        return undefined
      current.consumed = true
      return current.capability
    },
    invalidate(accountId: string): void {
      const current = held.get(accountId)
      if (current !== undefined) current.consumed = true
    },
    completed(accountId: string, generation: string, permitId: string): void {
      const current = held.get(accountId)
      if (current?.capability.generation === generation && current.capability.permitId === permitId)
        current.consumed = true
    },
    /** Caller has installed catalog absence; late hydration fails readCurrent. */
    forget(accountId: string): void {
      held.delete(accountId)
    },
  }
}
