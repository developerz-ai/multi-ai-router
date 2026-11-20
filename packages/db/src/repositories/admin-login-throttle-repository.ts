import { and, count, eq, lte, sql } from "drizzle-orm"
import type { Database } from "../client"
import {
  adminLoginThrottleBuckets as buckets,
  adminLoginThrottleNamespaces as namespaces,
} from "../schema/admin-login-throttle"

export type LoginThrottleNamespace = "local" | "oidc-start" | "oidc-callback"
export interface LoginThrottlePolicy {
  maxFailedAttempts: number
  maxTrackedIps: number
  attemptWindowSeconds: number
  lockoutSeconds: number
  evictionIntervalMs?: number
}
export type LoginThrottleDecision =
  | { allowed: true }
  | {
      allowed: false
      retryAfterSeconds: number
      firstDenial: boolean
    }

export function createAdminLoginThrottleRepository(db: Database) {
  return {
    async consume(
      namespace: LoginThrottleNamespace,
      key: string,
      policy: LoginThrottlePolicy,
    ): Promise<LoginThrottleDecision> {
      return db.transaction(async (tx) => {
        // A fixed row serializes both capacity admission and each bucket's read/modify/write.
        const [meta] = await tx
          .select()
          .from(namespaces)
          .where(eq(namespaces.namespace, namespace))
          .for("update")
        if (!meta) throw new Error("Missing login throttle namespace")
        // now() is the transaction start, which can precede a long lock wait.
        const [clock] = await tx
          .select({ at: sql<string>`clock_timestamp()` })
          .from(namespaces)
          .where(eq(namespaces.namespace, namespace))
        if (!clock) throw new Error("Missing database clock")
        const at = new Date(clock.at)
        const ms = at.getTime()
        const where = and(eq(buckets.namespace, namespace), eq(buckets.key, key))
        if (ms - meta.sweptAt.getTime() >= (policy.evictionIntervalMs ?? 1000)) {
          await tx
            .delete(buckets)
            .where(and(eq(buckets.namespace, namespace), lte(buckets.expiresAt, at)))
          await tx
            .update(namespaces)
            .set({ sweptAt: at })
            .where(eq(namespaces.namespace, namespace))
        }
        const [existing] = await tx.select().from(buckets).where(where)
        const current = existing && existing.expiresAt > at ? existing : undefined
        if (current?.locked) {
          await tx.update(buckets).set({ denialReported: true }).where(where)
          return {
            allowed: false,
            retryAfterSeconds: Math.max(1, Math.ceil((current.expiresAt.getTime() - ms) / 1000)),
            firstDenial: !current.denialReported,
          }
        }
        if (!existing) {
          const [size] = await tx
            .select({ value: count() })
            .from(buckets)
            .where(eq(buckets.namespace, namespace))
          if ((size?.value ?? 0) >= policy.maxTrackedIps) {
            const firstDenial = meta.saturationUntil <= at
            const retryAfterSeconds = Math.max(1, policy.lockoutSeconds)
            if (firstDenial)
              await tx
                .update(namespaces)
                .set({ saturationUntil: new Date(ms + retryAfterSeconds * 1000) })
                .where(eq(namespaces.namespace, namespace))
            return { allowed: false, retryAfterSeconds, firstDenial }
          }
        }
        const attempts = (current?.attempts ?? 0) + 1
        const locked = attempts >= policy.maxFailedAttempts
        const windowStart = current?.windowStart ?? at
        const expiresAt = new Date(
          locked
            ? ms + policy.lockoutSeconds * 1000
            : windowStart.getTime() + policy.attemptWindowSeconds * 1000,
        )
        const values = {
          namespace,
          key,
          attempts,
          windowStart,
          expiresAt,
          locked,
          denialReported: false,
        }
        await tx
          .insert(buckets)
          .values(values)
          .onConflictDoUpdate({ target: [buckets.namespace, buckets.key], set: values })
        return { allowed: true }
      })
    },
    async reset(namespace: LoginThrottleNamespace, key: string): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.select().from(namespaces).where(eq(namespaces.namespace, namespace)).for("update")
        await tx.delete(buckets).where(and(eq(buckets.namespace, namespace), eq(buckets.key, key)))
      })
    },
  }
}
