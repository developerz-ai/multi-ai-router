import { isCredentialRejected, needsOperator } from "../../lib/account-status"
import type { AccountView, PoolView, ProviderDescriptor } from "../../lib/api/types"
import { credentialOf, listNames } from "../../lib/subscription-login"

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
  if (account.hasCredential && needsLogin(account, provider)) return "login lost"
  if (account.hasCredential) return "stored"
  if (provider?.authKind === "none") return "not needed"
  return (provider?.connectFlow ?? null) === null ? "missing" : "not connected"
}

export function credentialHint(
  account: AccountView,
  provider: ProviderDescriptor | undefined,
): string {
  if (account.hasCredential && needsLogin(account, provider)) {
    return "The stored login no longer renews, so this account serves nothing until Reconnect."
  }
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
  if (account.hasCredential) return needsLogin(account, provider) ? "warn" : "ok"
  return provider?.authKind === "none" ? "neutral" : "warn"
}

/** Parked until a person signs in, on a provider that has a sign-in to offer. */
export function needsLogin(
  account: AccountView,
  provider: ProviderDescriptor | undefined,
): boolean {
  return account.status === "needs_reauth" && (provider?.connectFlow ?? null) !== null
}

/**
 * What the operator does next, for a state no clock fixes. Shown in the status cell because the
 * row's own buttons sit a dozen columns to the right, and a hover title reaches no keyboard user.
 * Re-check is what clears `exhausted`; nothing clears it on a timer.
 */
export function statusNextAction(
  account: AccountView,
  provider: ProviderDescriptor | undefined,
): string | null {
  if (isCredentialRejected(account)) return "key rejected — rotate it in Edit"
  if (account.status === "exhausted") return "top up, then Re-check"
  if (account.status !== "needs_reauth" || provider === undefined) return null
  return needsLogin(account, provider) ? "press Reconnect" : "rotate the key in Edit"
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

/**
 * What a disable breaks, pool by pool. Reversible, but it takes effect on live traffic: the line
 * that matters is the pool it leaves with nothing to serve it.
 */
export function disableConsequences(
  account: AccountView,
  pools: readonly Pick<PoolView, "name" | "members">[],
): readonly string[] {
  const joined = pools.filter((pool) =>
    pool.members.some((member) => member.accountId === account.id),
  )
  const stranded = joined.filter((pool) =>
    pool.members.every((member) => member.accountId === account.id || member.status === "disabled"),
  )
  const covered = joined.filter((pool) => !stranded.includes(pool))
  const names = (list: readonly { readonly name: string }[]) =>
    listNames(list.map((pool) => pool.name))

  return [
    `"${account.label}" stops taking new requests at once, from every key that can reach it.`,
    ...(stranded.length > 0
      ? [
          `Nothing else serves ${names(stranded)}: a key scoped only there is refused until this is enabled again.`,
        ]
      : []),
    ...(covered.length > 0 ? [`${names(covered)} keep serving from their other members.`] : []),
    "Enable brings it back with its id, pool memberships and usage history intact.",
  ]
}
