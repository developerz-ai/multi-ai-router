import { AdminMutationConflictError } from "@multi-ai-router/db"
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
    throw error
  }
}
