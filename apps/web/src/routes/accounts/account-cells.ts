import type { AccountView, ProviderDescriptor } from "../../lib/api/types"

// The words the accounts table's credential and connect cells use. Pure — an
// account fact and a provider descriptor in, a word out — and split from the
// table so the JSX file stays about layout while this stays about vocabulary.

/**
 * "Missing", "not connected", and "not needed" are three problems with three different fixes — a
 * paste, a login, and nothing at all. The word decides which button the operator reaches for, and
 * the third one exists so a fully configured local endpoint is never dressed up as a broken account.
 */
export function credentialLabel(
  account: AccountView,
  provider: ProviderDescriptor | undefined,
): string {
  if (account.hasCredential) return "stored"
  if (provider?.authKind === "none") return "not needed"
  return (provider?.connectFlow ?? null) === null ? "missing" : "not connected"
}

export function credentialHint(
  account: AccountView,
  provider: ProviderDescriptor | undefined,
): string {
  if (account.hasCredential) return "A credential is stored, encrypted. No endpoint returns it."
  if (provider?.authKind === "none") {
    return "This upstream authenticates nobody, so none is stored. Add one only if something in front of it checks."
  }
  if ((provider?.connectFlow ?? null) === null) {
    return "No credential stored — this account cannot serve a request."
  }
  return "No authorization yet — run Connect. Nothing is pasted by hand for this provider."
}

/** A local endpoint with nothing stored is configured, not half-finished. Never a warning. */
export function credentialTone(
  account: AccountView,
  provider: ProviderDescriptor | undefined,
): "ok" | "neutral" | "warn" {
  if (account.hasCredential) return "ok"
  return provider?.authKind === "none" ? "neutral" : "warn"
}

/**
 * "Connect" while the router holds no authorization for this account, "Reconnect" after.
 *
 * A Claude subscription always reads "Connect", and that is a stated limitation rather than a
 * default: the router holds no credential for one — the Agent SDK owns it inside the account's
 * `CLAUDE_CONFIG_DIR` and we deliberately never read it — so nothing here can tell a logged-in
 * subscription from a fresh row, and picking the confident word would be a guess.
 *
 * Both words drive the same call against the same row. The id, the config directory, the pool
 * membership and the usage history survive either; only the audit kind differs.
 */
export function connectLabel(account: AccountView): "Connect" | "Reconnect" {
  return account.hasCredential ? "Reconnect" : "Connect"
}
