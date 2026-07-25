import { AccountStatus, Dialect, ProviderId } from "@multi-ai-router/core"
import { z } from "zod"

/**
 * The account write contract. Zod at the boundary, once — everything downstream
 * of `parse` is typed and never re-validates (CLAUDE.md, Conventions).
 *
 * Two shapes deserve their names: `credential` is the *plaintext* upstream key
 * or token on the way in and exists nowhere else in the system (it is encrypted
 * before it reaches a repository and is never read back out), and every
 * nullable field on the update body is a deliberate "clear this" — an absent
 * key means "leave it alone".
 *
 * `configDir` is in neither body, and the `.strict()` on both means sending one
 * is a 400 rather than a value quietly ignored. A Claude subscription's
 * `CLAUDE_CONFIG_DIR` is the router's to name — `<CLAUDE_CONFIG_ROOT>/<id>`,
 * minted and provisioned on create (`providers/claude-sdk/config-dir.ts`).
 */

const LABEL = z.string().trim().min(1).max(120)
/** Bounded so an oversized body cannot become an oversized ciphertext. */
const CREDENTIAL = z.string().min(1).max(8192)
const BASE_URL = z.url().max(2048)
const MODEL_ALIASES = z.record(z.string().min(1).max(200), z.string().min(1).max(200))
/** Bias for `weighted`; zero would silently remove the account from that policy. */
const WEIGHT = z.number().int().min(1).max(10_000)
/** Strict order for `priority-failover`; lower is tried first. */
const PRIORITY = z.number().int().min(0).max(10_000)

export const createAccountBody = z
  .object({
    label: LABEL,
    provider: ProviderId,
    credential: CREDENTIAL.optional(),
    baseUrl: BASE_URL.optional(),
    dialect: Dialect.optional(),
    modelAliases: MODEL_ALIASES.optional(),
    weight: WEIGHT.optional(),
    priority: PRIORITY.optional(),
  })
  .strict()

export type CreateAccountBody = z.infer<typeof createAccountBody>

export const updateAccountBody = z
  .object({
    label: LABEL.optional(),
    /** Rotates the stored credential. Never clearable: an account with no credential is broken. */
    credential: CREDENTIAL.optional(),
    baseUrl: BASE_URL.nullable().optional(),
    dialect: Dialect.nullable().optional(),
    modelAliases: MODEL_ALIASES.nullable().optional(),
    weight: WEIGHT.optional(),
    priority: PRIORITY.optional(),
    /**
     * Only the two states an operator sets by hand. `cooling_down`, `exhausted`,
     * and `needs_reauth` are observations the router makes about an upstream —
     * letting the console assert one would fake a quota state.
     */
    status: z.enum(["active", "disabled"]).optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: "no fields to update" })

export type UpdateAccountBody = z.infer<typeof updateAccountBody>

export const accountListQuery = z
  .object({
    status: AccountStatus.optional(),
    provider: ProviderId.optional(),
  })
  .strict()

export type AccountListQuery = z.infer<typeof accountListQuery>
