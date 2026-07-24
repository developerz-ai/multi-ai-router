import type { Dialect, ProviderId } from "@multi-ai-router/core"
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
 * - a dialect the provider does not serve silently falls back to its default,
 *   so the operator's choice would be quietly ignored.
 */

/** The account state a rule judges — the row as it will be *after* the write. */
export interface AccountShape {
  readonly provider: ProviderId
  readonly hasCredential: boolean
  readonly configDir: string | null
  readonly baseUrl: string | null
  readonly dialect: Dialect | null
}

export function checkAccountShape(shape: AccountShape): AdminResult<ProviderDescriptor> {
  const provider = describeProvider(shape.provider)

  const failure =
    unimplemented(provider) ??
    credentialRule(provider, shape) ??
    baseUrlRule(provider, shape) ??
    dialectRule(provider, shape)

  return failure === null ? ok(provider) : { ok: false, failure }
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
        `provider "${provider.id}" requires "configDir": one isolated CLAUDE_CONFIG_DIR per account`,
        "config_dir_required",
      )
    }
    return null
  }

  if (shape.configDir !== null) {
    return failure(
      `provider "${provider.id}" is served over HTTP and takes no "configDir"`,
      "config_dir_not_accepted",
    )
  }
  if (!shape.hasCredential) {
    return failure(`provider "${provider.id}" requires "credential"`, "credential_required")
  }
  return null
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

function list(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.map((value) => `"${value}"`).join(", ")
}

function failure(message: string, code: string): AdminFailure {
  return { status: 400, code, message }
}
