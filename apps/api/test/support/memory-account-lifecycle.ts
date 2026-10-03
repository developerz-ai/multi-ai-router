import type { AccountRepository, AccountRow, OauthStateRow } from "@multi-ai-router/db"

type Methods = Pick<
  AccountRepository,
  | "saveRefreshedCredential"
  | "transitionObservedStatus"
  | "updateOperatorAccount"
  | "recheckAccount"
  | "recoverObservedAuthentication"
  | "confirmAccountAuthorization"
  | "beginAccountAuthorization"
  | "cancelAccountAuthorization"
  | "commitAuthorization"
>
type Observation = Pick<AccountRow, "lifecycleVersion" | "authMaterial" | "status">

/** Compare and replace synchronously: these tests must model the database CAS, not read/write races. */
export function memoryAccountLifecycle(rows: AccountRow[], states: OauthStateRow[]): Methods {
  const find = (id: string) => rows.find((row) => row.id === id)
  const matches = (row: AccountRow | undefined, expected: Observation): row is AccountRow =>
    row !== undefined &&
    row.lifecycleVersion === expected.lifecycleVersion &&
    row.authMaterial === expected.authMaterial &&
    row.status === expected.status
  const write = (row: AccountRow, patch: Partial<AccountRow>, now: Date): AccountRow => {
    const next = {
      ...row,
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
      updatedAt: now,
    }
    rows[rows.indexOf(row)] = next
    return next
  }
  const retire = (id: string, now: Date) => {
    let count = 0
    for (const state of states) {
      if (state.accountId !== id || state.consumedAt !== null) continue
      state.consumedAt = now
      count += 1
    }
    return count
  }
  const confirm: Methods["confirmAccountAuthorization"] = async ({ id, expected, now }) => {
    const row = find(id)
    if (
      row === undefined ||
      row.lifecycleVersion !== expected.lifecycleVersion ||
      row.authMaterial !== expected.authMaterial
    )
      return undefined
    return write(
      row,
      {
        lifecycleVersion: row.lifecycleVersion + 1,
        authRecoveryVersion: row.authRecoveryVersion + 1,
        status: row.status === "needs_reauth" ? "active" : row.status,
      },
      now,
    )
  }
  return {
    saveRefreshedCredential: async ({
      id,
      expectedAuthMaterial,
      authMaterial,
      tokenExpiresAt,
      now,
    }) => {
      const row = find(id)
      if (row === undefined || row.authMaterial !== expectedAuthMaterial) return undefined
      return write(row, { authMaterial, tokenExpiresAt }, now)
    },
    transitionObservedStatus: async ({ id, expected, status, now }) => {
      const row = find(id)
      if (!matches(row, expected) || status === expected.status) return undefined
      return write(row, { status }, now)
    },
    updateOperatorAccount: async ({ id, patch, now }) => {
      const row = find(id)
      if (row === undefined) return undefined
      const credential = patch.authMaterial !== undefined
      const intent = credential || patch.status !== undefined
      return write(
        row,
        {
          ...patch,
          ...(credential
            ? {
                tokenExpiresAt: patch.tokenExpiresAt ?? null,
                authRecoveryVersion: row.authRecoveryVersion + 1,
              }
            : {}),
          ...(intent
            ? { lifecycleVersion: row.lifecycleVersion + 1, authorizationAttemptId: null }
            : {}),
          ...(patch.status === "active"
            ? { healthRecoveryVersion: row.healthRecoveryVersion + 1 }
            : {}),
        },
        now,
      )
    },
    recheckAccount: async ({ id, now }) => {
      const row = find(id)
      if (row === undefined) return undefined
      const clearedStatus = row.status === "exhausted" ? ("exhausted" as const) : null
      return {
        account: write(
          row,
          {
            lifecycleVersion: row.lifecycleVersion + 1,
            healthRecoveryVersion: row.healthRecoveryVersion + 1,
            status: clearedStatus === null ? row.status : "active",
          },
          now,
        ),
        clearedStatus,
      }
    },
    recoverObservedAuthentication: (input) => {
      if (!matches(find(input.id), input.expected) || input.expected.status !== "needs_reauth")
        return Promise.resolve(undefined)
      return confirm(input)
    },
    confirmAccountAuthorization: confirm,
    beginAccountAuthorization: async ({ id, expectedProvider, attempt, now }) => {
      const row = find(id)
      if (row === undefined || row.provider !== expectedProvider) return undefined
      // Unique constraints fail before any mutation, matching transaction rollback.
      if (states.some((state) => state.id === attempt.id || state.state === attempt.state)) {
        throw new Error("duplicate authorization attempt")
      }
      retire(id, now)
      const pending: OauthStateRow = {
        ...attempt,
        provider: expectedProvider,
        accountId: id,
        authorizationLifecycleVersion: row.lifecycleVersion,
        nonce: null,
        consumedAt: null,
        createdAt: now,
      }
      states.push(pending)
      return { account: write(row, { authorizationAttemptId: attempt.id }, now), pending }
    },
    cancelAccountAuthorization: async ({ id, now }) => {
      const row = find(id)
      if (row === undefined) return undefined
      const cancelled = retire(id, now) > 0 || row.authorizationAttemptId !== null
      return { account: write(row, { authorizationAttemptId: null }, now), cancelled }
    },
    commitAuthorization: async ({
      id,
      expectedLifecycleVersion,
      attemptId,
      authMaterial,
      tokenExpiresAt,
      now,
    }) => {
      const row = find(id)
      if (
        row === undefined ||
        row.lifecycleVersion !== expectedLifecycleVersion ||
        row.authorizationAttemptId !== attemptId
      )
        return undefined
      return write(
        row,
        {
          authMaterial,
          tokenExpiresAt,
          authorizationAttemptId: null,
          lifecycleVersion: row.lifecycleVersion + 1,
          authRecoveryVersion: row.authRecoveryVersion + 1,
          status: row.status === "needs_reauth" ? "active" : row.status,
        },
        now,
      )
    },
  }
}
