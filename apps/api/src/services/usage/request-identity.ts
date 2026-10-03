/** Caller labels are trace metadata; each ingress receives an independent join key. */
export interface UsageRequestIdentity {
  readonly correlationId: string
  readonly clientRequestId: string | null
}

export function createRequestIdentity(clientRequestId?: string): UsageRequestIdentity & {
  readonly requestId: string
} {
  const correlationId = crypto.randomUUID()
  return {
    correlationId,
    clientRequestId: clientRequestId ?? null,
    requestId: clientRequestId ?? correlationId,
  }
}
