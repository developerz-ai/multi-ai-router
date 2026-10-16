import { describeRedacted, redactValue } from "../../logging/redact"
import type { DiscordDelivery } from "./discord-render"

/**
 * The webhook POST itself (issue #229), split from the delivery state machine so this file owns
 * exactly one thing: turn a rendered delivery into one multipart request and classify the answer.
 *
 * The webhook URL is a credential: it is only ever the fetch destination, and every message this
 * file returns is scrubbed — a fetch error's message and a Discord error body are the two places
 * the URL likes to appear, and the redactor knows webhook URLs by shape.
 */

export interface PostTarget {
  readonly webhookUrl: string
  readonly timeoutMs: number
  readonly fetchImpl: typeof globalThis.fetch
}

export type PostOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryable: boolean; readonly message: string }

/** Bounded chars of Discord's own error body kept in the message ("404: Unknown Webhook"). */
const SNIPPET_MAX_CHARS = 200

export async function postDelivery(
  rendered: DiscordDelivery,
  target: PostTarget,
): Promise<PostOutcome> {
  // Discord's webhook-execute multipart form: `payload_json` carries the JSON body and `files[0]`
  // the attachment, joined to `attachments[0].id` in the payload (developer docs, "Sending
  // attachments"). If Discord renames these fields the post 400s terminally, the row lands in
  // `failed` with the reason, and one capture names it — nothing retries forever.
  const form = new FormData()
  form.append("payload_json", rendered.payloadJson)
  form.append("files[0]", new File([rendered.csvBody], rendered.csvFilename, { type: "text/csv" }))
  try {
    const response = await target.fetchImpl(target.webhookUrl, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(target.timeoutMs),
    })
    if (response.ok) return { ok: true }
    const snippet = await response
      .text()
      // Redacted before the cap, `describeRedacted`'s rule: slicing first can cut a webhook URL
      // into a fragment no redaction shape matches, and the head — scheme, host, path — of a
      // credential would survive into `last_error`, log lines and Sentry.
      .then((text) => redactValue(text).slice(0, SNIPPET_MAX_CHARS).trim())
      .catch(() => "")
    const message = `discord webhook answered ${response.status}${snippet === "" ? "" : `: ${snippet}`}`
    return {
      ok: false,
      // 429 (rate limited) and 5xx (Discord-side) are clock-recoverable; any other 4xx means the
      // webhook is gone or the payload is wrong, and retrying cannot help.
      retryable: response.status === 429 || response.status >= 500,
      message,
    }
  } catch (error) {
    // Network failure, DNS failure or our own timeout: temporary, retried on a later tick.
    return { ok: false, retryable: true, message: describeRedacted(error) }
  }
}
