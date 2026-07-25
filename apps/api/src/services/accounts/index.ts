/**
 * The accounts service's public surface. The transport layer imports from here;
 * nothing outside this directory reaches into a file inside it.
 */

export type { AccountAvailability, AvailabilityDeps } from "./availability"
export { withAvailability } from "./availability"
export type {
  AuthorizedCode,
  ClaudeCliFromEnvDeps,
  ClaudeCliStack,
  ClaudeConnectCancelled,
  ClaudeConnectCompleted,
  ClaudeConnectDeps,
  ClaudeConnectMode,
  ClaudeConnectService,
  ClaudeConnectStarted,
  ConnectCancelled,
  ConnectCompleted,
  ConnectFromEnvDeps,
  ConnectMode,
  ConnectService,
  ConnectServiceDeps,
  ConnectStarted,
  OAuthCallbackQuery,
  OAuthCapture,
  OAuthConnectCancelled,
  OAuthConnectCompleted,
  OAuthConnectDeps,
  OAuthConnectService,
  OAuthConnectStarted,
  OAuthExchangeDeps,
  PresentedCode,
} from "./connect"
export {
  claudeCliFromEnv,
  completeAuthorization,
  connectFromEnv,
  createClaudeConnectService,
  createConnectService,
  createOAuthConnectService,
  OAUTH_CALLBACK_PATH,
  parseAuthorizationPaste,
} from "./connect"
export type { ProviderConnectFlow, ProviderDescriptor, ProviderTransport } from "./providers"
export { describeProvider, describeProviders } from "./providers"
export type { RecheckResult, RecheckService, RecheckServiceDeps } from "./recheck"
export { createRecheckService } from "./recheck"
export type { AccountShape } from "./rules"
export { checkAccountShape } from "./rules"
export type {
  AccountListQuery,
  CompleteConnectBody,
  CreateAccountBody,
  UpdateAccountBody,
} from "./schemas"
export {
  accountListQuery,
  completeConnectBody,
  createAccountBody,
  updateAccountBody,
} from "./schemas"
export type { AccountsService, AccountsServiceDeps } from "./service"
export { createAccountsService } from "./service"
export type { AccountView } from "./view"
export { toAccountView } from "./view"
