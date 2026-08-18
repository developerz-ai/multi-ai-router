import { z } from "zod"
import {
  anthropicToolChoiceSchema,
  type ParsedAnthropicToolChoice,
} from "../../services/translate/shared/anthropic"
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
  // Unknown on purpose, like `tools` above: the shape decision is `readToolChoice`'s alone, so a
  // `tool_choice` this build does not recognize costs the *field* — never, via a failed object
  // parse, the whole request (messages, system, and tools with it).
  tool_choice: z.unknown().optional(),
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
  /**
   * The client's `tool_choice`, or null for a client that sent none — or sent one this build cannot
   * recognize, which is the same thing here — and absence is `"auto"` in every way that matters
   * (the SDK has no forcing knob of its own; `auto` and absence both mean "register everything, let
   * the model choose"). `"none"`, `"any"`, and `"tool"` each change what `createPassthrough`
   * registers and, for a non-streaming turn, whether the invoker refuses a turn that never produced
   * the forced call (`tools/register.ts`, docs/idea/11-anthropic-agent-sdk.md §7 item 9). The one
   * unrecognized shape that is *not* null is the near miss — a recognized `type` whose payload the
   * schema refuses — which `readToolChoice` throws on rather than degrade.
   */
  readonly toolChoice: ParsedAnthropicToolChoice | null
}

const EMPTY: SdkRequest = {
  messages: [],
  system: null,
  tools: [],
  stream: false,
  toolChoice: null,
}

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
    toolChoice: readToolChoice(result.data.tool_choice),
  }
}

/** The variants `anthropicToolChoiceSchema` discriminates on — the near-miss test's vocabulary. */
const KNOWN_TOOL_CHOICE_TYPES: ReadonlySet<string> = new Set(["auto", "any", "none", "tool"])

/**
 * The client's `tool_choice`, read as loosely as the rest of the body: a shape this build has
 * never seen — a foreign variant, or an explicit `null`, which is a common wire spelling of "no
 * preference" — is the *field's* absence, never the request's. The same rule `readToolList` applies
 * to `tools`, for the reason the module header gives: a choice shape this build has never seen must
 * still run as an `"auto"`-shaped turn rather than fail the whole conversation.
 *
 * The near miss is the one exception. A `type` this vocabulary recognizes carrying a payload the
 * schema refuses — `{"type":"tool"}` without its `name`, a `name` that is not a string — is a
 * client that *tried* to force a call and got the shape wrong, and Anthropic's own API answers it
 * `400`. Degrading that to `"auto"` would be the silent downgrade this issue exists to kill in its
 * most invisible form: nothing visibly changes, the turn just runs optional. So it throws the same
 * client-`400` family `tools/register.ts` already throws (`errors.ts`
 * `claude-sdk:tool-choice-unsatisfiable`).
 */
function readToolChoice(value: unknown): ParsedAnthropicToolChoice | null {
  const result = anthropicToolChoiceSchema.safeParse(value)
  if (result.success) return result.data

  const type = recognizedToolChoiceType(value)
  if (type === null) return null

  // The sentence's tail is load-bearing: `errors.ts` matches it to classify this refusal as
  // `invalid-request` (a client `400`), never as an account failure. The type literal is echoed
  // rather than the payload — it is one of four known words, and a failed payload is
  // client-supplied bytes of unbounded shape.
  throw new Error(
    `tool_choice's type "${type}" is recognized but its payload is one this router cannot read`,
  )
}

/**
 * The failed parse's `type`, when it is a variant this vocabulary knows — the one signal that
 * separates a misspelt known shape (a near miss) from a shape this build never knew (foreign).
 */
function recognizedToolChoiceType(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null
  const type: unknown = Reflect.get(value, "type")
  return typeof type === "string" && KNOWN_TOOL_CHOICE_TYPES.has(type) ? type : null
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
