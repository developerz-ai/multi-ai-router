import { z } from "zod"
import { type DeclaredTool, readToolList } from "./tools"

/**
 * The Anthropic Messages request, read **once**, as the four things a `query()` launch needs from it.
 *
 * This is the labeled exception to "never parse a passthrough body" (CLAUDE.md non-negotiable 8):
 * the SDK is handed a prompt and a set of options, not bytes, so there is nothing to forward and the
 * body has to be decoded. What the exception buys is bounded by decoding it **once** — the prompt,
 * the tool registration, the system prompt, and the response shape all come out of this single pass
 * rather than out of four (`session/conversation.ts` and `tools/register.ts` each document the same
 * rule from their own side).
 *
 * Read loosely on purpose, for the reason `conversation.ts` states: `services/translate` owns the
 * fidelity contract and already refused anything it cannot represent by the time a body reaches
 * here. Re-imposing it would put the same refusal in two layers with the wrong one winning, and a
 * content block this build has never seen must still reach the model as *something* rather than
 * fail a turn (`prompt.ts` decides what).
 *
 * An unreadable body is not an error here either. It yields an empty request, which every consumer
 * already has an honest answer for: no messages is a prompt with nothing in it, no tools is a plain
 * chat turn, and `stream: false` is one JSON object back.
 */

/** A content block as the client sent it. `type` is the only field this layer branches on. */
const blockSchema = z.looseObject({ type: z.string() })

const messageSchema = z.looseObject({
  role: z.string(),
  content: z.union([z.string(), z.array(blockSchema)]),
})

const systemSchema = z.union([z.string(), z.array(z.looseObject({ type: z.string() }))])

const requestSchema = z.looseObject({
  messages: z.array(messageSchema).nullish(),
  system: systemSchema.nullish(),
  tools: z.unknown().optional(),
  stream: z.boolean().nullish(),
})

export type SdkRequestRole = "user" | "assistant"

export interface SdkRequestMessage {
  readonly role: SdkRequestRole
  /** Verbatim: a string body stays a string, blocks stay blocks. `prompt.ts` renders them. */
  readonly content: string | readonly Readonly<Record<string, unknown>>[]
}

export interface SdkRequest {
  readonly messages: readonly SdkRequestMessage[]
  /**
   * The client's own system prompt, flattened to the SDK's `string | string[]` shape.
   *
   * Null when the client sent none, which is *not* the same as an empty one: omitting the option
   * leaves the SDK with no system prompt at all, and that is what a client sending none asked for.
   * The Claude Code preset is deliberately never substituted here — it is a per-Account setting, not
   * a default (docs/idea/11-anthropic-agent-sdk.md §8).
   */
  readonly system: string | readonly string[] | null
  /** The client's toolkit, for `createPassthrough`. Empty means a plain chat turn (§7). */
  readonly tools: readonly DeclaredTool[]
  /** Whether the client asked for SSE. Decides the response shape, never how the SDK is read. */
  readonly stream: boolean
}

const EMPTY: SdkRequest = { messages: [], system: null, tools: [], stream: false }

export function readSdkRequest(body: Uint8Array | null): SdkRequest {
  if (body === null || body.length === 0) return EMPTY

  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return EMPTY
  }

  const result = requestSchema.safeParse(parsed)
  if (!result.success) return EMPTY

  return {
    messages: (result.data.messages ?? []).map(readMessage),
    system: readSystem(result.data.system),
    tools: readToolList(result.data.tools),
    stream: result.data.stream === true,
  }
}

function readMessage(message: z.infer<typeof messageSchema>): SdkRequestMessage {
  // Anthropic's own two roles, and anything else is a client bug. `user` is the safe reading:
  // an unknown role rendered as the assistant's would put words in the model's mouth.
  const role: SdkRequestRole = message.role === "assistant" ? "assistant" : "user"
  return { role, content: message.content }
}

/**
 * Anthropic's `system` is a string or a list of text blocks; the SDK takes a string or a list of
 * strings. A non-text block in that list has no target, so it is dropped rather than rendered —
 * the alternative is inventing system-prompt text the client never wrote.
 */
function readSystem(system: z.infer<typeof systemSchema> | null | undefined): SdkRequest["system"] {
  if (system === null || system === undefined) return null
  if (typeof system === "string") return system.length === 0 ? null : system

  const parts: string[] = []
  for (const block of system) {
    const text: unknown = block.text
    if (block.type === "text" && typeof text === "string" && text.length > 0) parts.push(text)
  }
  return parts.length === 0 ? null : parts
}
