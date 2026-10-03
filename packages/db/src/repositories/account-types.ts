import type {
  AccountBilling,
  AccountStatus,
  Dialect,
  ProviderId,
  QuotaWindowState,
  WindowTokenLimits,
} from "@multi-ai-router/core"
import type { AccountRow, ModelAliasMap, SupportedModelList } from "../schema/accounts"
import type { QuotaWindowRow } from "../schema/quota-windows"
import type { AddedAccountRepositoryMethods } from "./account-lifecycle-types"
import type { BackgroundAccountSubject } from "./background-account-eligibility"

export interface AccountRepository extends AddedAccountRepositoryMethods {
  /** Durable identity/state check at a background upstream admission boundary. */
  readEligibleBackgroundAccount(
    id: string,
    expected: BackgroundAccountSubject,
  ): Promise<AccountRow | undefined>
  /** `input.authMaterial` must already be an encryption envelope, never a raw credential. */
  create(input: CreateAccountInput): Promise<AccountRow>
  /** Oldest first, so the admin list is stable across calls. */
  list(filter?: AccountListFilter): Promise<AccountRow[]>
  findById(id: string): Promise<AccountRow | undefined>
  /** Existence check for a set of ids, in one query. Order is not guaranteed. */
  findByIds(ids: readonly string[]): Promise<AccountRow[]>
  /**
   * Every account id, and nothing else. Deliberately not `list().map(row => row.id)`: the caller
   * is the config-directory reaper, which needs the whole table's identity to decide what on the
   * volume is orphaned, and hauling every `authMaterial` envelope through a filesystem sweep to
   * answer "does this id exist" is credential material read for no reason.
   */
  listIds(): Promise<string[]>
  /**
   * Field-wise edit. `input.authMaterial`, when present, must already be an
   * encryption envelope — rotating a credential is an update like any other and
   * the plaintext never reaches this layer. `undefined` when no account has that id.
   */
  update(id: string, patch: UpdateAccountInput, now: Date): Promise<AccountRow | undefined>
  /**
   * The hard delete, for an account the operator is done with. Prefer
   * {@link AccountRepository.disable}: usage history survives either way
   * (`usage_records.account_id` is `ON DELETE SET NULL`) but a disabled account
   * keeps its id, its pool membership, and its joinable history.
   */
  delete(id: string): Promise<boolean>
  /** `undefined` when no account has that id. */
  updateStatus(id: string, status: AccountStatus, now: Date): Promise<AccountRow | undefined>
  /**
   * Conditional status write: applies `to` only where the row currently holds
   * one of `from`.
   *
   * The router's own verdicts about an upstream — `exhausted`, `needs_reauth` —
   * are written to the same column an operator sets by hand, so an
   * unconditional write from a background observer would overwrite `disabled`,
   * which is the operator's word and never an observation. The guard is in the
   * statement rather than in a read-then-write because several replicas observe
   * the same account concurrently and a check in TypeScript would be a race.
   *
   * `undefined` means nothing changed: no account has that id, the row holds a
   * status outside `from`, or `from` is empty.
   */
  updateStatusWhen(
    id: string,
    from: readonly AccountStatus[],
    to: AccountStatus,
    now: Date,
  ): Promise<AccountRow | undefined>
  /**
   * The soft delete. Rows are never removed: usage history, audit events, and
   * pool membership all reference the account, and a disabled account that is
   * re-enabled keeps its id. Disabled accounts never survive candidate
   * filtering.
   */
  disable(id: string, now: Date): Promise<AccountRow | undefined>
  /**
   * Stamps `last_used_at` for a set of accounts in one statement.
   *
   * Called from the usage recorder's **batched background drain**, never from a request
   * (non-negotiable 8) — one write per flush covering every account that appeared in it, rather
   * than one per request. Ids repeated within a batch collapse to a single row update.
   *
   * `GREATEST` rather than a plain assignment: two replicas flush concurrently and their batches
   * are not ordered relative to each other, so an older flush landing second must not move the
   * stamp backwards and make a busy account look idle.
   */
  markUsed(ids: readonly string[], at: Date): Promise<void>
  /**
   * Accounts that have served nothing since `before`, oldest (and never-used) first.
   *
   * `NULL` counts as idle: an account connected and never used is exactly the one whose
   * credential expires without anyone noticing. Ordering puts the most neglected first, so a
   * bounded batch always makes progress on the worst case rather than revisiting the same head.
   *
   * Only active accounts without an open recovery generation (`pending`, `issued`, or `uncertain`)
   * are selected. Disabled, exhausted and needs_reauth accounts are excluded; an open recovery
   * generation owns its account's next turn instead of background maintenance.
   */
  findIdle(input: { readonly before: Date; readonly limit: number }): Promise<AccountRow[]>
  /**
   * Writes one window's state, replacing whatever was there. Windows reset
   * independently, so this is per window and never a whole-account overwrite.
   * An absent `utilization` is written as NULL on purpose — a source that has
   * stopped reporting must not leave yesterday's number on display.
   */
  upsertQuotaWindow(accountId: string, state: QuotaWindowState): Promise<QuotaWindowRow>
  /**
   * Every persisted window for a set of accounts, in one query, ordered by
   * account then window so grouping is stable across calls.
   *
   * The read side of {@link AccountRepository.upsertQuotaWindow}: the routing
   * catalog hydrates its in-memory snapshot from these at load and refresh, so
   * this is never on the request path.
   *
   * An account with no rows is not an account with a full quota — routing reads
   * an absent window as *unknown* and a present one as measured, which is why
   * this returns the rows it has and never synthesizes the rest.
   */
  listQuotaWindows(accountIds: readonly string[]): Promise<QuotaWindowRow[]>
  clearObservedQuotaWindow(input: {
    accountId: string
    window: QuotaWindowState["window"]
    expected: { revision: number; resetsAt: Date }
    now: Date
  }): Promise<QuotaWindowRow | undefined>
}

export interface CreateAccountInput {
  /**
   * Minted by the caller when something outside this table has to be named after the row before it
   * exists — a Claude subscription's `CLAUDE_CONFIG_DIR` is `<root>/<id>`, so the id has to be
   * known before the insert. Omitted everywhere else; the column defaults to a fresh uuid.
   */
  readonly id?: string
  /** Human-chosen, required: the disambiguator between same-provider accounts. */
  readonly label: string
  readonly provider: ProviderId
  /** AES-256-GCM envelope. Null for Claude subscription accounts. */
  readonly authMaterial?: string | null
  /** Claude subscription accounts only: the isolated `CLAUDE_CONFIG_DIR`. */
  readonly configDir?: string | null
  /** Refreshable OAuth accounts only. Null for API-key and Claude subscription accounts. */
  readonly tokenExpiresAt?: Date | null
  /**
   * Operator override of the provider's pinned endpoint. Required for the
   * `*-compatible` providers, which have no default (see `providers/base-url.ts`).
   */
  readonly baseUrl?: string | null
  /** Which surface this account uses, where the provider exposes more than one. */
  readonly dialect?: Dialect | null
  readonly modelAliases?: ModelAliasMap | null
  /** Upstream-side model ids. Null or empty means unknown, which routing reads as passthrough. */
  readonly supportedModels?: SupportedModelList | null
  readonly windowTokenLimits?: WindowTokenLimits | null
  readonly weight?: number
  readonly priority?: number
  /**
   * Per-token bill or flat fee. Absent takes the column default (`metered`);
   * the service supplies the provider's own default and forces it for the
   * providers sold only as a subscription.
   */
  readonly billing?: AccountBilling
  /** Defaults to `active` in the schema; set explicitly for a pending OAuth row. */
  readonly status?: AccountStatus
}

/**
 * Every field is optional and `undefined` means "leave it alone". `null` is a
 * deliberate clear, which is why the nullable fields accept it explicitly —
 * dropping a base URL override is a real edit, not a missing key.
 */
export interface UpdateAccountInput {
  readonly label?: string
  /** AES-256-GCM envelope. Never plaintext. */
  readonly authMaterial?: string | null
  readonly configDir?: string | null
  readonly tokenExpiresAt?: Date | null
  readonly baseUrl?: string | null
  readonly dialect?: Dialect | null
  readonly modelAliases?: ModelAliasMap | null
  readonly supportedModels?: SupportedModelList | null
  readonly windowTokenLimits?: WindowTokenLimits | null
  readonly weight?: number
  readonly priority?: number
  readonly billing?: AccountBilling
  readonly status?: AccountStatus
}

export interface AccountListFilter {
  /** Absent means every account, disabled ones included — this is the admin list. */
  readonly status?: AccountStatus
  /** Many accounts per provider is the normal case, so this narrows, never identifies. */
  readonly provider?: ProviderId
}
