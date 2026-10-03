import type { AdminMutationRepository, ApiKeyRepository, ApiKeyRow } from "@multi-ai-router/db"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../admin/audit"
import { type AdminResult, notFound, ok } from "../admin/result"
import { createKeyMutations, type KeyMutationKind } from "./mutations"
import type { CreateKeyBody, UpdateKeyBody } from "./schemas"
import { readKeyTargets } from "./snapshot"
import { type ApiKeyView, type RevealedKey, toKeyView } from "./view"

/**
 * Router key CRUD for the admin plane.
 *
 * Keys are **encrypted, not hashed, and retrievable**: the mint returns the
 * value, `reveal` returns it again on demand, and neither rotates anything.
 * There is no shown-once flow here to add later — the storage choice is what
 * makes one unnecessary (CLAUDE.md non-negotiable 5).
 *
 * `generate` is injected so a test can mint a known value; production always
 * gets core's `generateRouterKey`, which is the only source of key values.
 */

export interface KeysService {
  list(): Promise<AdminResult<readonly ApiKeyView[]>>
  get(id: string): Promise<AdminResult<ApiKeyView>>
  /** The one response that carries the value alongside the view. */
  create(body: CreateKeyBody): Promise<AdminResult<ApiKeyView & { readonly value: string }>>
  update(id: string, body: UpdateKeyBody): Promise<AdminResult<ApiKeyView>>
  /** An audited read. Decrypts and returns the value; changes nothing. */
  reveal(id: string): Promise<AdminResult<RevealedKey>>
  revoke(id: string): Promise<AdminResult<ApiKeyView>>
  remove(id: string): Promise<AdminResult<{ readonly id: string; readonly deleted: true }>>
}

export interface KeysServiceDeps {
  readonly keys: Pick<
    ApiKeyRepository,
    "list" | "findById" | "listPoolTargets" | "listAccountTargets" | "listTargetsForKeys"
  >
  readonly mutations: AdminMutationRepository
  /** Runs immediately after commit, before rendering a response. */
  readonly onCommitted: (id: string, kind: KeyMutationKind) => void
  readonly cipher: { encrypt(plaintext: string): string; decrypt(envelope: string): string }
  readonly audit: AuditRecorder
  readonly now: () => Date
  /** Defaults to `generateRouterKey`. Injected only so a test can pin a value. */
  readonly generate?: () => string
}

export function createKeysService(deps: KeysServiceDeps): KeysService {
  const load = async (id: string): Promise<AdminResult<ApiKeyRow>> => {
    const row = await deps.keys.findById(id)
    return row === undefined ? notFound(`no key with id "${id}"`) : ok(row)
  }

  return {
    list: async () => {
      const rows = await deps.keys.list()
      const targets = await deps.keys.listTargetsForKeys(rows.map((row) => row.id))
      return ok(
        rows.map((row) =>
          toKeyView(row, {
            poolIds: targets.pools.flatMap((t) => (t.apiKeyId === row.id ? [t.poolId] : [])),
            accountIds: targets.accounts.flatMap((t) =>
              t.apiKeyId === row.id ? [t.accountId] : [],
            ),
          }),
        ),
      )
    },

    get: async (id) => {
      const found = await load(id)
      return found.ok ? ok(toKeyView(found.value, await readKeyTargets(deps.keys, id))) : found
    },

    reveal: async (id) => {
      const found = await load(id)
      if (!found.ok) return found

      // Audited *before* the value is handed over, so a reveal is recorded even
      // if the response never reaches the browser.
      await deps.audit.record({
        kind: AUDIT_KINDS.keyRevealed,
        subjectType: AUDIT_SUBJECTS.key,
        subjectId: id,
        detail: { name: found.value.name },
      })

      return ok({
        id: found.value.id,
        name: found.value.name,
        value: deps.cipher.decrypt(found.value.value),
      })
    },

    ...createKeyMutations(deps),
  }
}
