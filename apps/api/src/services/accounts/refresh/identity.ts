import type { AccountRow } from "@multi-ai-router/db"
import { httpDriver } from "../../../providers"

export interface RefreshExpectation {
  readonly authMaterial: string | null
  readonly expiresAtMs: number | null
}
export interface RefreshTimerState extends RefreshExpectation {
  dueAtMs: number
  lifecycleVersion?: number
  attempts: number
  pausedLifecycleVersion?: number
}
export function expectation(row: AccountRow): RefreshExpectation {
  return { authMaterial: row.authMaterial, expiresAtMs: row.tokenExpiresAt?.getTime() ?? null }
}
export function sameExpectation(a: RefreshExpectation, b: RefreshExpectation): boolean {
  return a.authMaterial === b.authMaterial && a.expiresAtMs === b.expiresAtMs
}
export function matches(expected: RefreshExpectation, row: AccountRow): boolean {
  return sameExpectation(expected, expectation(row))
}
export function eligible(row: AccountRow): boolean {
  return (
    httpDriver(row.provider)?.oauth !== undefined &&
    row.authMaterial !== null &&
    row.status !== "disabled" &&
    row.status !== "needs_reauth"
  )
}

export interface RefreshFlightObservation {
  row?: AccountRow
  exchangeStarted: boolean
  exchangeFinished?: boolean
}
/** Only pre-exchange faults retry the old grant; ambiguous writeback pauses that identity. */
export function timingAfterException(
  timing: RefreshTimerState | undefined,
  expected: RefreshExpectation | undefined,
  observation: RefreshFlightObservation,
  now: number,
  minDelayMs: number,
): "retry" | "paused" | "unchanged" {
  if (timing === undefined || expected === undefined || !sameExpectation(timing, expected))
    return "unchanged"
  if (observation.exchangeStarted && observation.row !== undefined) {
    timing.pausedLifecycleVersion = observation.row.lifecycleVersion
    return "paused"
  }
  timing.dueAtMs = now + minDelayMs
  return "retry"
}
