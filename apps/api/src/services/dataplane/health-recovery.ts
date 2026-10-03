import { HEALTHY } from "../routing"
import type { AccountHealthState } from "./health"
import type { HealthAccountFacts } from "./health-observation"

/** Recovery changes verdicts, never request accounting or provider quota evidence. */
export function recoverHealth(
  state: AccountHealthState,
  kind: "full" | "authentication" | null,
  facts: HealthAccountFacts,
): AccountHealthState {
  if (kind === "full") return { ...state, breaker: HEALTHY, probeHeldUntil: null }
  const authVerdict =
    state.breaker.status === "needs_reauth" ||
    state.breaker.cooldownReason === "credential-rejected"
  if (kind !== "authentication" || !authVerdict || facts.status === "needs_reauth") return state
  return { ...state, breaker: HEALTHY, probeHeldUntil: null }
}
