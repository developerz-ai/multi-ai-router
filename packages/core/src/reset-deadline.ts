/** A shared conservative retry default when no provider reset was reported. */
export const DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS = 30

/** All applicable reset constraints must have passed; never return an invalid or elapsed deadline. */
export function latestResetDeadline(
  facts: { readonly resetsAt?: Date; readonly retryAfterSeconds?: number },
  now: Date,
): Date | null {
  const absolute = facts.resetsAt?.getTime()
  const seconds = facts.retryAfterSeconds
  const relative =
    seconds !== undefined && Number.isFinite(seconds) && seconds > 0
      ? now.getTime() + seconds * 1000
      : undefined
  const deadlines = [absolute, relative].filter(
    (value): value is number =>
      value !== undefined && Number.isFinite(value) && value > now.getTime() && value <= 8.64e15,
  )
  return deadlines.length === 0 ? null : new Date(Math.max(...deadlines))
}
