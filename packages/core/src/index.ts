/**
 * `@multi-ai-router/core` — the shared types, errors, and Zod schemas every other package builds
 * on. It imports nothing from the apps and has no runtime dependency on the server.
 *
 * This barrel is the package's entire public API. Callers import from `@multi-ai-router/core`,
 * never from a path inside `src/`.
 */

export {
  AccountStatus,
  isStandingBlock,
  QuotaWindowKind,
  QuotaWindowState,
  ResetSource,
  UtilizationSource,
} from "./domain/account"
export {
  DEFAULT_OPENAI_CHAT_CEILING,
  Dialect,
  EgressMode,
  OpenAiChatCeiling,
} from "./domain/dialect"
export { KeyScope } from "./domain/key"
export { AuthKind, ProviderId } from "./domain/provider"
export { DEFAULT_ROUTING_POLICY, RoutingPolicy } from "./domain/routing"
export {
  isSuccessOutcome,
  USAGE_OUTCOME_SUCCESS,
  UsageFault,
  UsageOutcome,
  usageOutcomeFault,
  usageOutcomeForErrorCode,
} from "./domain/usage"
export type { QuotaExhaustedInit, RetryableInit, RouterErrorCode } from "./errors"
export {
  AdminAuthError,
  CredentialDecryptError,
  CreditsExhaustedError,
  CsrfTokenError,
  isRouterError,
  KeyRateLimitedError,
  KeyRevokedError,
  ModelNotFoundError,
  NoHealthyAccountError,
  QuotaExhaustedError,
  RequestTooLargeError,
  RetryableRouterError,
  ROUTER_ERROR_CODES,
  RouterError,
  ScopeViolationError,
  TranslationError,
  UpstreamAuthError,
  UpstreamTimeoutError,
} from "./errors"
export {
  generateRouterKey,
  isRouterKey,
  ROUTER_KEY_DISPLAY_PREFIX_LENGTH,
  ROUTER_KEY_DISPLAY_RANDOM_LENGTH,
  ROUTER_KEY_LENGTH,
  ROUTER_KEY_PATTERN,
  ROUTER_KEY_PREFIX,
  ROUTER_KEY_RANDOM_LENGTH,
  routerKeyDisplayPrefix,
} from "./ids"
export { VERSION } from "./version"
