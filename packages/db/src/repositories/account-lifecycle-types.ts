import type { AccountStatus, ProviderId } from "@multi-ai-router/core"
import type { AccountRow } from "../schema/accounts"
import type { OauthStateRow } from "../schema/oauth-states"
import type { UpdateAccountInput } from "./account-types"

export interface AccountObservation {
  /** Undefined retains legacy observation behavior; null fences absence of a recovery row. */
  readonly recoveryGeneration?: string | null
  readonly lifecycleVersion: number
  readonly authMaterial: string | null
  readonly status: AccountStatus
}
export interface AccountLifecycleMethods {
  saveRefreshedCredential(input: {
    id: string
    expectedAuthMaterial: string
    authMaterial: string
    tokenExpiresAt: Date | null
    now: Date
  }): Promise<AccountRow | undefined>
  transitionObservedStatus(input: {
    id: string
    expected: AccountObservation
    status: AccountStatus
    now: Date
  }): Promise<AccountRow | undefined>
  updateOperatorAccount(input: {
    id: string
    patch: UpdateAccountInput
    now: Date
  }): Promise<AccountRow | undefined>
  recheckAccount(input: { id: string; now: Date }): Promise<
    | {
        account: AccountRow
        clearedStatus: "exhausted" | null
      }
    | undefined
  >
  recoverObservedAuthentication(input: {
    id: string
    expected: AccountObservation & { status: "needs_reauth" }
    now: Date
  }): Promise<AccountRow | undefined>
  /** Successful CLI completion fences operator intent; background status may change without L. */
  confirmAccountAuthorization(input: {
    id: string
    expected: Pick<AccountObservation, "lifecycleVersion" | "authMaterial">
    now: Date
  }): Promise<AccountRow | undefined>
}
export interface AccountAuthorizationMethods {
  beginAccountAuthorization(input: {
    id: string
    expectedProvider: ProviderId
    attempt: {
      id: string
      state: string
      /** Already encrypted by caller. */
      codeVerifier: string
      redirectUri: string
      expiresAt: Date
    }
    now: Date
  }): Promise<{ account: AccountRow; pending: OauthStateRow } | undefined>
  cancelAccountAuthorization(input: { id: string; now: Date }): Promise<
    | {
        account: AccountRow
        cancelled: boolean
      }
    | undefined
  >
  commitAuthorization(input: {
    id: string
    expectedLifecycleVersion: number
    attemptId: string
    /** Already encrypted by caller. */
    authMaterial: string
    tokenExpiresAt: Date | null
    now: Date
  }): Promise<AccountRow | undefined>
}

/** These methods extend existing AccountRepository, rather than replacing ordinary methods. */
export type AddedAccountRepositoryMethods = AccountLifecycleMethods & AccountAuthorizationMethods
