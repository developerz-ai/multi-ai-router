/**
 * A tab opened before a release asks for chunks the new build no longer serves; Vite reports that
 * as `vite:preloadError`. Reloading once picks up the new build. Reloading again within the guard
 * window would loop on a chunk that is genuinely broken, so then the error is left to the screen's
 * error boundary, which offers the reload as a button instead.
 */
export const STALE_RELOAD_KEY = "mar.staleChunkReloadAt"
export const STALE_RELOAD_GUARD_MS = 60_000

export interface StaleBundleDeps {
  readonly storage: Pick<Storage, "getItem" | "setItem"> | null
  readonly reload: () => void
  readonly nowMs: () => number
}

/** Returns whether it reloaded. The caller cancels the event when it did. */
export function reloadForStaleChunk(deps: StaleBundleDeps): boolean {
  const now = deps.nowMs()
  const last = Number(readItem(deps.storage))
  if (Number.isFinite(last) && last > 0 && now - last < STALE_RELOAD_GUARD_MS) return false
  // Without storage there is no loop guard, so no automatic reload either.
  if (!writeItem(deps.storage, String(now))) return false
  deps.reload()
  return true
}

function readItem(storage: StaleBundleDeps["storage"]): string | null {
  try {
    return storage?.getItem(STALE_RELOAD_KEY) ?? null
  } catch {
    // Storage blocked (private window, disabled site data): treated as no earlier reload.
    return null
  }
}

function writeItem(storage: StaleBundleDeps["storage"], value: string): boolean {
  if (storage === null) return false
  try {
    storage.setItem(STALE_RELOAD_KEY, value)
    return true
  } catch {
    return false
  }
}

/** Installs the listener. `sessionStorage` scopes the guard to this tab. */
export function installStaleBundleReload(): void {
  window.addEventListener("vite:preloadError", (event) => {
    const reloaded = reloadForStaleChunk({
      storage: sessionStorageOrNull(),
      reload: () => window.location.reload(),
      nowMs: () => Date.now(),
    })
    if (reloaded) event.preventDefault()
  })
}

function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}
