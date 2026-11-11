import { AdminMutationConflictError, ApiKeyNameTakenError } from "@multi-ai-router/db"
import { type AdminResult, conflict } from "./result"

export async function mutationResult<T>(
  work: () => Promise<AdminResult<T>>,
): Promise<AdminResult<T>> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof AdminMutationConflictError) {
      return conflict(error.message, "reference_deleted")
    }
    // The unique index decides a name race; the loser is told the same as a plain clash.
    if (error instanceof ApiKeyNameTakenError) {
      return conflict(`a key named "${error.keyName}" already exists`)
    }
    throw error
  }
}
