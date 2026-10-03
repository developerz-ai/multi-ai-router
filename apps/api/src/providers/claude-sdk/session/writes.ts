import type { SessionRepository } from "@multi-ai-router/db"

/** Ordered per conversation; invalidated generations never start queued writes. */
export function createSessionWrites(
  repository: Pick<SessionRepository, "upsert">,
  fence: { hold(accountId: string | null): { valid(): boolean; release(): void } },
  onError?: (operation: "read" | "write", error: unknown) => void,
) {
  const pending = new Map<string, Promise<void>>()
  return (key: string, input: Parameters<SessionRepository["upsert"]>[0]) => {
    const lease = fence.hold(input.accountId ?? null)
    const run = async () => {
      if (!lease.valid()) return
      try {
        await repository.upsert(input)
      } catch (error) {
        onError?.("write", error)
      }
    }
    const previous = pending.get(key)
    const tail = previous === undefined ? run() : previous.then(run)
    pending.set(key, tail)
    void tail.finally(() => {
      lease.release()
      if (pending.get(key) === tail) pending.delete(key)
    })
  }
}
