import type { ProviderId } from "@multi-ai-router/core"
import { type ClaudeSdkDriver, claudeSdkDriver } from "./claude-sdk/driver"
import { anthropicApiDriver } from "./drivers/anthropic-api"
import { anthropicCompatibleDriver } from "./drivers/anthropic-compatible"
import { cerebrasDriver } from "./drivers/cerebras"
import { deepSeekDriver } from "./drivers/deepseek"
import { geminiDriver } from "./drivers/gemini"
import { groqDriver } from "./drivers/groq"
import { kimiDriver } from "./drivers/kimi"
import { miniMaxDriver } from "./drivers/minimax"
import { mistralDriver } from "./drivers/mistral"
import { ollamaDriver } from "./drivers/ollama"
import { openAiApiDriver } from "./drivers/openai-api"
import { openAiCompatibleDriver } from "./drivers/openai-compatible"
import { openAiOAuthDriver } from "./drivers/openai-oauth"
import { openRouterDriver } from "./drivers/openrouter"
import { togetherDriver } from "./drivers/together"
import { xaiDriver } from "./drivers/xai"
import { zaiDriver } from "./drivers/zai"
import type { ProviderDriver } from "./types"

/**
 * The static provider registry. Keyed by `ProviderId` as a **total** record, so a new id in
 * `packages/core` fails this file to compile until it is accounted for — the Open/Closed rule
 * with a compiler behind it.
 *
 * Every id is present, and the ones with no implementation say why rather than being silently
 * absent or stubbed into something that looks like it works. **No id sits there today**; the
 * `unimplemented` transport is what an id declared in `packages/core` ahead of its driver lands on,
 * and the reason the data plane can refuse it by name instead of failing somewhere downstream.
 *
 * `transport` is also the **transport seam**: two transports, two driver interfaces, one
 * discriminated union. Every caller that needs to know how a provider is reached narrows on it, so
 * "is this HTTP or the Agent SDK" is a question the compiler answers — never a provider-id
 * comparison scattered across the data plane.
 */

export type ProviderSupport =
  | { readonly transport: "http"; readonly driver: ProviderDriver }
  /**
   * Served by `@anthropic-ai/claude-agent-sdk`'s `query()`, against a per-Account
   * `CLAUDE_CONFIG_DIR`. A different interface, not a `ProviderDriver` — see `claude-sdk/driver.ts`.
   * `reason` is operator-facing: the console shows it beside the provider.
   */
  | { readonly transport: "agent-sdk"; readonly driver: ClaudeSdkDriver; readonly reason: string }
  /** Declared in the domain, no implementation yet. Selecting one is a configuration error. */
  | { readonly transport: "unimplemented"; readonly reason: string }

const http = (driver: ProviderDriver): ProviderSupport => ({ transport: "http", driver })

export const PROVIDER_REGISTRY: Readonly<Record<ProviderId, ProviderSupport>> = {
  "anthropic-api": http(anthropicApiDriver),
  "openai-api": http(openAiApiDriver),
  // A subscription over ordinary HTTP: the router holds and refreshes the token, so it is a
  // `ProviderDriver` like any other — unlike a Claude subscription, whose tokens the SDK owns.
  "openai-oauth": http(openAiOAuthDriver),
  openrouter: http(openRouterDriver),
  zai: http(zaiDriver),
  kimi: http(kimiDriver),
  minimax: http(miniMaxDriver),
  // Google's OpenAI-compatibility surface, not the native GenAI protocol — that dialect is still
  // deferred (docs/idea/10-roadmap.md), and this driver is what makes the id reachable meanwhile.
  gemini: http(geminiDriver),
  // Six vendors that all speak OpenAI Chat Completions and differ only in how they word a failure.
  // Pinned ids rather than `openai-compatible` accounts, because an id is what carries the endpoint,
  // the credit-exhaustion rules, and the operator's ability to see which upstream a pool is spending.
  groq: http(groqDriver),
  deepseek: http(deepSeekDriver),
  xai: http(xaiDriver),
  mistral: http(mistralDriver),
  together: http(togetherDriver),
  cerebras: http(cerebrasDriver),
  // The local one: an operator-supplied endpoint and no credential required, which is what makes an
  // Account on somebody's own machine expressible without inventing a key to satisfy a form.
  ollama: http(ollamaDriver),
  "openai-compatible": http(openAiCompatibleDriver),
  "anthropic-compatible": http(anthropicCompatibleDriver),

  "anthropic-oauth": {
    transport: "agent-sdk",
    driver: claudeSdkDriver,
    reason:
      "Claude Max/Pro subscriptions go through @anthropic-ai/claude-agent-sdk, one isolated CLAUDE_CONFIG_DIR per account. No subscription token is ever extracted or attached to an HTTP request — docs/idea/11-anthropic-agent-sdk.md.",
  },

  // Synthetic id written into `oauth_states.provider` by the admin-plane OIDC
  // flow (apps/api/src/services/admin-auth/oidc/state.ts). Not an AI
  // provider — no driver, no pool, no routing. Present here because the
  // registry is keyed by `ProviderId` as a total record (the Open/Closed
  // rule with a compiler behind it) and the column is enum-typed, so the
  // synthetic value needs to be a real enum member to be written at all.
  "admin-oidc": {
    transport: "unimplemented",
    reason:
      "Synthetic id for the admin-plane OIDC flow's oauth_states rows. Never selected as a routing target; presence in the registry is only to satisfy the total-keyed type.",
  },
}

/** The driver for an id, or `null` when this provider is not served over HTTP. */
export function httpDriver(id: ProviderId): ProviderDriver | null {
  const support = PROVIDER_REGISTRY[id]
  return support.transport === "http" ? support.driver : null
}

/** Every HTTP driver, for surfaces that enumerate rather than look up. */
export const HTTP_DRIVERS: readonly ProviderDriver[] = Object.values(PROVIDER_REGISTRY).flatMap(
  (support) => (support.transport === "http" ? [support.driver] : []),
)
