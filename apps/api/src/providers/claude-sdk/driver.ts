import type { AuthKind, Dialect, ProviderId } from "@multi-ai-router/core"
import { NoHealthyAccountError } from "@multi-ai-router/core"
import { mapModelAlias } from "../model-alias"
import type { DriverAccount } from "../types"

/**
 * The Claude subscription transport, as its own contract.
 *
 * `ProviderDriver` (`providers/types.ts`) is not satisfiable here, and widening it to fit would be
 * the wrong seam: there is no base URL to resolve because nothing is addressed over HTTP, no headers
 * to build because no credential ever leaves the `CLAUDE_CONFIG_DIR` the SDK owns, and no
 * `UpstreamResponse` to classify because SDK failures arrive as strings
 * (docs/idea/11-anthropic-agent-sdk.md §9). Three of that interface's five members would be lies.
 *
 * So the two transports are two interfaces, and `providers/registry.ts` discriminates on
 * `transport` — the compile-time fan-out that makes "which transport serves this provider" a
 * question the type system answers rather than a runtime guess.
 *
 * Everything here is **pure**, for the same reason every `ProviderDriver` member is: no clock, no
 * filesystem, no subprocess. Spawning `query()` is I/O and lives behind `SdkInvoker` (`invoke.ts`).
 *
 * The two members `ProviderDriver` has for reading an upstream's answer have no equivalent here and
 * are not simulated: SDK failures are prose (`errors.ts`) and quota arrives inside the query stream
 * rather than on a response (`quota.ts`), so both live beside this contract instead of inside it.
 */

/**
 * The slice of an Account this transport is allowed to see.
 *
 * Deliberately **not** `DriverAccount`: there is no endpoint here and no credential the router
 * holds. The config directory *is* where the credential lives, and it is the CLI's to read — we
 * only name the directory (docs/idea/11-anthropic-agent-sdk.md §3).
 */
export interface SdkAccount {
  readonly id: string
  readonly configDir: string | null
}

export interface ClaudeSdkDriver {
  readonly id: ProviderId
  /**
   * The one wire shape this transport produces. Not per-account: the SDK yields its own message
   * objects and they are re-synthesized into Anthropic Messages exactly once, after which the
   * ordinary Anthropic → * translators serve every other ingress dialect
   * (docs/idea/11-anthropic-agent-sdk.md §6). An account that pins another surface changes nothing.
   */
  readonly dialect: Dialect
  readonly authKind: AuthKind

  /**
   * The isolated `CLAUDE_CONFIG_DIR` this account's subprocess runs against.
   *
   * The counterpart of `ProviderDriver.resolveBaseUrl`, and it fails the same way: an account with
   * no directory cannot serve anything, so it is named as unservable rather than defaulted to
   * something shared. **Never** falls back to the CLI's own default — setting `CLAUDE_CONFIG_DIR`
   * even to `$HOME/.claude` changes the credential lookup key and breaks OAuth, and *not* setting
   * it would run every account against one credential store
   * (docs/idea/11-anthropic-agent-sdk.md §3).
   *
   * @throws NoHealthyAccountError naming the account. No credential material is involved.
   */
  resolveConfigDir(account: SdkAccount): string

  /** Client model name -> upstream model id. Identity when the Account has no entry. */
  mapModelAlias(account: DriverAccount, requestedModel: string): string
}

/**
 * Provenance: docs/idea/11-anthropic-agent-sdk.md §1 and §6 — a Claude Max/Pro subscription is
 * served by `@anthropic-ai/claude-agent-sdk`'s `query()`, whose output is re-synthesized into
 * Anthropic Messages. Blast radius: the dialect every subscription request is converted toward, and
 * the auth style the console labels the provider with.
 */
export const claudeSdkDriver: ClaudeSdkDriver = {
  id: "anthropic-oauth",
  dialect: "anthropic",
  authKind: "oauth",

  resolveConfigDir(account) {
    const dir = account.configDir?.trim()
    if (!dir) {
      throw new NoHealthyAccountError(
        `account ${account.id} (anthropic-oauth) has no config directory: a Claude subscription is served from an isolated CLAUDE_CONFIG_DIR`,
      )
    }
    return dir
  },

  mapModelAlias,
}
