import type { ProviderId } from "@multi-ai-router/core"
import { httpDriver, type ProviderOAuthFlow } from "../../src/providers"

/**
 * The registry's OAuth flow with its device-code half removed. Every shipped OAuth provider is
 * device-only now, so the generic paste and redirect machinery is exercised against the same
 * builders with that one declaration taken away.
 */
export function pasteOnlyFlow(provider: ProviderId): ProviderOAuthFlow | undefined {
  const flow = httpDriver(provider)?.oauth
  if (flow === undefined) return undefined
  const { device: _device, ...rest } = flow
  return rest
}
