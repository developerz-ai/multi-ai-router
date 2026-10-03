import type { AccountRecoveryView, RecheckResult } from "../../lib/api/accounts"
export interface RecoveryPresentation {
  readonly requestedAt: string | null
  readonly recovery?: AccountRecoveryView
}
/** Select one generation source for both timestamp and state. Never order opaque UUIDs. */
export function recoveryPresentation(
  server: RecoveryPresentation,
  local: RecheckResult | null,
): RecoveryPresentation {
  if (local === null || local.recovery === undefined || local.lastCheckedAt === null) return server
  const pressed = { requestedAt: local.lastCheckedAt, recovery: local.recovery }
  if (server.recovery === undefined || server.requestedAt === null) return pressed
  if (server.recovery.generation !== local.recovery.generation) {
    return Date.parse(server.requestedAt) > Date.parse(local.lastCheckedAt) ? server : pressed
  }
  // Within one generation a terminal result supersedes pending/issued; newer outcome time wins.
  const rank = (state: AccountRecoveryView["state"]) =>
    state === "pending" ? 0 : state === "issued" ? 1 : 2
  if (rank(server.recovery.state) < rank(local.recovery.state)) return pressed
  if (
    rank(server.recovery.state) === 2 &&
    local.recovery.outcomeAt !== null &&
    (server.recovery.outcomeAt === null ||
      Date.parse(server.recovery.outcomeAt) < Date.parse(local.recovery.outcomeAt))
  )
    return pressed
  return server
}
