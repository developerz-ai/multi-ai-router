import type { AccountStatus, ProviderId, QuotaWindowState } from "@multi-ai-router/core"
import { asc, eq } from "drizzle-orm"
import type { Database } from "../client"
import { type AccountRow, accounts, type ModelAliasMap } from "../schema/accounts"
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
  /** `undefined` when no account has that id. */
  updateStatus(id: string, status: AccountStatus, now: Date): Promise<AccountRow | undefined>
  /**
   * The soft delete. Rows are never removed: usage history, audit events, and
   * pool membership all reference the account, and a disabled account that is
   * re-enabled keeps its id. Disabled accounts never survive candidate
   * filtering.
   */
  disable(id: string, now: Date): Promise<AccountRow | undefined>
  /**
   * Writes one window's state, replacing whatever was there. Windows reset
   * independently, so this is per window and never a whole-account overwrite.
   * An absent `utilization` is written as NULL on purpose — a source that has
   * stopped reporting must not leave yesterday's number on display.
   */
  upsertQuotaWindow(accountId: string, state: QuotaWindowState): Promise<QuotaWindowRow>
}

export interface CreateAccountInput {
  /** Human-chosen, required: the disambiguator between same-provider accounts. */
  readonly label: string
  readonly provider: ProviderId
  /** AES-256-GCM envelope. Null for Claude subscription accounts. */
  readonly authMaterial?: string | null
  /** Claude subscription accounts only: the isolated `CLAUDE_CONFIG_DIR`. */
  readonly configDir?: string | null
  /** Refreshable OAuth accounts only. Null for API-key and Claude subscription accounts. */
  readonly tokenExpiresAt?: Date | null
  readonly modelAliases?: ModelAliasMap | null
  readonly weight?: number
  readonly priority?: number
  /** Defaults to `active` in the schema; set explicitly for a pending OAuth row. */
  readonly status?: AccountStatus
}

export interface AccountListFilter {
  /** Absent means every account, disabled ones included — this is the admin list. */
  readonly status?: AccountStatus
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
          label: input.label,
          provider: input.provider,
          ...(input.status === undefined ? {} : { status: input.status }),
          authMaterial: input.authMaterial ?? null,
          configDir: input.configDir ?? null,
          tokenExpiresAt: input.tokenExpiresAt ?? null,
          modelAliases: input.modelAliases ?? null,
          ...(input.weight === undefined ? {} : { weight: input.weight }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
        })
        .returning()
      return required(rows[0], "create")
    },

    list: (filter) => {
      const query = db.select().from(accounts)
      const status = filter?.status
      return status === undefined
        ? query.orderBy(asc(accounts.createdAt))
        : query.where(eq(accounts.status, status)).orderBy(asc(accounts.createdAt))
    },

    findById: async (id) => {
      const rows = await db.select().from(accounts).where(eq(accounts.id, id)).limit(1)
      return rows[0]
    },

    updateStatus: setStatus,

    disable: (id, now) => setStatus(id, "disabled", now),

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
