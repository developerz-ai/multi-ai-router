import { isRouterError, type ReconnectAccount, type Wall, wallOfError } from "@multi-ai-router/core"
import { redactValue } from "../logging/redact"
import { opaqueAccountRef } from "./account-ref"

/**
 * "Account X needs reconnecting" as the client reads it: the sentence a router-authored error ends
 * with and `error.router.reconnect`. Pure — the console URL is the operator's `PUBLIC_URL`, passed
 * in. A client agent relays the sentence to its human, so it names the account by its operator
 * label (the same label every pool sentence already prints) and says where to fix it.
 * docs/idea/06-protocol-translation.md#reconnect-needed.
 */

/** One entry of `error.router.reconnect`. */
export interface RouterReconnectEntry {
  /** Opaque, as in `error.router.accounts` — the stable reference. */
  readonly account: string
  /** The operator's label, as the sentence prints it. */
  readonly label: string
  readonly provider: string | null
  /** The console page the account is reconnected from; `null` when `PUBLIC_URL` is unset. */
  readonly url: string | null
}

/**
 * The walls a reconnect is worth naming beside: the pool could not serve (or a person must act).
 * A refusal of the request itself, or of its scope, is not fixed by reconnecting anything.
 */
const SERVING_WALLS: readonly Wall[] = ["clock", "capacity", "human"]

/**
 * The accounts to name: the throw site's own list (a pool verdict, `routing/no-candidates.ts`), else
 * what selection saw for this request (`RequestFacts.reconnect`) when the failure is one a
 * reconnected account could have served.
 */
export function reconnectOf(
  error: unknown,
  requestReconnect: readonly ReconnectAccount[] | undefined,
): readonly ReconnectAccount[] {
  if (!isRouterError(error)) return []
  const own = error.detail.reconnect
  if (own !== undefined) return own
  if (!SERVING_WALLS.includes(wallOfError(error))) return []
  return requestReconnect ?? []
}

/** The console's Accounts page under `PUBLIC_URL`, or `null` when the router has no address. */
export function consoleAccountsUrl(publicUrl: string | null): string | null {
  if (publicUrl === null) return null
  return `${publicUrl.replace(/\/+$/, "")}/accounts`
}

/**
 * The closing sentence, or `""` when nothing needs reconnecting. Written for a person: a client
 * agent quotes it, and Claude Code prints `error.message` after `API Error:`.
 */
export function reconnectSentence(
  accounts: readonly ReconnectAccount[],
  consoleUrl: string | null,
): string {
  if (accounts.length === 0) return ""
  const one = accounts.length === 1
  const named = accounts
    .map((entry) =>
      entry.provider === undefined ? entry.label : `${entry.label} (${entry.provider})`,
    )
    .join(", ")
  const where = consoleUrl === null ? "in the router console (Accounts page)" : `at ${consoleUrl}`
  return `. Reconnect needed: ${one ? "account" : "accounts"} ${named} lost ${one ? "its" : "their"} login — a router admin must reconnect ${one ? "it" : "them"} ${where}`
}

export function reconnectEntries(
  accounts: readonly ReconnectAccount[],
  consoleUrl: string | null,
): RouterReconnectEntry[] {
  return accounts.map((entry) => ({
    account: opaqueAccountRef(entry.accountId),
    // Operator-typed text, scrubbed like every sentence it also appears in (`render.ts`).
    label: redactValue(entry.label),
    provider: entry.provider ?? null,
    url: consoleUrl,
  }))
}
