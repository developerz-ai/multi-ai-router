/**
 * A success body read with a ceiling. The background reads here — a model listing, a plan-usage
 * reading — answer from an operator-typed base URL, a proxy or a captive portal as readily as from
 * the vendor, and only the attempt timeout bounded them: a body that streams hundreds of megabytes
 * inside it was buffered whole, then parsed, every hour, per such account (sweep 101, 04.6). Error
 * bodies already have their cap (`UPSTREAM_ERROR_MAX_BYTES`); this is the success side's.
 */

/**
 * The default ceiling. OpenRouter's listing — the largest known — is about 1 MB; 8 MB leaves room
 * for growth while refusing a runaway. Config, injected by the caller (`MODEL_LISTING_MAX_BYTES`).
 */
export const DEFAULT_LISTING_MAX_BYTES = 8 * 1024 * 1024

export type CappedJson =
  | { readonly ok: true; readonly value: unknown }
  /** `too-large`: the body passed the ceiling, and the read was cancelled there. */
  | { readonly ok: false; readonly reason: "too-large" | "unparsable" }

export async function readJsonCapped(response: Response, maxBytes: number): Promise<CappedJson> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    return { ok: false, reason: "too-large" }
  }
  const reader = response.body?.getReader()
  if (reader === undefined) return { ok: false, reason: "unparsable" }

  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      // Cancelling is the point: it closes the socket instead of draining the rest to discard it.
      await reader.cancel().catch(() => undefined)
      return { ok: false, reason: "too-large" }
    }
    chunks.push(value)
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }
  } catch {
    return { ok: false, reason: "unparsable" }
  }
}
