import { KeyScope } from "@multi-ai-router/core"
import { z } from "zod"

/**
 * The router-key write contract.
 *
 * `name` is required, not optional-with-a-default: it is how the operator finds
 * the key later and how usage is attributed, and a fleet of keys called
 * "untitled" is exactly the failure the requirement exists to prevent
 * (docs/idea/04-api-keys-and-access.md#format).
 *
 * The scope discriminants are read off core's `KeyScope` enum rather than
 * spelled out, so the three forms here and the `key_scope` Postgres enum cannot
 * drift apart.
 */

const KEY_NAME = z.string().trim().min(1).max(120)

/** Bounded: a scope naming thousands of targets is a mistake, not a configuration. */
const TARGET_IDS = z.array(z.uuid()).min(1).max(100)

export const keyScopeInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal(KeyScope.enum.all) }).strict(),
  z.object({ kind: z.literal(KeyScope.enum.pools), poolIds: TARGET_IDS }).strict(),
  z.object({ kind: z.literal(KeyScope.enum.accounts), accountIds: TARGET_IDS }).strict(),
])

export type KeyScopeInput = z.infer<typeof keyScopeInput>

/**
 * Requests per window. Both halves are required together: a count with no window
 * is not a rate limit, and a window with no count is not one either.
 */
export const rateLimitInput = z
  .object({
    requests: z.number().int().min(1).max(1_000_000),
    windowSeconds: z.number().int().min(1).max(86_400),
  })
  .strict()

export type RateLimitInput = z.infer<typeof rateLimitInput>

/** ISO-8601 with an offset accepted, so a console in any timezone round-trips. */
const TIMESTAMP = z.iso.datetime({ offset: true }).transform((value) => new Date(value))

export const createKeyBody = z
  .object({
    name: KEY_NAME,
    /** Absent means `all` — full scope, stated explicitly rather than implied by omission. */
    scope: keyScopeInput.optional(),
    rateLimit: rateLimitInput.optional(),
    expiresAt: TIMESTAMP.optional(),
  })
  .strict()

export type CreateKeyBody = z.infer<typeof createKeyBody>

/**
 * Editing a key never changes its value — see the lifecycle table in
 * docs/idea/04-api-keys-and-access.md. There is deliberately no `value` field
 * and no rotate endpoint: a key the operator can re-read does not need one.
 */
export const updateKeyBody = z
  .object({
    name: KEY_NAME.optional(),
    scope: keyScopeInput.optional(),
    /** `null` removes the per-key ceiling. */
    rateLimit: rateLimitInput.nullable().optional(),
    /** `null` makes the key non-expiring. */
    expiresAt: TIMESTAMP.nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: "no fields to update" })

export type UpdateKeyBody = z.infer<typeof updateKeyBody>
