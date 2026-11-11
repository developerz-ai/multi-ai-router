import { TranslationStreamError } from "../translate/shared/stream-error"

/**
 * Default ceiling on an upstream body the router must read whole (a translated non-stream answer,
 * a forced Responses stream, a forced-tool answer): `UPSTREAM_BUFFERED_BODY_MAX_BYTES`. Unbounded,
 * a misbehaving endpoint streaming forever held memory until the attempt's total deadline
 * (plan 101, 02.9).
 */
export const DEFAULT_BUFFERED_BODY_MAX_BYTES = 32 * 1024 * 1024

/** The upstream body outgrew the buffered-read ceiling; the relay fails honestly. */
export function bufferedBodyTooLarge(maxBytes: number): TranslationStreamError {
  return new TranslationStreamError(
    "translation_protocol_error",
    `upstream body exceeded the ${maxBytes}-byte limit for a response the router must read whole`,
  )
}

export async function readRelayBody(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  maxBytes: number = DEFAULT_BUFFERED_BODY_MAX_BYTES,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = stream.getReader()
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => {})
  }
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) abort()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      if (value === undefined) continue
      total += value.length
      if (total > maxBytes) {
        const error = bufferedBodyTooLarge(maxBytes)
        void reader.cancel(error).catch(() => {})
        throw error
      }
      chunks.push(value)
    }
  } finally {
    signal?.removeEventListener("abort", abort)
    reader.releaseLock()
  }
  return join(chunks, total)
}

export function join(chunks: readonly Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1 && chunks[0] !== undefined) return chunks[0]
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  return bytes
}
