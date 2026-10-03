/** Public progress, never an upstream admission capability or replica identity. */
export interface AccountRecoveryView {
  readonly generation: string
  readonly state: "pending" | "issued" | "succeeded" | "failed" | "uncertain" | "cancelled"
  readonly nextAllowedAt: string
  readonly outcomeAt: string | null
}

/** Structural projection keeps private repository fields out of the DTO mapping. */
export interface RecoveryPresentationFacts {
  readonly generation: string
  readonly state: AccountRecoveryView["state"]
  readonly nextAllowedAt: Date
  readonly outcomeAt: Date | null
}

export function toRecoveryView(recovery: RecoveryPresentationFacts): AccountRecoveryView {
  return {
    generation: recovery.generation,
    state: recovery.state,
    nextAllowedAt: recovery.nextAllowedAt.toISOString(),
    outcomeAt: recovery.outcomeAt?.toISOString() ?? null,
  }
}
