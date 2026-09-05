import { needsOperator } from "../../lib/account-status"
import type { AccountView, ProviderDescriptor } from "../../lib/api/types"
import { credentialOf } from "../../lib/subscription-login"

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
 * A Claude subscription reads off `credential.present` — the API's reading of whether the CLI's
 * own files exist in the account's `CLAUDE_CONFIG_DIR` (never their contents). A row that was
 * logged in and has since expired still says "Reconnect": the config directory, the pool
 * membership and the usage history are all there to reconnect *to*. An older API that sends no
 * `credential` falls back to `hasCredential`, which for a subscription is always false.
 *
 * Both words drive the same call against the same row; only the audit kind differs.
 */
export function connectLabel(account: AccountView): "Connect" | "Reconnect" {
  const credential = credentialOf(account)
  if (credential !== null) {
    return credential.present || account.status === "needs_reauth" ? "Reconnect" : "Connect"
  }
  return account.hasCredential ? "Reconnect" : "Connect"
}

/**
 * Exactly what a delete breaks, in the operator's terms — never "this cannot be undone". The
 * server adds the decisive one when it refuses: a 409 naming every key whose scope this delete
 * would narrow, which `ConfirmDialog` renders verbatim.
 */
export function deleteConsequences(account: AccountView): readonly string[] {
  return [
    `"${account.label}" is removed from every pool it belongs to.`,
    "Its usage history is kept, but those rows no longer name an account.",
    "Any key scoped to it loses a candidate — the router refuses the delete and names those keys rather than narrowing them silently.",
    needsOperator(account.status)
      ? "This account already needs an operator; disabling it keeps the id and the history."
      : "Disable is the non-destructive door: it keeps the id, the pool membership and the joinable history.",
  ]
}
