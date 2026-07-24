/**
 * The keys service's public surface. The transport layer imports from here;
 * nothing outside this directory reaches into a file inside it.
 */

export type { CreateKeyBody, KeyScopeInput, RateLimitInput, UpdateKeyBody } from "./schemas"
export { createKeyBody, keyScopeInput, rateLimitInput, updateKeyBody } from "./schemas"
export type { ResolvedScope, ScopeResolverDeps } from "./scope"
export { resolveScopeInput } from "./scope"
export type { KeysService, KeysServiceDeps } from "./service"
export { createKeysService } from "./service"
export type {
  ApiKeyView,
  KeyRateLimitView,
  KeyScopeTargets,
  KeyScopeView,
  RevealedKey,
} from "./view"
export { toKeyView } from "./view"
