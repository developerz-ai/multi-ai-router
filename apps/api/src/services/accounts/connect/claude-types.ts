import type {
  AccountRepository,
  PendingClaudeLoginRepository,
  ReplicaLeaseToken,
} from "@multi-ai-router/db"
import type { Logger } from "../../../logging/logger"
import type { AccountConfigDirs } from "../../../providers/claude-sdk/config-dir"
import type { ClaudeCliLogin, CredentialGuard } from "../../../providers/claude-sdk/login"
import type { AuditRecorder } from "../../admin/audit"
import type { AdminResult } from "../../admin/result"
import type { HealthStore } from "../../dataplane"

export type ClaudeConnectMode = "connect" | "reconnect"

export interface ClaudeConnectStarted {
  readonly accountId: string
  readonly mode: ClaudeConnectMode
  readonly authorizeUrl: string
  readonly expiresAt: string
  readonly capture: "paste"
}

export interface ClaudeConnectCompleted {
  readonly accountId: string
  readonly mode: ClaudeConnectMode
  readonly connected: true
  readonly repaired: boolean
}

export interface ClaudeConnectCancelled {
  readonly accountId: string
  readonly cancelled: boolean
}

export interface ClaudeConnectService {
  begin(accountId: string, mode: ClaudeConnectMode): Promise<AdminResult<ClaudeConnectStarted>>
  complete(accountId: string, pasted: string): Promise<AdminResult<ClaudeConnectCompleted>>
  cancel(accountId: string): Promise<AdminResult<ClaudeConnectCancelled>>
  closeAdmission(): void
  revoke(accountId: string): void
  stop(): Promise<void>
}

export interface ClaudeConnectDeps {
  readonly shutdownDrainMs?: number
  readonly accounts: Pick<AccountRepository, "findById" | "confirmAccountAuthorization">
  /** Postgres-backed claim, shared by every replica: a local map cannot fence a paste landing elsewhere. */
  readonly claims?: Pick<PendingClaudeLoginRepository, "claim" | "find" | "clear">
  readonly owner?: () => string
  readonly leaseToken?: (accountId: string) => ReplicaLeaseToken | undefined
  /** Test-only: a no-lease replica may start a login when there is no shared lease in play. */
  readonly allowUnleasedBegin?: boolean
  readonly configDirs: AccountConfigDirs
  readonly login: ClaudeCliLogin
  readonly credentials: CredentialGuard
  readonly audit: AuditRecorder
  readonly pendingLoginMinutes: number
  readonly logger?: Logger
  readonly now: () => Date
  readonly health?: Pick<HealthStore, "reset">
  readonly refreshCatalog?: () => Promise<void>
  readonly onConnected?: (accountId: string) => void
}
