/** Serializes snapshot reads while keeping post-mutation freshness distinct from timer refreshes. */
export function createSnapshotRefresh<T>(load: () => Promise<T>, install: (value: T) => void) {
  let generation = 0
  let installedGeneration = -1
  let inFlight: { readonly generation: number; readonly promise: Promise<void> } | null = null

  const start = () => {
    const startedGeneration = generation
    const promise = Promise.resolve()
      .then(load)
      .then((value) => {
        // A mutation committed during this read. Keep the last good snapshot until its trailing
        // read completes, rather than briefly installing data known to predate that mutation.
        if (startedGeneration !== generation) return
        install(value)
        installedGeneration = startedGeneration
      })
      .finally(() => {
        inFlight = null
      })
    inFlight = { generation: startedGeneration, promise }
    return inFlight
  }

  const afterMutation = async (requiredGeneration: number): Promise<void> => {
    while (installedGeneration < requiredGeneration) {
      const pending = inFlight ?? start()
      try {
        await pending.promise
      } catch (error) {
        // A failed pre-mutation read must not suppress the required trailing read. Failure of
        // the current generation does reject its callers, without erasing the held snapshot.
        if (pending.generation === generation) throw error
      }
    }
  }

  return {
    refresh: (): Promise<void> => (inFlight ?? start()).promise,
    refreshAfterMutation: (): Promise<void> => afterMutation(++generation),
  }
}
