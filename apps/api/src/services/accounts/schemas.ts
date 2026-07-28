import {
  AccountBilling,
  AccountStatus,
  Dialect,
  ProviderId,
  QuotaWindowKind,
} from "@multi-ai-router/core"
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
const MODEL_NAME = z.string().trim().min(1).max(200)
const MODEL_ALIASES = z.record(z.string().min(1).max(200), z.string().min(1).max(200))
/**
 * Upstream-side model ids. Bounded because this is a catalog, not a corpus — a provider listing
 * runs to tens of entries and a body of ten thousand is a mistake or an attack, not a config.
 *
 * `[]` is accepted and means the same thing `null` does: unknown, therefore passthrough
 * (`catalog/load.ts`). It is not rejected, because "I emptied the list" is a real edit and the
 * operator should not have to know which of the two spellings clears it.
 */
const SUPPORTED_MODELS = z.array(MODEL_NAME).max(1000)
/**
 * Operator-set token ceilings per quota window — the figure the console's progress bar is a
 * fraction of.
 *
 * Bounded well above any real plan so a typo is a validation error rather than a bar that never
 * moves. Positive integers only: zero would render as permanently 100% spent, and a negative
 * ceiling has no meaning.
 */
const WINDOW_TOKEN_LIMITS = z.record(QuotaWindowKind, z.number().int().positive().max(1e12))
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
    supportedModels: SUPPORTED_MODELS.optional(),
    weight: WEIGHT.optional(),
    priority: PRIORITY.optional(),
    /**
     * A flat-fee plan bought under a metered provider's endpoint, which is the one cost fact the
     * router cannot read off the wire. Absent takes the provider's own default, and stating the
     * wrong one for a subscription-only provider is refused rather than ignored (`rules.ts`).
     */
    billing: AccountBilling.optional(),
    /**
     * The operator's own estimate of each window's token allowance. Not a provider fact — nothing
     * in routing reads it, and the console labels every bar it draws as configured.
     */
    windowTokenLimits: WINDOW_TOKEN_LIMITS.optional(),
  })
  .strict()

export type CreateAccountBody = z.infer<typeof createAccountBody>

export const updateAccountBody = z
  .object({
    label: LABEL.optional(),
    /**
     * Rotates the stored credential. Not clearable: for every provider but the local endpoint an
     * account with none is broken, and dropping the one a local endpoint was given is a delete and
     * re-add away — a `null` here would be a second way to strand a working account.
     */
    credential: CREDENTIAL.optional(),
    baseUrl: BASE_URL.nullable().optional(),
    dialect: Dialect.nullable().optional(),
    modelAliases: MODEL_ALIASES.nullable().optional(),
    /** `null` (or `[]`) drops the declaration, which returns the account to passthrough. */
    supportedModels: SUPPORTED_MODELS.nullable().optional(),
    /** `null` clears every configured ceiling, which removes the bars rather than zeroing them. */
    windowTokenLimits: WINDOW_TOKEN_LIMITS.nullable().optional(),
    weight: WEIGHT.optional(),
    priority: PRIORITY.optional(),
    /** Not nullable: every account is billed one of the two ways, so there is nothing to clear. */
    billing: AccountBilling.optional(),
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

/**
 * What the operator pastes back from the CLI's authorization page: the whole `code#state` string.
 *
 * One field and `.strict()`, because everything else about the flow is already bound server-side —
 * an account id in the path and a pending login in memory. A body that could name a `state` would
 * be a body that could be used to answer a login it did not start.
 *
 * The value **is** credential material for the moment it is in flight, so nothing downstream echoes
 * it: the service's rejections describe the shape and never the value, and `services/admin/parse.ts`
 * names a failing field without quoting what was in it. Bounded because an authorization code is a
 * few hundred bytes and a megabyte of it is not a paste.
 */
export const completeConnectBody = z.object({ pasted: z.string().trim().min(1).max(4096) }).strict()

export type CompleteConnectBody = z.infer<typeof completeConnectBody>

/**
 * "Test now"'s body. The router has no model catalog for an upstream — discovering one is itself a
 * live request — so the operator names the model the same way a client would, and the account's own
 * alias map still applies on top of it (`test-now.ts`).
 *
 * `confirmed` gates the Agent-SDK path only: a subscription test spawns a real subprocess and bills
 * a turn, so the console must send it back deliberately, never as a request an operator only
 * *thought* was free. Absent (or `false`) is the safe default everywhere else, where it is ignored.
 */
export const testNowBody = z
  .object({
    model: z.string().trim().min(1).max(200),
    confirmed: z.boolean().optional(),
  })
  .strict()

export type TestNowBody = z.infer<typeof testNowBody>
