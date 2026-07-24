import type { AccountStatus, Dialect, ProviderId } from "@multi-ai-router/core"
import { request } from "./client"
import type { AccountView, DeletedView } from "./types"

// `/api/admin/accounts`. Request shapes mirror `services/accounts/schemas.ts`.
//
// Two asymmetries worth stating, because they are contract and not oversight:
//
// - `credential` goes **up** and never comes back. There is no field on
//   `AccountView` that could carry it, masked or otherwise.
// - On the update body, `null` means *clear this* and an absent key means
//   *leave it alone*. `credential` is the exception — it may be rotated but
//   never cleared, so it is `string | undefined` and never nullable.

export interface AccountListFilter {
  readonly status?: AccountStatus
  readonly provider?: ProviderId
}

export interface CreateAccountInput {
  readonly label: string
  readonly provider: ProviderId
  readonly credential?: string
  readonly configDir?: string
  readonly baseUrl?: string
  readonly dialect?: Dialect
  readonly modelAliases?: Readonly<Record<string, string>>
  readonly weight?: number
  readonly priority?: number
}

/** Only `active` and `disabled` are operator-settable — the rest are observations. */
export type OperatorStatus = "active" | "disabled"

export interface UpdateAccountInput {
  readonly label?: string
  readonly credential?: string
  readonly configDir?: string | null
  readonly baseUrl?: string | null
  readonly dialect?: Dialect | null
  readonly modelAliases?: Readonly<Record<string, string>> | null
  readonly weight?: number
  readonly priority?: number
  readonly status?: OperatorStatus
}

/**
 * What a re-check answers. **`rechecked: false` is a success**: the server-side
 * cooldown declined the press, and the honest rendering is "checked then, next
 * check available at". Treating it as a failure would put a red state on a
 * button pressed twice.
 *
 * A re-check clears the breaker marks so the account is eligible again as a
 * half-open probe. It runs no synthetic request, so it reports no verdict — the
 * next real request is what tests the account.
 */
export interface RecheckResult {
  readonly accountId: string
  readonly lastCheckedAt: string
  /** `lastCheckedAt` + the server's cooldown. Until then, a press is declined. */
  readonly nextAllowedAt: string
  readonly rechecked: boolean
}

export function listAccounts(filter: AccountListFilter): Promise<readonly AccountView[]> {
  return request<readonly AccountView[]>({
    method: "GET",
    path: "/accounts",
    query: { status: filter.status, provider: filter.provider },
  })
}

export function getAccount(id: string): Promise<AccountView> {
  return request<AccountView>({ method: "GET", path: `/accounts/${id}` })
}

export function createAccount(input: CreateAccountInput): Promise<AccountView> {
  return request<AccountView>({ method: "POST", path: "/accounts", body: input })
}

export function updateAccount(args: {
  readonly id: string
  readonly patch: UpdateAccountInput
}): Promise<AccountView> {
  return request<AccountView>({ method: "PATCH", path: `/accounts/${args.id}`, body: args.patch })
}

/** The non-destructive door: keeps the id, the pool membership and the usage history. */
export function disableAccount(id: string): Promise<AccountView> {
  return request<AccountView>({ method: "POST", path: `/accounts/${id}/disable` })
}

/** 409s naming every key whose scope would be narrowed. That sentence is the point. */
export function deleteAccount(id: string): Promise<DeletedView> {
  return request<DeletedView>({ method: "DELETE", path: `/accounts/${id}` })
}

export function recheckAccount(id: string): Promise<RecheckResult> {
  return request<RecheckResult>({ method: "POST", path: `/accounts/${id}/recheck` })
}

export function recheckAllAccounts(): Promise<readonly RecheckResult[]> {
  return request<readonly RecheckResult[]>({ method: "POST", path: "/accounts/recheck" })
}
