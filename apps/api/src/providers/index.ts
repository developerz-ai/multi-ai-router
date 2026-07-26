/**
 * The provider layer's public surface. Callers (routing, transport, the admin plane) import from
 * here; nothing outside this directory reaches into a driver file.
 */

export type { AnthropicAuthForm } from "./auth-headers"
export { ANTHROPIC_OAUTH_BETA, ANTHROPIC_VERSION } from "./auth-headers"
export { isPermittedTool, PERMITTED_TOOLS, toolDenial } from "./claude-sdk/allowlist"
export type { CliProbeOptions } from "./claude-sdk/cli-probe"
export { createCliProbe } from "./claude-sdk/cli-probe"
export type { SdkConcurrency, SdkConcurrencyLimits, SdkSlot } from "./claude-sdk/concurrency"
export { createSdkConcurrency } from "./claude-sdk/concurrency"
export type { ClaudeSdkDriver, SdkAccount } from "./claude-sdk/driver"
export { claudeSdkDriver } from "./claude-sdk/driver"
export type { SubprocessEnvOptions } from "./claude-sdk/env"
export {
  CLAUDE_CONFIG_DIR_VAR,
  STRIPPED_ENV_NAMES,
  STRIPPED_ENV_PREFIXES,
  subprocessEnv,
} from "./claude-sdk/env"
export type { SdkFailure, SdkFailureText } from "./claude-sdk/errors"
export { classifySdkFailure, readSdkFailure, STDERR_TAIL_LIMIT } from "./claude-sdk/errors"
export type { SdkInvocation, SdkInvoker } from "./claude-sdk/invoke"
export type { QueryLaunch, QueryLaunchInput } from "./claude-sdk/options"
export { createQueryLaunch, MAX_TURNS } from "./claude-sdk/options"
export type {
  SdkQuotaSnapshot,
  SdkQuotaStore,
  SdkRateLimitReading,
  SdkRateLimitStatus,
} from "./claude-sdk/quota"
export {
  createSdkQuotaStore,
  readSdkRateLimitInfo,
  SDK_DEFAULT_BUCKET,
} from "./claude-sdk/quota"
export type {
  ClientFrame,
  Completion,
  Envelope,
  IdleGuard,
  SdkRenderInput,
  SdkRenderObserver,
  StreamPacing,
  Ticker,
} from "./claude-sdk/render"
export {
  createEnvelope,
  createIdleGuard,
  DEFAULT_STREAM_PACING,
  renderSdkResponse,
  systemTicker,
} from "./claude-sdk/render"
export type {
  CliAttempt,
  CliProbe,
  CliRejection,
  CliResolution,
  CliSource,
  FileFacts,
} from "./claude-sdk/resolve-cli"
export { resolveClaudeCli } from "./claude-sdk/resolve-cli"
export type {
  ConversationView,
  FingerprintSeed,
  FreshReason,
  LineageClass,
  LineageMessage,
  LineageOverlap,
  ResolveLineageInput,
  ResolveTurnInput,
  SessionCache,
  SessionCacheOptions,
  SessionEntry,
  SessionPlan,
  SessionStore,
  SessionStoreDeps,
  SessionTurn,
  StoredBinding,
} from "./claude-sdk/session"
export {
  classifyLineage,
  createSessionCache,
  createSessionStore,
  DEFAULT_SESSION_CACHE_MAX_ENTRIES,
  DEFAULT_SESSION_CACHE_NEGATIVE_TTL_MS,
  DEFAULT_SESSION_CACHE_TTL_MS,
  FIRST_USER_TEXT_LIMIT,
  hashMessages,
  readConversation,
  resolveLineage,
  scopedKey,
  sessionFingerprint,
} from "./claude-sdk/session"
export type { SdkTestProbe, SdkTestProbeInput, SdkTestProbeOptions } from "./claude-sdk/test-probe"
export { createSdkTestProbe } from "./claude-sdk/test-probe"
export type {
  CapturedToolCall,
  DeclaredTool,
  EarlyStop,
  EarlyStopInput,
  EmittedToolCall,
  Passthrough,
  PassthroughInput,
  PassthroughTool,
  ToolInputRepair,
  ToolIntegrity,
  ToolRewrite,
  ToolRewriter,
  ToolSchema,
} from "./claude-sdk/tools"
export {
  createEarlyStop,
  createPassthrough,
  createPassthroughServer,
  createToolRewriter,
  DEFER_LOADING_THRESHOLD,
  DENY_HOLD_TIMEOUT_SECONDS,
  MAX_BUFFERED_TOOL_INPUT,
  PASSTHROUGH_SERVER_NAME,
  passthroughToolDefinition,
  qualifyToolName,
  readDeclaredTools,
  readToolSchema,
  repairToolInput,
  TOOL_SEARCH,
  unprefixToolName,
} from "./claude-sdk/tools"
export type { HttpDriverConfig, ProviderSurface } from "./driver"
export { createHttpDriver } from "./driver"
export type { OpenAiOAuthTokens } from "./drivers/openai-oauth"
export {
  CHATGPT_ACCOUNT_ID_HEADER,
  CHATGPT_CODEX_BASE_URL,
  chatGptAccountId,
  OPENAI_AUTH_CLAIM,
  OPENAI_OAUTH_AUTHORIZE_URL,
  OPENAI_OAUTH_CLIENT_ID,
  OPENAI_OAUTH_ISSUER,
  OPENAI_OAUTH_LOOPBACK_REDIRECT_URI,
  OPENAI_OAUTH_REFRESH_SCOPE,
  OPENAI_OAUTH_SCOPE,
  OPENAI_OAUTH_TOKEN_URL,
  openAiOAuthAuthorizeUrl,
  openAiOAuthCodeExchange,
  openAiOAuthDriver,
  openAiOAuthRefresh,
  readOpenAiOAuthTokens,
} from "./drivers/openai-oauth"
export type { ClassificationRule, ClassifyOptions } from "./failure/classify"
export {
  classifyUpstreamFailure,
  codeRule,
  isRetryableFailureKind,
  messageRule,
  typeRule,
} from "./failure/classify"
export { readErrorFacts } from "./failure/error-body"
export { toRouterError } from "./failure/router-error"
export { mapModelAlias } from "./model-alias"
export { parseRateLimitHeaders } from "./rate-limit/parse"
export type { ProviderSupport } from "./registry"
export { HTTP_DRIVERS, httpDriver, PROVIDER_REGISTRY } from "./registry"
export type {
  DriverAccount,
  FailureClassification,
  OAuthTokenRequest,
  OAuthTokens,
  ProviderCredential,
  ProviderDriver,
  ProviderOAuthFlow,
  RateLimitSignal,
  RateLimitWindow,
  UpstreamErrorFacts,
  UpstreamFailureKind,
  UpstreamResponse,
} from "./types"
export { UPSTREAM_FAILURE_KINDS } from "./types"
