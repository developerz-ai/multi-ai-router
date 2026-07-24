import { generateRouterKey, routerKeyDisplayPrefix } from "@multi-ai-router/core"
import type {
  AccountRepository,
  ApiKeyRepository,
  ApiKeyRow,
  PoolRepository,
} from "@multi-ai-router/db"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../admin/audit"
import { type AdminResult, conflict, invalid, notFound, ok } from "../admin/result"
import type { CreateKeyBody, UpdateKeyBody } from "./schemas"
import { type ResolvedScope, resolveScopeInput } from "./scope"
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
    | "create"
    | "list"
    | "findById"
    | "findByName"
    | "update"
    | "delete"
    | "markRevoked"
    | "listPoolTargets"
    | "listAccountTargets"
    | "listTargetsForKeys"
    | "replaceScopeTargets"
  >
  readonly pools: Pick<PoolRepository, "findByIds">
  readonly accounts: Pick<AccountRepository, "findByIds">
  readonly cipher: { encrypt(plaintext: string): string; decrypt(envelope: string): string }
  readonly audit: AuditRecorder
  readonly now: () => Date
  /** Defaults to `generateRouterKey`. Injected only so a test can pin a value. */
  readonly generate?: () => string
}

export function createKeysService(deps: KeysServiceDeps): KeysService {
  const generate = deps.generate ?? generateRouterKey

  const targetsOf = async (id: string) => ({
    poolIds: (await deps.keys.listPoolTargets(id)).map((row) => row.poolId),
    accountIds: (await deps.keys.listAccountTargets(id)).map((row) => row.accountId),
  })

  const load = async (id: string): Promise<AdminResult<ApiKeyRow>> => {
    const row = await deps.keys.findById(id)
    return row === undefined ? notFound(`no key with id "${id}"`) : ok(row)
  }

  const nameTaken = async (name: string, exceptId?: string): Promise<boolean> => {
    const existing = await deps.keys.findByName(name)
    return existing !== undefined && existing.id !== exceptId
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
      return found.ok ? ok(toKeyView(found.value, await targetsOf(id))) : found
    },

    create: async (body) => {
      const scope = await resolveScopeInput(deps, body.scope ?? { kind: "all" })
      if (!scope.ok) return scope

      const expiry = checkExpiry(body.expiresAt, deps.now())
      if (!expiry.ok) return expiry

      if (await nameTaken(body.name)) {
        return conflict(`a key named "${body.name}" already exists`)
      }

      const value = generate()
      const prefix = routerKeyDisplayPrefix(value)
      if (prefix === null) {
        // The generator and the prefix function are both in core and agree by
        // construction; a mismatch is a bug in this process, not a bad request.
        throw new Error("key generation produced a value with no valid display prefix")
      }

      const row = await deps.keys.create({
        name: body.name,
        value: deps.cipher.encrypt(value),
        prefix,
        scope: scope.value.kind,
        rateLimitRequests: body.rateLimit?.requests ?? null,
        rateLimitWindowSeconds: body.rateLimit?.windowSeconds ?? null,
        expiresAt: body.expiresAt ?? null,
      })
      await deps.keys.replaceScopeTargets(row.id, scope.value)

      await deps.audit.record({
        kind: AUDIT_KINDS.keyCreated,
        subjectType: AUDIT_SUBJECTS.key,
        subjectId: row.id,
        // Never the value, never the ciphertext, never the prefix: a name, the
        // scope shape, and how many targets it names.
        detail: {
          name: row.name,
          scope: row.scope,
          poolCount: scope.value.poolIds.length,
          accountCount: scope.value.accountIds.length,
          expires: row.expiresAt !== null,
        },
      })

      return ok({ ...toKeyView(row, scope.value), value })
    },

    update: async (id, body) => {
      const found = await load(id)
      if (!found.ok) return found

      const expiry = checkExpiry(body.expiresAt ?? undefined, deps.now())
      if (!expiry.ok) return expiry

      let scope: ResolvedScope | null = null
      if (body.scope !== undefined) {
        const resolved = await resolveScopeInput(deps, body.scope)
        if (!resolved.ok) return resolved
        scope = resolved.value
      }

      if (body.name !== undefined && (await nameTaken(body.name, id))) {
        return conflict(`a key named "${body.name}" already exists`)
      }

      const row = await deps.keys.update(
        id,
        {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(scope === null ? {} : { scope: scope.kind }),
          ...(body.rateLimit === undefined
            ? {}
            : {
                rateLimitRequests: body.rateLimit?.requests ?? null,
                rateLimitWindowSeconds: body.rateLimit?.windowSeconds ?? null,
              }),
          ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
        },
        deps.now(),
      )
      if (row === undefined) return notFound(`no key with id "${id}"`)
      if (scope !== null) await deps.keys.replaceScopeTargets(id, scope)

      await deps.audit.record({
        kind: AUDIT_KINDS.keyUpdated,
        subjectType: AUDIT_SUBJECTS.key,
        subjectId: row.id,
        detail: { name: row.name, fields: Object.keys(body).sort(), scope: row.scope },
      })

      return ok(toKeyView(row, await targetsOf(id)))
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

    revoke: async (id) => {
      const found = await load(id)
      if (!found.ok) return found
      if (found.value.revoked) {
        return conflict(`key "${found.value.name}" is already revoked`, "already_revoked")
      }

      const now = deps.now()
      await deps.keys.markRevoked(id, now)

      await deps.audit.record({
        kind: AUDIT_KINDS.keyRevoked,
        subjectType: AUDIT_SUBJECTS.key,
        subjectId: id,
        detail: { name: found.value.name },
      })

      // Revocation is immediate for new requests; in-flight ones finish.
      const revoked: ApiKeyRow = { ...found.value, revoked: true, revokedAt: now, updatedAt: now }
      return ok(toKeyView(revoked, await targetsOf(id)))
    },

    remove: async (id) => {
      const found = await load(id)
      if (!found.ok) return found

      const deleted = await deps.keys.delete(id)
      if (!deleted) return notFound(`no key with id "${id}"`)

      await deps.audit.record({
        kind: AUDIT_KINDS.keyDeleted,
        subjectType: AUDIT_SUBJECTS.key,
        subjectId: id,
        detail: { name: found.value.name },
      })

      return ok({ id, deleted: true })
    },
  }
}

/** A key minted already expired works for exactly no requests; say so at the door. */
function checkExpiry(expiresAt: Date | undefined, now: Date): AdminResult<null> {
  if (expiresAt === undefined || expiresAt.getTime() > now.getTime()) return ok(null)
  return invalid(`"expiresAt" is in the past: ${expiresAt.toISOString()}`, "expiry_in_past")
}
