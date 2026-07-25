/**
 * The accounts service's public surface. The transport layer imports from here;
 * nothing outside this directory reaches into a file inside it.
 */

export type { AccountAvailability, AvailabilityDeps } from "./availability"
export { withAvailability } from "./availability"
export type {
  ClaudeConnectCancelled,
  ClaudeConnectCompleted,
  ClaudeConnectDeps,
  ClaudeConnectService,
  ClaudeConnectStarted,
} from "./connect"
export { createClaudeConnectService } from "./connect"
export type { ProviderDescriptor, ProviderTransport } from "./providers"
export { describeProvider, describeProviders } from "./providers"
export type { RecheckResult, RecheckService, RecheckServiceDeps } from "./recheck"
export { createRecheckService } from "./recheck"
export type { AccountShape } from "./rules"
export { checkAccountShape } from "./rules"
export type {
  AccountListQuery,
  CreateAccountBody,
  UpdateAccountBody,
} from "./schemas"
export { accountListQuery, createAccountBody, updateAccountBody } from "./schemas"
export type { AccountsService, AccountsServiceDeps } from "./service"
export { createAccountsService } from "./service"
export type { AccountView } from "./view"
export { toAccountView } from "./view"
