/**
 * The connect flows — one per credential shape an Account can be logged in with. Claude
 * subscriptions today; the reverse-engineered OAuth providers land beside this file.
 */

export type {
  ClaudeConnectCancelled,
  ClaudeConnectCompleted,
  ClaudeConnectDeps,
  ClaudeConnectService,
  ClaudeConnectStarted,
} from "./claude"
export { createClaudeConnectService } from "./claude"
