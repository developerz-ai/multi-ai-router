import type { AccountBilling, Dialect, ProviderId } from "@multi-ai-router/core"
import { type AdminFailure, type AdminResult, ok } from "../admin/result"
import { describeProvider, type ProviderDescriptor } from "./providers"

/**
 * What makes an account *configurable at all*, checked before anything is
 * written. Every rule here is derived from the provider registry, so a new
 * driver is validated correctly the day it lands and no list is maintained
 * twice.
 *
 * The rules exist because each of them is a failure that would otherwise
 * surface much later, as a routing error on somebody's request:
 *
 * - a provider with no implementation would be selected and then fail to serve;
 * - an `openai-compatible` account with no base URL has no address at all
 *   (`providers/base-url.ts` raises `NoHealthyAccountError` at selection time);
 * - a Claude subscription account with a router-held credential would be a
 *   token this router must never hold (CLAUDE.md non-negotiable 1);
 * - a local endpoint that authenticates nobody would otherwise be unusable
 *   without inventing a key to satisfy the form;
 * - a dialect the provider does not serve silently falls back to its default,
 *   so the operator's choice would be quietly ignored;
 * - a subscription-only provider marked `metered` would put a per-token charge
 *   in a spend column for tokens nobody was billed for.
 */

/** The account state a rule judges — the row as it will be *after* the write. */
export interface AccountShape {
  readonly provider: ProviderId
  readonly hasCredential: boolean
  readonly configDir: string | null
  readonly baseUrl: string | null
  readonly dialect: Dialect | null
  /** What the operator asked for, or absent to take the provider's default. */
  readonly billing?: AccountBilling
}

export function checkAccountShape(shape: AccountShape): AdminResult<ProviderDescriptor> {
  const provider = describeProvider(shape.provider)

  const failure =
    unimplemented(provider) ??
    credentialRule(provider, shape) ??
    baseUrlRule(provider, shape) ??
    dialectRule(provider, shape) ??
    billingRule(provider, shape)

  return failure === null ? ok(provider) : { ok: false, failure }
}

/**
 * What this account is billed as, once the operator's answer and the provider's have both been
 * heard. Only ever reached after {@link checkAccountShape} accepted the pair, so the fixed case
 * here is a restatement, not a second rule: a subscription-only provider is its own answer.
 */
export function resolveBilling(
  provider: ProviderDescriptor,
  requested: AccountBilling | undefined,
): AccountBilling {
  if (provider.billingFixed) return provider.defaultBilling
  return requested ?? provider.defaultBilling
}

function unimplemented(provider: ProviderDescriptor): AdminFailure | null {
  if (provider.creatable) return null
  return failure(
    `provider "${provider.id}" has no implementation, so no account can use it: ${provider.reason ?? "not implemented"}`,
    "provider_unimplemented",
  )
}

/**
 * A Claude subscription holds no router-managed credential — its tokens live in
 * an isolated `CLAUDE_CONFIG_DIR` owned by the Agent SDK. Every other provider
 * is the exact opposite: a credential is the whole account.
 *
 * `configDir` is never operator input (`schemas.ts` has no field for it), so the
 * two rules about it read as assertions on what the service is about to write:
 * one directory for the providers that need one, none for the providers that do
 * not. They can still fire on an update, for a row predating the router owning
 * the path.
 */
function credentialRule(provider: ProviderDescriptor, shape: AccountShape): AdminFailure | null {
  if (provider.requiresConfigDir) {
    if (shape.hasCredential) {
      return failure(
        `provider "${provider.id}" is served by the Claude Agent SDK and must not be given a credential: its tokens live in its own CLAUDE_CONFIG_DIR`,
        "credential_not_accepted",
      )
    }
    if (shape.configDir === null) {
      return failure(
        `provider "${provider.id}" has no config directory: it is served from one isolated CLAUDE_CONFIG_DIR per account, assigned by the router`,
        "config_dir_required",
      )
    }
    return null
  }

  if (shape.configDir !== null) {
    return failure(
      `provider "${provider.id}" is served over HTTP and has no config directory`,
      "config_dir_not_accepted",
    )
  }
  if (shape.hasCredential || optionalCredential(provider)) return null
  return failure(`provider "${provider.id}" requires "credential"`, "credential_required")
}

/**
 * The two providers that may be created empty, both asked of the descriptor rather than listed by
 * id — a provider gaining either property becomes creatable that way the day its driver file lands
 * (CLAUDE.md non-negotiable 12):
 *
 * - one the router logs in to *itself*. `POST /:id/connect` mints the credential, and the row has to
 *   exist before the authorization so the one-shot `state` has something to bind to
 *   (docs/idea/07-security.md, "Pending rows"). Pasting a token set by hand is still allowed — that
 *   is an import, not a second way to authenticate.
 * - one whose upstream authenticates nobody (`authKind: "none"`, a local `ollama`). A credential is
 *   accepted here too, for the same endpoint behind a reverse proxy that does check one; what this
 *   permits is its *absence*.
 */
function optionalCredential(provider: ProviderDescriptor): boolean {
  return provider.connectFlow !== null || provider.authKind === "none"
}

function baseUrlRule(provider: ProviderDescriptor, shape: AccountShape): AdminFailure | null {
  if (!provider.requiresBaseUrl || shape.baseUrl !== null) return null
  return failure(
    `provider "${provider.id}" has no default endpoint and requires "baseUrl"`,
    "base_url_required",
  )
}

function dialectRule(provider: ProviderDescriptor, shape: AccountShape): AdminFailure | null {
  if (shape.dialect === null || provider.supportedDialects.includes(shape.dialect)) return null
  return failure(
    `provider "${provider.id}" does not serve the "${shape.dialect}" dialect; it serves ${list(provider.supportedDialects)}`,
    "dialect_unsupported",
  )
}

/**
 * A flat-fee plan sold under a metered provider's endpoint is the operator's fact to record — the
 * router cannot see it from the wire. The reverse has no meaning: a Claude Max or ChatGPT plan has
 * no per-token price at all, so calling one `metered` would report an invented charge as spend.
 */
function billingRule(provider: ProviderDescriptor, shape: AccountShape): AdminFailure | null {
  if (shape.billing === undefined || !provider.billingFixed) return null
  if (shape.billing === provider.defaultBilling) return null
  return failure(
    `provider "${provider.id}" is sold only as a subscription and has no per-token price, so its accounts are always billed as "${provider.defaultBilling}"`,
    "billing_fixed",
  )
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.map((value) => `"${value}"`).join(", ")
}

function failure(message: string, code: string): AdminFailure {
  return { status: 400, code, message }
}
