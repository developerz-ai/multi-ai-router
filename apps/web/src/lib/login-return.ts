import { safeNextPath } from "./routes"

const KEY = "mar.loginReturn"

/**
 * Where single sign-on should land. The provider's round trip leaves this page and its callback
 * always answers `/`, so the destination waits in this tab. `/` never overwrites one already kept:
 * a refused sign-in comes back without its `next`, and the retry still belongs where it started.
 */
export function rememberReturn(path: string): void {
  if (path === "/") return
  try {
    sessionStorage.setItem(KEY, path)
  } catch {
    // Blocked storage costs the deep link, never the sign-in.
  }
}

/** The kept destination, once, held to the same same-origin rule as `?next=`. `/` when none. */
export function takeReturn(): string {
  try {
    const kept = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
    return safeNextPath(kept ?? undefined)
  } catch {
    return "/"
  }
}
