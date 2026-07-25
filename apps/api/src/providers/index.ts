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
export type { SdkInvocation, SdkInvoker } from "./claude-sdk/invoke"
export type { QueryLaunch, QueryLaunchInput } from "./claude-sdk/options"
export { createQueryLaunch, MAX_TURNS } from "./claude-sdk/options"
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
export type { HttpDriverConfig, ProviderSurface } from "./driver"
export { createHttpDriver } from "./driver"
export type { ClassificationRule, ClassifyOptions } from "./failure/classify"
export { classifyUpstreamFailure, codeRule, messageRule, typeRule } from "./failure/classify"
export { readErrorFacts } from "./failure/error-body"
export { toRouterError } from "./failure/router-error"
export { mapModelAlias } from "./model-alias"
export { parseRateLimitHeaders } from "./rate-limit/parse"
export type { ProviderSupport } from "./registry"
export { HTTP_DRIVERS, httpDriver, PROVIDER_REGISTRY } from "./registry"
export type {
  DriverAccount,
  FailureClassification,
  ProviderCredential,
  ProviderDriver,
  RateLimitSignal,
  RateLimitWindow,
  UpstreamErrorFacts,
  UpstreamFailureKind,
  UpstreamResponse,
} from "./types"
export { UPSTREAM_FAILURE_KINDS } from "./types"
