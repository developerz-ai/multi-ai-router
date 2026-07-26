/**
 * Which call a `delta.tool_calls[]` entry belongs to.
 *
 * openai-chat keys a streamed call by an `index` that counts only calls, and every dialect
 * translated *out* of it needs that key to route argument fragments to the block or item the call
 * opened. The field is required by the OpenAI schema and **is not always sent**: LM Studio and Ollama
 * stream a call per chunk with no `index` at all, and a reader that falls back to the entry's
 * position inside its own chunk gives every one of them key `0` — collapsing several distinct calls
 * into one block whose arguments are two JSON documents concatenated.
 *
 * `openai-responses-to-anthropic/stream.ts` already solved this for its own dialect with an ordinal
 * counter for unkeyed items; this is that answer, stated once, for the openai-chat reading. The
 * distinction it has to make and Responses does not is between a *new* unkeyed call and a
 * *continuation* of one, because openai-chat streams arguments as further entries in the same array:
 *
 * - an entry naming an `id` or a function `name` introduces a call, and gets an ordinal of its own;
 * - an entry naming neither carries arguments for the call the last entry addressed;
 * - an entry naming an `index` is keyed by it, always, whatever it said before.
 *
 * The ordinals are strings (`call#1`) so they can never collide with an `index` an upstream that
 * states some of them sends.
 */

export interface OpenAiChatToolCallDelta {
  readonly index?: number | null | undefined
  readonly id?: string | null | undefined
  readonly function?:
    | {
        readonly name?: string | null | undefined
        readonly arguments?: string | null | undefined
      }
    | null
    | undefined
}

export interface OpenAiChatToolCallReader {
  key(call: OpenAiChatToolCallDelta): string | number
}

function names(call: OpenAiChatToolCallDelta): boolean {
  const id = call.id ?? ""
  const name = call.function?.name ?? ""
  return id.length > 0 || name.length > 0
}

export function createOpenAiChatToolCallReader(): OpenAiChatToolCallReader {
  let unkeyed = 0
  let last: string | number | null = null

  function mint(): string {
    unkeyed += 1
    last = `call#${unkeyed}`
    return last
  }

  return {
    key(call) {
      if (typeof call.index === "number") {
        last = call.index
        return call.index
      }
      if (names(call)) return mint()
      // Arguments for a call nobody has introduced yet: an upstream that streams them without ever
      // naming a function is broken, and an unnamed call of its own says so, where folding them into
      // whatever came last would answer as though the model had called something else.
      return last ?? mint()
    },
  }
}
