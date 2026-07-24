/**
 * Copy to clipboard, with the failure surfaced rather than swallowed.
 *
 * `navigator.clipboard` is unavailable on an insecure origin and can be refused
 * by permission policy. A copy button that silently does nothing is worse than
 * one that says it could not — the operator would paste the *previous* clipboard
 * contents into a client config and debug an authentication failure.
 */
export async function copyText(value: string): Promise<boolean> {
  if (typeof navigator === "undefined" || navigator.clipboard === undefined) return false
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}
