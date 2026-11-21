import { HEALTHY } from "../routing"
import type { AccountHealthState } from "./health"
import type { HealthAccountFacts } from "./health-observation"

/** Recovery changes verdicts, never request accounting or provider quota evidence. */
export function recoverHealth(
  state: AccountHealthState,
  kind: "full" | "authentication" | null,
  facts: HealthAccountFacts,
): AccountHealthState {
  if (
    facts.status === "disabled" ||
    facts.status === "exhausted" ||
    facts.status === "needs_reauth"
  ) {
    return {
      ...state,
      breaker: {
        status: facts.status,
        cooldownSource: "unknown",
        consecutiveFailures: state.breaker.consecutiveFailures,
      },
      probeHeldUntil: null,
    }
  }
  if (kind === "full") return { ...state, breaker: HEALTHY, probeHeldUntil: null }
  const authVerdict =
    state.breaker.status === "needs_reauth" ||
    state.breaker.cooldownReason === "credential-rejected"
  if (kind !== "authentication" || !authVerdict) return state
  return { ...state, breaker: HEALTHY, probeHeldUntil: null }
}
