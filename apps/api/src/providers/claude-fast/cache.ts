/**
 * Where the fast transport puts prompt-cache breakpoints. Pure but for the marker it writes onto
 * blocks its caller already copied (`request.ts`): the parsed request is prepared twice on a
 * native-schema retry and must stay unmarked.
 */

interface CacheBlock {
  type: string
  [key: string]: unknown
}

export interface CacheableRequest {
  readonly system: Record<string, unknown>[]
  readonly messages: { role: string; content: string | CacheBlock[] }[]
  readonly tools: unknown
  /** The raw body never names `cache_control`: no walk is needed to know nothing is marked. */
  readonly unmarked: boolean
  /** The client is Claude Code and placed its own breakpoints, including deliberately none. */
  readonly native: boolean
}

/** Anthropic refuses a fifth breakpoint. */
const MAX_BREAKPOINTS = 4

export function placeCacheBreakpoints(request: CacheableRequest): void {
  const { system, messages, tools } = request
  // The prefix first: with it marked, Claude Code's own placement stands and its history, the one
  // part that can be megabytes, is not walked.
  const inPrefix = !request.unmarked && hasCacheControl({ system, tools })
  if (inPrefix && request.native) return
  const inMessages = !request.unmarked && hasCacheControl(messages)
  if (!inMessages && !inPrefix) {
    markUnmarked(system, messages)
    return
  }
  // A client that marks its system prompt and stops there re-reads its whole history uncached on
  // every turn (prod 2026-11-23: 23,181 tokens cached flat while the uncached input grew to 36,177).
  // The client's markers stand; the tail gets one more. Only once the model has answered, so a
  // one-shot never pays a write nobody reads. Five minutes, because a `5m` breakpoint may follow a
  // `5m` or a `1h` one and a `1h` one may not follow a `5m`.
  if (inMessages || request.native) return
  if (countMarked(system) + countMarked(tools) >= MAX_BREAKPOINTS) return
  if (!messages.some((message) => message.role === "assistant")) return
  markTail(messages, { type: "ephemeral" })
}

/** No breakpoint anywhere: native-style `1h` ones on the identity, the system prefix and the tail. */
function markUnmarked(
  system: CacheableRequest["system"],
  messages: CacheableRequest["messages"],
): void {
  const cache = { type: "ephemeral", ttl: "1h" }
  const identity = system[1]
  if (identity) identity.cache_control = cache
  const lastSystem = system.at(-1)
  if (lastSystem && lastSystem.type === "text" && lastSystem.text !== "")
    lastSystem.cache_control = cache
  // Native system breakpoints cache the tools prefix too. Do not spend a breakpoint on tools.
  markTail(messages, cache)
}

function markTail(messages: CacheableRequest["messages"], cache: Record<string, unknown>): void {
  const last = messages.at(-1)
  if (last === undefined) return
  if (typeof last.content === "string") {
    // Anthropic refuses a marker on an empty text block.
    if (last.content === "") return
    last.content = [{ type: "text", text: last.content }]
  }
  const tail = last.content.at(-1)
  if (tail === undefined || tail.type === "thinking" || tail.type === "redacted_thinking") return
  if (tail.type === "text" && tail.text === "") return
  tail.cache_control = cache
}

function countMarked(blocks: unknown): number {
  if (!Array.isArray(blocks)) return 0
  return blocks.filter(
    (block) => typeof block === "object" && block !== null && "cache_control" in block,
  ).length
}

function hasCacheControl(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCacheControl)
  if (value === null || typeof value !== "object") return false
  return Object.entries(value).some(
    ([key, nested]) => key === "cache_control" || hasCacheControl(nested),
  )
}
