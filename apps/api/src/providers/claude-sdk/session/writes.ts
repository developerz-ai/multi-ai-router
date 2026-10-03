import type { SessionRepository } from "@multi-ai-router/db"

/** Ordered per conversation; invalidated generations never start queued writes. */
export function createSessionWrites(
  repository: Pick<SessionRepository, "upsert">,
  current: () => number,
  onError?: (operation: "read" | "write", error: unknown) => void,
) {
  const pending = new Map<string, Promise<void>>()
  return (key: string, input: Parameters<SessionRepository["upsert"]>[0]) => {
    const generation = current()
    const run = async () => {
      if (current() !== generation) return
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
      if (pending.get(key) === tail) pending.delete(key)
    })
  }
}
