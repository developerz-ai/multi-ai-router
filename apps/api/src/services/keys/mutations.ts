import { generateRouterKey, routerKeyDisplayPrefix } from "@multi-ai-router/core"
import type { AdminMutationScope, ApiKeyRow } from "@multi-ai-router/db"
import { AUDIT_KINDS, AUDIT_SUBJECTS, createAuditRecorder } from "../admin/audit"
import { mutationResult } from "../admin/mutation-result"
import { type AdminResult, conflict, invalid, notFound, ok } from "../admin/result"
import { type ResolvedScope, resolveScopeInput } from "./scope"
import type { KeysService, KeysServiceDeps } from "./service"
import { readKeyTargets } from "./snapshot"
import { toKeyView } from "./view"

export type KeyMutationKind = "create" | "update" | "revoke" | "remove"

export function createKeyMutations(deps: KeysServiceDeps): Pick<KeysService, KeyMutationKind> {
  const generate = deps.generate ?? generateRouterKey
  return {
    create: async (body) => {
      const result = await mutationResult(() =>
        deps.mutations.run({ kind: "key", id: null, name: body.name }, async (tx) => {
          const scope = await resolveScopeInput(tx, body.scope ?? { kind: "all" })
          if (!scope.ok) return scope
          const expiry = checkExpiry(body.expiresAt, deps.now())
          if (!expiry.ok) return expiry
          if (await nameTaken(tx, body.name))
            return conflict(`a key named "${body.name}" already exists`)

          const value = generate()
          const prefix = routerKeyDisplayPrefix(value)
          if (prefix === null)
            throw new Error("key generation produced a value with no valid display prefix")
          const row = await tx.keys.create({
            name: body.name,
            value: deps.cipher.encrypt(value),
            prefix,
            scope: scope.value.kind,
            rateLimitRequests: body.rateLimit?.requests ?? null,
            rateLimitWindowSeconds: body.rateLimit?.windowSeconds ?? null,
            expiresAt: body.expiresAt ?? null,
          })
          await tx.keys.replaceScopeTargets(row.id, scope.value)
          await createAuditRecorder(tx.audit).record({
            kind: AUDIT_KINDS.keyCreated,
            subjectType: AUDIT_SUBJECTS.key,
            subjectId: row.id,
            detail: {
              name: row.name,
              scope: row.scope,
              poolCount: scope.value.poolIds.length,
              accountCount: scope.value.accountIds.length,
              expires: row.expiresAt !== null,
            },
          })
          return ok({ row, targets: scope.value, value })
        }),
      )
      if (!result.ok) return result
      deps.onCommitted(result.value.row.id, "create")
      return ok({ ...toKeyView(result.value.row, result.value.targets), value: result.value.value })
    },

    update: async (id, body) => {
      const result = await mutationResult(() =>
        deps.mutations.run(
          { kind: "key", id, ...(body.name === undefined ? {} : { name: body.name }) },
          async (tx) => {
            const current = await tx.keys.findById(id)
            if (current === undefined) return notFound(`no key with id "${id}"`)
            const expiry = checkExpiry(body.expiresAt ?? undefined, deps.now())
            if (!expiry.ok) return expiry
            let scope: ResolvedScope | null = null
            if (body.scope !== undefined) {
              const resolved = await resolveScopeInput(tx, body.scope)
              if (!resolved.ok) return resolved
              scope = resolved.value
            }
            if (body.name !== undefined && (await nameTaken(tx, body.name, id))) {
              return conflict(`a key named "${body.name}" already exists`)
            }
            const row = await tx.keys.update(
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
            if (scope !== null) await tx.keys.replaceScopeTargets(id, scope)
            await createAuditRecorder(tx.audit).record({
              kind: AUDIT_KINDS.keyUpdated,
              subjectType: AUDIT_SUBJECTS.key,
              subjectId: row.id,
              detail: { name: row.name, fields: Object.keys(body).sort(), scope: row.scope },
            })
            return ok({ row, targets: await readKeyTargets(tx.keys, id) })
          },
        ),
      )
      if (!result.ok) return result
      deps.onCommitted(id, "update")
      return ok(toKeyView(result.value.row, result.value.targets))
    },

    revoke: async (id) => {
      const result = await mutationResult(() =>
        deps.mutations.run({ kind: "key", id }, async (tx) => {
          const current = await tx.keys.findById(id)
          if (current === undefined) return notFound(`no key with id "${id}"`)
          if (current.revoked)
            return conflict(`key "${current.name}" is already revoked`, "already_revoked")
          const now = deps.now()
          await tx.keys.markRevoked(id, now)
          await createAuditRecorder(tx.audit).record({
            kind: AUDIT_KINDS.keyRevoked,
            subjectType: AUDIT_SUBJECTS.key,
            subjectId: id,
            detail: { name: current.name },
          })
          const row: ApiKeyRow = { ...current, revoked: true, revokedAt: now, updatedAt: now }
          return ok({ row, targets: await readKeyTargets(tx.keys, id) })
        }),
      )
      if (!result.ok) return result
      deps.onCommitted(id, "revoke")
      return ok(toKeyView(result.value.row, result.value.targets))
    },

    remove: async (id) => {
      const result = await mutationResult(() =>
        deps.mutations.run({ kind: "key", id }, async (tx) => {
          const current = await tx.keys.findById(id)
          if (current === undefined) return notFound(`no key with id "${id}"`)
          if (!(await tx.keys.delete(id))) return notFound(`no key with id "${id}"`)
          await createAuditRecorder(tx.audit).record({
            kind: AUDIT_KINDS.keyDeleted,
            subjectType: AUDIT_SUBJECTS.key,
            subjectId: id,
            detail: { name: current.name },
          })
          return ok({ id, deleted: true as const })
        }),
      )
      if (result.ok) deps.onCommitted(id, "remove")
      return result
    },
  }
}

async function nameTaken(
  tx: AdminMutationScope,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const existing = await tx.keys.findByName(name)
  return existing !== undefined && existing.id !== exceptId
}

/** A key minted already expired works for exactly no requests; say so at the door. */
function checkExpiry(expiresAt: Date | undefined, now: Date): AdminResult<null> {
  if (expiresAt === undefined || expiresAt.getTime() > now.getTime()) return ok(null)
  return invalid(`"expiresAt" is in the past: ${expiresAt.toISOString()}`, "expiry_in_past")
}
