/** Only references validated by admin key/pool mutations qualify as deletion races. */
const REFERENCE_CONSTRAINTS = new Set([
  "api_key_pools_pool_id_pools_id_fk",
  "api_key_accounts_account_id_accounts_id_fk",
  "pool_members_account_id_accounts_id_fk",
  "pools_overflow_account_id_accounts_id_fk",
])

export class AdminMutationConflictError extends Error {
  constructor() {
    super("A referenced account or pool was deleted during this edit. Reload and retry.")
    this.name = "AdminMutationConflictError"
  }
}

function postgresFailure(error: unknown): { code: string; constraint?: string } | undefined {
  if (typeof error !== "object" || error === null) return undefined
  if ("code" in error && typeof error.code === "string") {
    return {
      code: error.code,
      ...("constraint_name" in error && typeof error.constraint_name === "string"
        ? { constraint: error.constraint_name }
        : {}),
    }
  }
  return "cause" in error ? postgresFailure(error.cause) : undefined
}

/** The whole transaction rolls back before retry; callbacks must contain only database work. */
export async function withAdminMutationRetry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work()
    } catch (error) {
      const failure = postgresFailure(error)
      if (failure?.code === "40P01" && attempt < 2) continue
      if (
        failure?.code === "23503" &&
        failure.constraint !== undefined &&
        REFERENCE_CONSTRAINTS.has(failure.constraint)
      ) {
        throw new AdminMutationConflictError()
      }
      throw error
    }
  }
}
