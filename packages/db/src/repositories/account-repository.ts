import type {
  AccountBilling,
  AccountStatus,
  Dialect,
  ProviderId,
  QuotaWindowState,
  WindowTokenLimits,
} from "@multi-ai-router/core"
import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm"
import type { Database } from "../client"
import {
  type AccountRow,
  accounts,
  type ModelAliasMap,
  type SupportedModelList,
} from "../schema/accounts"
import { type QuotaWindowRow, quotaWindows } from "../schema/quota-windows"

/**
 * Repositories own SQL. Services call these methods and never write a query
 * inline — this file is the only place that knows `accounts` and
 * `quota_windows` are tables.
 *
 * **Ciphertext in, ciphertext out.** `authMaterial` crosses this boundary as the
 * AES-256-GCM envelope and nothing else: encryption happens in the service layer
 * before `create`, decryption happens in the service layer after a read, and no
 * method here returns — or is allowed to return — plaintext credential material
 * (docs/reusable-code.md: encryption is explicitly *not* a `packages/db`
 * concern). A Claude subscription account has no `authMaterial` at all; its
 * credentials live in `configDir`, owned by the Agent SDK.
 *
 * Many accounts per provider is the normal case, so nothing here keys on
 * `provider` alone.
 */
export interface AccountRepository {
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
   * `disabled` is excluded — it is the operator's own switch, and probing it would spend money to
   * learn something about an account they have deliberately turned off. Every other status is
   * included on purpose: an `exhausted` or `cooling_down` account still holds a credential that
   * can expire while it waits.
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

export function createAccountRepository(db: Database): AccountRepository {
  const setStatus = async (
    id: string,
    status: AccountStatus,
    now: Date,
  ): Promise<AccountRow | undefined> => {
    const rows = await db
      .update(accounts)
      .set({ status, updatedAt: now })
      .where(eq(accounts.id, id))
      .returning()
    return rows[0]
  }

  return {
    create: async (input) => {
      const rows = await db
        .insert(accounts)
        .values({
          ...(input.id === undefined ? {} : { id: input.id }),
          label: input.label,
          provider: input.provider,
          ...(input.status === undefined ? {} : { status: input.status }),
          authMaterial: input.authMaterial ?? null,
          configDir: input.configDir ?? null,
          tokenExpiresAt: input.tokenExpiresAt ?? null,
          baseUrl: input.baseUrl ?? null,
          dialect: input.dialect ?? null,
          modelAliases: input.modelAliases ?? null,
          supportedModels: input.supportedModels ?? null,
          windowTokenLimits: input.windowTokenLimits ?? null,
          ...(input.weight === undefined ? {} : { weight: input.weight }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.billing === undefined ? {} : { billing: input.billing }),
        })
        .returning()
      return required(rows[0], "create")
    },

    list: (filter) => {
      const predicates = [
        ...(filter?.status === undefined ? [] : [eq(accounts.status, filter.status)]),
        ...(filter?.provider === undefined ? [] : [eq(accounts.provider, filter.provider)]),
      ]
      const query = db.select().from(accounts)
      return predicates.length === 0
        ? query.orderBy(asc(accounts.createdAt))
        : query.where(and(...predicates)).orderBy(asc(accounts.createdAt))
    },

    findById: async (id) => {
      const rows = await db.select().from(accounts).where(eq(accounts.id, id)).limit(1)
      return rows[0]
    },

    findByIds: async (ids) => {
      if (ids.length === 0) return []
      return db
        .select()
        .from(accounts)
        .where(inArray(accounts.id, [...ids]))
    },

    listIds: async () => {
      const rows = await db.select({ id: accounts.id }).from(accounts)
      return rows.map((row) => row.id)
    },

    // Spread-per-field rather than a loop: an absent key must stay absent (never
    // written as NULL), and `null` must survive as the explicit "clear this
    // column". Only the field list restates itself; the rule stays typed.
    update: async (id, patch, now) => {
      const rows = await db
        .update(accounts)
        .set({
          ...(patch.label === undefined ? {} : { label: patch.label }),
          ...(patch.authMaterial === undefined ? {} : { authMaterial: patch.authMaterial }),
          ...(patch.configDir === undefined ? {} : { configDir: patch.configDir }),
          ...(patch.tokenExpiresAt === undefined ? {} : { tokenExpiresAt: patch.tokenExpiresAt }),
          ...(patch.baseUrl === undefined ? {} : { baseUrl: patch.baseUrl }),
          ...(patch.dialect === undefined ? {} : { dialect: patch.dialect }),
          ...(patch.modelAliases === undefined ? {} : { modelAliases: patch.modelAliases }),
          ...(patch.supportedModels === undefined
            ? {}
            : { supportedModels: patch.supportedModels }),
          ...(patch.windowTokenLimits === undefined
            ? {}
            : { windowTokenLimits: patch.windowTokenLimits }),
          ...(patch.weight === undefined ? {} : { weight: patch.weight }),
          ...(patch.priority === undefined ? {} : { priority: patch.priority }),
          ...(patch.billing === undefined ? {} : { billing: patch.billing }),
          ...(patch.status === undefined ? {} : { status: patch.status }),
          updatedAt: now,
        })
        .where(eq(accounts.id, id))
        .returning()
      return rows[0]
    },

    delete: async (id) => {
      const rows = await db.delete(accounts).where(eq(accounts.id, id)).returning({
        id: accounts.id,
      })
      return rows.length > 0
    },

    updateStatus: setStatus,

    updateStatusWhen: async (id, from, to, now) => {
      // An empty guard admits nothing, and `in ()` is not a predicate postgres
      // accepts — returning early keeps "nothing may be overwritten" from
      // rendering as a statement that means something else.
      if (from.length === 0) return undefined
      const rows = await db
        .update(accounts)
        .set({ status: to, updatedAt: now })
        .where(and(eq(accounts.id, id), inArray(accounts.status, [...from])))
        .returning()
      return rows[0]
    },

    disable: (id, now) => setStatus(id, "disabled", now),

    markUsed: async (ids, at) => {
      if (ids.length === 0) return
      await db
        .update(accounts)
        // GREATEST, not assignment: concurrent replicas flush unordered batches, and a late
        // flush carrying an older instant must never walk the stamp backwards.
        .set({ lastUsedAt: sql`greatest(${accounts.lastUsedAt}, ${at})` })
        // `inArray` de-duplicates for us at the SQL level — one row updated per distinct id,
        // however many times it appeared in the batch.
        .where(inArray(accounts.id, [...new Set(ids)]))
    },

    findIdle: async ({ before, limit }) => {
      if (limit <= 0) return []
      return (
        db
          .select()
          .from(accounts)
          .where(
            and(
              // Never used counts as idle — see the interface note.
              or(isNull(accounts.lastUsedAt), lt(accounts.lastUsedAt, before)),
              // The operator's own switch is not ours to spend money probing.
              ne(accounts.status, "disabled"),
            ),
          )
          // NULLs first: an account that never served anything is the most neglected of all, and
          // Postgres sorts NULLs last under ASC unless told otherwise.
          .orderBy(sql`${accounts.lastUsedAt} asc nulls first`)
          .limit(limit)
      )
    },

    upsertQuotaWindow: async (accountId, state) => {
      const values = {
        utilization: state.utilization ?? null,
        utilizationSource: state.utilizationSource,
        resetsAt: state.resetsAt ?? null,
        resetSource: state.resetSource,
        lastCheckedAt: state.lastCheckedAt,
      }
      const rows = await db
        .insert(quotaWindows)
        .values({ accountId, window: state.window, ...values })
        // The (account_id, window) unique index is what makes a re-check
        // idempotent: probes and the operator's "Re-check now" hit the same row.
        .onConflictDoUpdate({
          target: [quotaWindows.accountId, quotaWindows.window],
          set: values,
        })
        .returning()
      return required(rows[0], "upsertQuotaWindow")
    },

    listQuotaWindows: async (accountIds) => {
      // An empty set is a caller with nothing to hydrate, not a caller asking
      // for every window — `in ()` would be the second thing and is not meant.
      if (accountIds.length === 0) return []
      return db
        .select()
        .from(quotaWindows)
        .where(inArray(quotaWindows.accountId, [...accountIds]))
        .orderBy(asc(quotaWindows.accountId), asc(quotaWindows.window))
    },
  }
}

/**
 * An `insert ... returning` always yields its row; `undefined` here means the
 * statement did not run as written, which is a bug rather than a request
 * outcome — hence a plain Error, not a `RouterError`.
 */
function required<T>(row: T | undefined, operation: string): T {
  if (row === undefined) {
    throw new Error(`accountRepository.${operation}: statement returned no row`)
  }
  return row
}
