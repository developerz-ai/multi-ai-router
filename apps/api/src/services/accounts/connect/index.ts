/**
 * The connect flows — one per credential shape an Account can be logged in with, and one service
 * in front of both. `./service.ts` is what the admin plane mounts; the two backends beside it are
 * the `claude` CLI's login and the authorization-code flow the router drives itself.
 */

export type {
  ClaudeConnectCancelled,
  ClaudeConnectCompleted,
  ClaudeConnectDeps,
  ClaudeConnectMode,
  ClaudeConnectService,
  ClaudeConnectStarted,
} from "./claude"
export { createClaudeConnectService } from "./claude"
export type { ClaudeCliFromEnvDeps, ClaudeCliStack, ConnectFromEnvDeps } from "./fromEnv"
export { claudeCliFromEnv, connectFromEnv } from "./fromEnv"
export type {
  OAuthCallbackQuery,
  OAuthConnectCancelled,
  OAuthConnectDeps,
  OAuthConnectService,
  OAuthConnectStarted,
} from "./oauth"
export { createOAuthConnectService, OAUTH_CALLBACK_PATH } from "./oauth"
export type {
  AuthorizedCode,
  OAuthCapture,
  OAuthConnectCompleted,
  OAuthExchangeDeps,
} from "./oauth-exchange"
export { completeAuthorization } from "./oauth-exchange"
export type { PresentedCode } from "./oauth-paste"
export { parseAuthorizationPaste } from "./oauth-paste"
export type {
  ConnectCancelled,
  ConnectCompleted,
  ConnectMode,
  ConnectService,
  ConnectServiceDeps,
  ConnectStarted,
} from "./service"
export { createConnectService } from "./service"
