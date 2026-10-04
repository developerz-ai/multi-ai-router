import { RequestTooLargeError } from "@multi-ai-router/core"
export interface JsonBodyOptions {
  readonly maximumBytes: number
}
/** Content-Length is only an early hint; streamed bytes are authoritative. */
export async function readBoundedJsonBody(
  request: Request,
  { maximumBytes }: JsonBodyOptions,
): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new Error("invalid JSON body ceiling")
  const signal = request.signal
  signal.throwIfAborted()
  const tooLarge = () => new RequestTooLargeError("Request body exceeds the configured limit")
  const length = request.headers.get("content-length")?.trim()
  if (length !== undefined && /^\d+$/.test(length) && BigInt(length) > BigInt(maximumBytes)) {
    void request.body?.cancel(tooLarge()).catch(() => {})
    throw tooLarge()
  }
  if (request.body === null) return null
  const reader = request.body.getReader()
  let buffer = new Uint8Array(Math.min(maximumBytes, 1024))
  let bytes = 0
  try {
    for (;;) {
      const chunk = await readChunk(reader, signal)
      signal.throwIfAborted()
      if (chunk.done) break
      if (chunk.value.byteLength > maximumBytes - bytes) {
        void reader.cancel(tooLarge()).catch(() => {})
        throw tooLarge()
      }
      const nextBytes = bytes + chunk.value.byteLength
      if (nextBytes > buffer.byteLength) {
        const expanded = new Uint8Array(
          Math.min(maximumBytes, Math.max(nextBytes, buffer.byteLength * 2)),
        )
        expanded.set(buffer.subarray(0, bytes))
        buffer = expanded
      }
      buffer.set(chunk.value, bytes)
      bytes = nextBytes
    }
    try {
      return JSON.parse(new TextDecoder().decode(buffer.subarray(0, bytes)))
    } catch {
      return null
    }
  } finally {
    reader.releaseLock()
  }
}

type BodyChunk =
  | { readonly done: true; readonly value?: Uint8Array }
  | { readonly done: false; readonly value: Uint8Array }
interface BodyReader {
  read(): Promise<BodyChunk>
  cancel(reason?: unknown): Promise<void>
}
/** At most one abort listener/read promise is retained, regardless of chunk count. */
async function readChunk(reader: BodyReader, signal: AbortSignal): Promise<BodyChunk> {
  let abort: () => void = () => {}
  try {
    return await new Promise<BodyChunk>((resolve, reject) => {
      abort = () => {
        reject(signal.reason)
        void reader.cancel(signal.reason).catch(() => {})
      }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) {
        abort()
        return
      }
      reader.read().then(resolve, reject)
    })
  } finally {
    signal.removeEventListener("abort", abort)
  }
}
