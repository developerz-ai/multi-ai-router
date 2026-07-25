/**
 * Running the `claude` CLI as a command, for one Account: its own login, and the credential status
 * of the directory that login wrote. The service layer imports from here; nothing outside this
 * directory reaches into a file inside it.
 *
 * Inference never comes through here — that is the Agent SDK, which spawns its own child.
 */

export { bunLoginSpawn } from "./bun-spawn"
export type {
  ClaudeAuthCheck,
  ClaudeAuthStatus,
  ClaudeCliLogin,
  ClaudeLoginFailureKind,
  ClaudeLoginHandle,
  ClaudeLoginStartInput,
} from "./contract"
export { ClaudeLoginError } from "./contract"
export type { CredentialFs, CredentialGuard, CredentialState } from "./credentials"
export { CREDENTIALS_FILE, CREDENTIALS_MODE, createCredentialGuard } from "./credentials"
export {
  CLAUDE_AUTH_STATUS_ARGV,
  findAuthorizeUrl,
  parsePastedCode,
  readAuthStatus,
  readState,
} from "./scrape"
export type { ClaudeCliLoginOptions, LoginProcess, LoginSpawn, LoginSpawnInput } from "./spawn"
export { createClaudeCliLogin } from "./spawn"
export type { ClaudeAuthCheckOptions } from "./status"
export { AUTH_STATUS_TIMEOUT_MS, createClaudeAuthCheck } from "./status"
