import type { AccountStatus } from "@multi-ai-router/core"
import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { type AccountRow, accounts } from "../schema/accounts"
import { quotaWindows } from "../schema/quota-windows"
import { createAccountAuthorization } from "./account-authorization"
import { createAccountLifecycle } from "./account-lifecycle"
import type { AccountRepository } from "./account-types"
import { withAdminMutationRetry } from "./admin-mutation-conflict"
import { createQuotaWindowMutations } from "./quota-window-mutations"

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
export type {
  AccountListFilter,
  AccountRepository,
  CreateAccountInput,
  UpdateAccountInput,
} from "./account-types"

export function createAccountRepository(db: DatabaseExecutor): AccountRepository {
  const lifecycle = createAccountLifecycle(db)
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
    ...lifecycle,
    ...createAccountAuthorization(db),
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

    delete: (id) =>
      withAdminMutationRetry(() =>
        db.transaction(async (tx) => {
          // Account cascades lock pools too. Either side of a concurrent pool edit can lose
          // deadlock detection; rollback this transaction/savepoint before retrying the delete.
          const rows = await tx.delete(accounts).where(eq(accounts.id, id)).returning({
            id: accounts.id,
          })
          return rows.length > 0
        }),
      ),

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

    disable: (id, now) =>
      lifecycle.updateOperatorAccount({ id, patch: { status: "disabled" }, now }),

    markUsed: async (ids, at) => {
      if (ids.length === 0) return
      await db
        .update(accounts)
        // GREATEST, not assignment: concurrent replicas flush unordered batches, and a late
        // flush carrying an older instant must never walk the stamp backwards.
        // ISO string + explicit cast, never a raw `Date`: a value in a raw `sql` template has no
        // column, so drizzle applies no encoder and the driver fails to serialize the object at
        // bind time — the rule `usage-daily-repository.ts` states, violated here and caught only
        // in production.
        .set({
          lastUsedAt: sql`greatest(${accounts.lastUsedAt}, ${at.toISOString()}::timestamptz)`,
        })
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

    ...createQuotaWindowMutations(db),

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
