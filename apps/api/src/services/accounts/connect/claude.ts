import { createClaudeLoginFlow } from "./claude-flow"
import type { ClaudeConnectDeps, ClaudeConnectService } from "./claude-types"

export type {
  ClaudeConnectCancelled,
  ClaudeConnectCompleted,
  ClaudeConnectDeps,
  ClaudeConnectMode,
  ClaudeConnectService,
  ClaudeConnectStarted,
} from "./claude-types"

export function createClaudeConnectService(deps: ClaudeConnectDeps): ClaudeConnectService {
  return createClaudeLoginFlow(deps)
}
