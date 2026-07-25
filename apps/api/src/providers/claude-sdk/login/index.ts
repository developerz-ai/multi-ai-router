/**
 * Driving the `claude` CLI's own login for one Account. The service layer imports from here;
 * nothing outside this directory reaches into a file inside it.
 */

export { bunLoginSpawn } from "./bun-spawn"
export type {
  ClaudeCliLogin,
  ClaudeLoginFailureKind,
  ClaudeLoginHandle,
  ClaudeLoginStartInput,
} from "./contract"
export { ClaudeLoginError } from "./contract"
export type { CredentialFs, CredentialGuard, CredentialState } from "./credentials"
export { CREDENTIALS_FILE, CREDENTIALS_MODE, createCredentialGuard } from "./credentials"
export { findAuthorizeUrl, parsePastedCode, readState } from "./scrape"
export type { ClaudeCliLoginOptions, LoginProcess, LoginSpawn, LoginSpawnInput } from "./spawn"
export { createClaudeCliLogin } from "./spawn"
