import { AUDIT_KINDS, AUDIT_SUBJECTS, createAuditRecorder } from "../admin/audit"
import { diffIds, namedAccounts } from "../admin/audit-diff"
import { mutationResult } from "../admin/mutation-result"
import { conflict, notFound, ok } from "../admin/result"
import type { PoolsService, PoolsServiceDeps } from "./service"
import { checkReferences, idsOf, resolveTuning } from "./validation"
import { toPoolView } from "./view"

export type PoolMutationKind = "create" | "update" | "remove"

export function createPoolMutations(deps: PoolsServiceDeps): Pick<PoolsService, PoolMutationKind> {
  return {
    create: async (body) => {
      const result = await mutationResult(() =>
        deps.mutations.run({ kind: "pool", id: null, name: body.name }, async (tx) => {
          const accounts = new Map((await tx.accounts.list()).map((row) => [row.id, row]))
          const checked = checkReferences({
            members: body.members,
            memberIds: idsOf(body.members ?? []),
            overflowAccountId: body.overflowAccountId ?? null,
            accounts,
          })
          if (!checked.ok) return checked
          if ((await tx.pools.findByName(body.name)) !== undefined) {
            return conflict(`a pool named "${body.name}" already exists`)
          }
          const pool = await tx.pools.create({
            name: body.name,
            ...(body.policy === undefined ? {} : { policy: body.policy }),
            overflowAccountId: body.overflowAccountId ?? null,
          })
          const members = await tx.pools.replaceMembers(
            pool.id,
            (body.members ?? []).map(resolveTuning(accounts, [])),
          )
          await createAuditRecorder(tx.audit, deps.logger).record({
            kind: AUDIT_KINDS.poolCreated,
            subjectType: AUDIT_SUBJECTS.pool,
            subjectId: pool.id,
            detail: {
              name: pool.name,
              policy: pool.policy,
              memberCount: members.length,
              members: namedAccounts([...idsOf(members)], labelsOf(accounts.values())),
              hasOverflow: pool.overflowAccountId !== null,
            },
          })
          return ok({ pool, members, accounts })
        }),
      )
      if (!result.ok) return result
      await deps.onCommitted(result.value.pool.id, "create")
      return ok(toPoolView(result.value.pool, result.value.members, result.value.accounts))
    },

    update: async (id, body) => {
      const result = await mutationResult(() =>
        deps.mutations.run(
          { kind: "pool", id, ...(body.name === undefined ? {} : { name: body.name }) },
          async (tx) => {
            const current = await tx.pools.findById(id)
            if (current === undefined) return notFound(`no pool with id "${id}"`)
            // The runner locked this pool before these reads, so concurrent member/overflow edits
            // validate against the preceding committed mutation and retain its tuning.
            const held = await tx.pools.listMembers(id)
            const accounts = new Map((await tx.accounts.list()).map((row) => [row.id, row]))
            const checked = checkReferences({
              members: body.members,
              memberIds: body.members === undefined ? idsOf(held) : idsOf(body.members),
              overflowAccountId:
                body.overflowAccountId === undefined
                  ? current.overflowAccountId
                  : body.overflowAccountId,
              accounts,
            })
            if (!checked.ok) return checked
            if (
              body.name !== undefined &&
              body.name !== current.name &&
              (await tx.pools.findByName(body.name)) !== undefined
            ) {
              return conflict(`a pool named "${body.name}" already exists`)
            }
            const pool = await tx.pools.update(
              id,
              {
                ...(body.name === undefined ? {} : { name: body.name }),
                ...(body.policy === undefined ? {} : { policy: body.policy }),
                ...(body.overflowAccountId === undefined
                  ? {}
                  : { overflowAccountId: body.overflowAccountId }),
              },
              deps.now(),
            )
            if (pool === undefined) return notFound(`no pool with id "${id}"`)
            const members =
              body.members === undefined
                ? held
                : await tx.pools.replaceMembers(id, body.members.map(resolveTuning(accounts, held)))
            const audit = createAuditRecorder(tx.audit, deps.logger)
            await audit.record({
              kind: AUDIT_KINDS.poolUpdated,
              subjectType: AUDIT_SUBJECTS.pool,
              subjectId: pool.id,
              detail: {
                name: pool.name,
                fields: Object.keys(body).sort(),
                policyBefore: current.policy,
                policyAfter: pool.policy,
                ...(body.members === undefined
                  ? {}
                  : membershipChange(
                      [...idsOf(held)],
                      [...idsOf(members)],
                      labelsOf(accounts.values()),
                    )),
              },
            })
            if (pool.policy !== current.policy) {
              await audit.record({
                kind: AUDIT_KINDS.policyChanged,
                subjectType: AUDIT_SUBJECTS.pool,
                subjectId: pool.id,
                detail: { poolId: pool.id, from: current.policy, to: pool.policy },
              })
            }
            return ok({ pool, members, accounts })
          },
        ),
      )
      if (!result.ok) return result
      await deps.onCommitted(id, "update")
      return ok(toPoolView(result.value.pool, result.value.members, result.value.accounts))
    },

    remove: async (id) => {
      const result = await mutationResult(() =>
        deps.mutations.run({ kind: "pool", id }, async (tx) => {
          const pool = await tx.pools.findById(id)
          if (pool === undefined) return notFound(`no pool with id "${id}"`)
          const scoped = await tx.keys.listKeysScopedToPool(id)
          // A revoked key reaches nothing, so it blocks nothing; its scope row cascades away.
          const live = scoped.filter((key) => !key.revoked)
          if (live.length > 0) {
            return conflict(
              `pool "${pool.name}" is named by the scope of ${live.length} key(s): ${live
                .map((key) => `"${key.name}"`)
                .join(", ")}. Re-scope or revoke them first.`,
              "pool_in_use",
            )
          }
          // Read before the delete: its cascade takes the membership with it.
          const held = [...idsOf(await tx.pools.listMembers(id))]
          const labels = labelsOf(await tx.accounts.findByIds(held))
          if (!(await tx.pools.delete(id))) return notFound(`no pool with id "${id}"`)
          await createAuditRecorder(tx.audit, deps.logger).record({
            kind: AUDIT_KINDS.poolDeleted,
            subjectType: AUDIT_SUBJECTS.pool,
            subjectId: id,
            detail: {
              name: pool.name,
              policy: pool.policy,
              members: namedAccounts(held, labels),
              // Only revoked keys here (a live one is refused above), so the operator's delete and
              // the reaper's carry the same fields.
              keys: scoped.map((key) => ({ keyId: key.id, name: key.name })),
            },
          })
          return ok({ id, deleted: true as const })
        }),
      )
      if (result.ok) await deps.onCommitted(id, "remove")
      return result
    },
  }
}

function labelsOf(accounts: Iterable<{ readonly id: string; readonly label: string }>) {
  const labels = new Map<string, string>()
  for (const account of accounts) labels.set(account.id, account.label)
  return labels
}

/** `pool.updated`'s member fields for a write that sent `members` (multi-ai-router#454). */
function membershipChange(
  before: readonly string[],
  after: readonly string[],
  labels: ReadonlyMap<string, string>,
) {
  const diff = diffIds(before, after)
  return {
    memberCount: after.length,
    membersAdded: namedAccounts(diff.added, labels),
    membersRemoved: namedAccounts(diff.removed, labels),
  }
}
