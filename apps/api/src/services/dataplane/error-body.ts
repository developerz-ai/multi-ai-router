import { isSecretFieldName, REDACTED, redactValue } from "../../logging/redact"

export const DEFAULT_UPSTREAM_ERROR_MAX_BYTES = 65_536

/** Failure bodies are untrusted and may be infinite. Never retain more than the configured cap. */
export async function readErrorBody(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) {
        void reader.cancel().catch(() => {})
        // A prefix could end halfway through a secret. Return no upstream text when truncated.
        return JSON.stringify({
          error: { message: "Upstream error body exceeded the configured limit" },
        })
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return new TextDecoder().decode(bytes)
  } catch {
    return ""
  } finally {
    reader.releaseLock()
  }
}

export function redactAttemptText(text: string, secret: string | null): string {
  const exact = secret ? text.replaceAll(secret, REDACTED) : text
  return redactValue(exact)
}

/** Decode JSON strings before redaction so escaped opaque credentials cannot evade matching. */
export function sanitizeErrorBody(text: string, secret: string | null = null): string {
  const scrub = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return redactAttemptText(value, secret)
    if (value === null || typeof value !== "object") return value
    if (depth >= 32) return REDACTED
    if (Array.isArray(value)) return value.map((entry) => scrub(entry, depth + 1))
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        redactAttemptText(key, secret),
        // Error codes and diagnostic bodies are protocol fields, not OAuth one-shots/prompts here.
        !["code", "body", "messages"].includes(key.toLowerCase()) && isSecretFieldName(key)
          ? REDACTED
          : scrub(entry, depth + 1),
      ]),
    )
  }
  try {
    return JSON.stringify(scrub(JSON.parse(text), 0))
  } catch {
    return redactAttemptText(text, secret)
  }
}
