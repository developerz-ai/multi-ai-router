export async function readRelayBody(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
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
      chunks.push(value)
      total += value.length
    }
  } finally {
    signal?.removeEventListener("abort", abort)
    reader.releaseLock()
  }

  if (chunks.length === 1 && chunks[0] !== undefined) return chunks[0]
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  return bytes
}
