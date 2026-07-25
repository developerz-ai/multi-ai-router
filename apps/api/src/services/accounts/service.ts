import type { AccountRepository, AccountRow, ApiKeyRepository } from "@multi-ai-router/db"
import type { AccountConfigDirs } from "../../providers/claude-sdk/config-dir"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../admin/audit"
import { type AdminResult, conflict, notFound, ok } from "../admin/result"
import type { CredentialCipher } from "../crypto/cipher"
import { describeProvider } from "./providers"
import { checkAccountShape } from "./rules"
import type { AccountListQuery, CreateAccountBody, UpdateAccountBody } from "./schemas"
import { type AccountView, toAccountView } from "./view"

/**
 * Account CRUD for the admin plane. Fat service, thin routes: every rule about
 * what an account may look like, what encryption happens to it, and what the
 * operator is told lives here, and the route does parse → call → render.
 *
 * The one invariant worth restating: **plaintext credentials enter this module
 * and never leave it.** `cipher.encrypt` is called on the way in, the envelope
 * goes to the repository, and every response is built by `toAccountView`, which
 * has no field that can hold credential material.
 *
 * A Claude subscription account is the one whose lifecycle reaches past the row:
 * it owns an isolated `CLAUDE_CONFIG_DIR` that is created with it and deleted
 * with it, named after its id so a rename cannot orphan a logged-in directory
 * (`providers/claude-sdk/config-dir.ts`). Its *contents* stay the SDK's — this
 * module makes the directory and never opens it.
 */

export interface AccountsService {
  list(query: AccountListQuery): Promise<AdminResult<readonly AccountView[]>>
  get(id: string): Promise<AdminResult<AccountView>>
  create(body: CreateAccountBody): Promise<AdminResult<AccountView>>
  update(id: string, body: UpdateAccountBody): Promise<AdminResult<AccountView>>
  disable(id: string): Promise<AdminResult<AccountView>>
  remove(id: string): Promise<AdminResult<{ readonly id: string; readonly deleted: true }>>
}

export interface AccountsServiceDeps {
  readonly accounts: Pick<
    AccountRepository,
    "create" | "list" | "findById" | "update" | "disable" | "delete"
  >
  /** Read-only here: a destructive account change must say which keys it breaks. */
  readonly keys: Pick<ApiKeyRepository, "listKeysScopedToAccount">
  readonly cipher: Pick<CredentialCipher, "encrypt">
  /** Only ever touched for a provider the registry says carries a `CLAUDE_CONFIG_DIR`. */
  readonly configDirs: AccountConfigDirs
  readonly audit: AuditRecorder
  readonly now: () => Date
}

export function createAccountsService(deps: AccountsServiceDeps): AccountsService {
  const load = async (id: string): Promise<AdminResult<AccountRow>> => {
    const row = await deps.accounts.findById(id)
    return row === undefined ? notFound(`no account with id "${id}"`) : ok(row)
  }

  return {
    list: async (query) => {
      const rows = await deps.accounts.list(query)
      return ok(rows.map(toAccountView))
    },

    get: async (id) => {
      const found = await load(id)
      return found.ok ? ok(toAccountView(found.value)) : found
    },

    create: async (body) => {
      // The id is minted here rather than by the column default because the config directory is
      // named after it, and the directory has to exist before anything can be logged in to it.
      const id = crypto.randomUUID()
      const configDir = describeProvider(body.provider).requiresConfigDir
        ? deps.configDirs.pathFor(id)
        : null

      const checked = checkAccountShape({
        provider: body.provider,
        hasCredential: body.credential !== undefined,
        configDir,
        baseUrl: body.baseUrl ?? null,
        dialect: body.dialect ?? null,
      })
      if (!checked.ok) return checked

      if (configDir !== null) await deps.configDirs.provision(id)

      const row = await deps.accounts
        .create({
          id,
          label: body.label,
          provider: body.provider,
          authMaterial: body.credential === undefined ? null : deps.cipher.encrypt(body.credential),
          // A row that exists only so an authorization can bind to it is not routable yet, and
          // `needs_reauth` is exactly that state: excluded from selection, visible in the console
          // as "connect me", cleared by the connect flow and by nothing else.
          ...(checked.value.connectFlow === "oauth" && body.credential === undefined
            ? { status: "needs_reauth" as const }
            : {}),
          configDir,
          baseUrl: body.baseUrl ?? null,
          dialect: body.dialect ?? null,
          modelAliases: body.modelAliases ?? null,
          ...(body.weight === undefined ? {} : { weight: body.weight }),
          ...(body.priority === undefined ? {} : { priority: body.priority }),
        })
        .catch(async (error: unknown) => {
          // An insert that never landed leaves a directory no row will ever name again — and the
          // unique index would refuse to hand it to anyone else. Take it back before rethrowing.
          if (configDir !== null) await deps.configDirs.remove(id)
          throw error
        })

      await deps.audit.record({
        kind: AUDIT_KINDS.accountCreated,
        subjectType: AUDIT_SUBJECTS.account,
        subjectId: row.id,
        // Names and flags only — never the credential, and never its ciphertext.
        detail: {
          label: row.label,
          provider: row.provider,
          hasCredential: row.authMaterial !== null,
        },
      })

      return ok(toAccountView(row))
    },

    update: async (id, body) => {
      const found = await load(id)
      if (!found.ok) return found
      const current = found.value

      const checked = checkAccountShape({
        provider: current.provider,
        hasCredential: body.credential !== undefined || current.authMaterial !== null,
        // Not patchable: the path is a function of the id, and the id never moves.
        configDir: current.configDir,
        baseUrl: resolve(body.baseUrl, current.baseUrl),
        dialect: resolve(body.dialect, current.dialect ?? null),
      })
      if (!checked.ok) return checked

      const row = await deps.accounts.update(
        id,
        {
          ...(body.label === undefined ? {} : { label: body.label }),
          ...(body.credential === undefined
            ? {}
            : { authMaterial: deps.cipher.encrypt(body.credential) }),
          ...(body.baseUrl === undefined ? {} : { baseUrl: body.baseUrl }),
          ...(body.dialect === undefined ? {} : { dialect: body.dialect }),
          ...(body.modelAliases === undefined ? {} : { modelAliases: body.modelAliases }),
          ...(body.weight === undefined ? {} : { weight: body.weight }),
          ...(body.priority === undefined ? {} : { priority: body.priority }),
          ...(body.status === undefined ? {} : { status: body.status }),
        },
        deps.now(),
      )
      if (row === undefined) return notFound(`no account with id "${id}"`)

      await deps.audit.record({
        kind: AUDIT_KINDS.accountUpdated,
        subjectType: AUDIT_SUBJECTS.account,
        subjectId: row.id,
        // Which fields moved, never their values: a rotated credential is one flag.
        detail: { label: row.label, fields: Object.keys(body).sort() },
      })

      return ok(toAccountView(row))
    },

    disable: async (id) => {
      const row = await deps.accounts.disable(id, deps.now())
      if (row === undefined) return notFound(`no account with id "${id}"`)

      await deps.audit.record({
        kind: AUDIT_KINDS.accountDisabled,
        subjectType: AUDIT_SUBJECTS.account,
        subjectId: row.id,
        detail: { label: row.label, provider: row.provider },
      })

      return ok(toAccountView(row))
    },

    remove: async (id) => {
      const found = await load(id)
      if (!found.ok) return found

      // A key scoped to explicit accounts is narrowed — possibly to nothing — by
      // this delete, and would then fail at selection time with no trace of why.
      // Say so instead, and name the keys: `disable` is the non-destructive door.
      const scoped = await deps.keys.listKeysScopedToAccount(id)
      if (scoped.length > 0) {
        return conflict(
          `account "${found.value.label}" is named by the scope of ${scoped.length} key(s): ${scoped
            .map((key) => `"${key.name}"`)
            .join(", ")}. Re-scope them, or disable the account instead.`,
          "account_in_use",
        )
      }

      // Directory first, and only then the row. The other order can strand cleartext OAuth
      // credentials on the volume with nothing left pointing at them; this order can at worst
      // leave a row whose subscription is logged out, which is visible and fixable by re-login.
      if (found.value.configDir !== null) await deps.configDirs.remove(found.value.id)

      const deleted = await deps.accounts.delete(id)
      if (!deleted) return notFound(`no account with id "${id}"`)

      await deps.audit.record({
        kind: AUDIT_KINDS.accountDeleted,
        subjectType: AUDIT_SUBJECTS.account,
        subjectId: id,
        detail: { label: found.value.label, provider: found.value.provider },
      })

      return ok({ id, deleted: true })
    },
  }
}

/** `undefined` leaves the stored value; `null` clears it. Both are meaningful. */
function resolve<T>(patched: T | null | undefined, current: T | null): T | null {
  return patched === undefined ? current : patched
}
