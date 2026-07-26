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
//
// `configDir` is on neither body. A Claude subscription's `CLAUDE_CONFIG_DIR` is
// named by the router after the account id and provisioned on create; both
// bodies are strict, so sending one is a 400 rather than a value ignored.

export interface AccountListFilter {
  readonly status?: AccountStatus
  readonly provider?: ProviderId
}

export interface CreateAccountInput {
  readonly label: string
  readonly provider: ProviderId
  readonly credential?: string
  readonly baseUrl?: string
  readonly dialect?: Dialect
  readonly modelAliases?: Readonly<Record<string, string>>
  readonly supportedModels?: readonly string[]
  readonly weight?: number
  readonly priority?: number
}

/** Only `active` and `disabled` are operator-settable — the rest are observations. */
export type OperatorStatus = "active" | "disabled"

export interface UpdateAccountInput {
  readonly label?: string
  readonly credential?: string
  readonly baseUrl?: string | null
  readonly dialect?: Dialect | null
  readonly modelAliases?: Readonly<Record<string, string>> | null
  /** `null` (or `[]`) drops the declaration, returning the account to "accepts any model". */
  readonly supportedModels?: readonly string[] | null
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

/**
 * What "Test now" answers — a different question than a re-check, and a different shape.
 *
 * `tested: false` is the same kind of success `rechecked: false` is: the server-side cooldown
 * declined the press. When `tested` is true, `outcome` is the one real completion's verdict —
 * never invented, never a guess about whether the account "should" work.
 */
export interface TestNowResult {
  readonly accountId: string
  readonly lastCheckedAt: string
  readonly nextAllowedAt: string
  readonly tested: boolean
  readonly outcome?: "ok" | "failed"
  /** Safe to render as-is — the server never sends raw upstream or credential text here. */
  readonly message?: string
  readonly latencyMs?: number
}

export interface TestAccountInput {
  readonly id: string
  /** The router has no model catalog for an upstream, so the operator names one, as a client would. */
  readonly model: string
  /**
   * Required for a Claude subscription account — it spawns a real `claude` subprocess and bills a
   * turn — and ignored everywhere else. See `AccountTestNow.tsx`.
   */
  readonly confirmed?: boolean
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

/**
 * What "Discover models" answers. `saved: false` is a success, the same way `tested: false` is:
 * the upstream listed nothing, so nothing was written and the account still accepts any model
 * name. A listing that could not be read is a failure and arrives as an error instead.
 */
export interface DiscoverModelsResult {
  readonly accountId: string
  readonly models: readonly string[]
  readonly saved: boolean
  /** Safe to render as-is — the server never sends raw upstream or credential text here. */
  readonly message: string
  readonly latencyMs: number
}

/** One GET at the provider's own listing. Costs no tokens, so it needs no confirmation. */
export function discoverAccountModels(id: string): Promise<DiscoverModelsResult> {
  return request<DiscoverModelsResult>({
    method: "POST",
    path: `/accounts/${id}/models/discover`,
  })
}

export function testAccount(input: TestAccountInput): Promise<TestNowResult> {
  return request<TestNowResult>({
    method: "POST",
    path: `/accounts/${input.id}/test`,
    body: { model: input.model, confirmed: input.confirmed },
  })
}
