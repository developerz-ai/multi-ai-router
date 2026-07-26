import type {
  HookCallbackMatcher,
  HookEvent,
  McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { isPermittedTool } from "../allowlist"
import { type CapturedToolCall, createEarlyStop, type ToolIntegrity } from "./early-stop"
import { PASSTHROUGH_SERVER_NAME } from "./names"
import { createPassthroughServer, passthroughToolDefinition } from "./passthrough"
import { createToolRewriter } from "./rewrite"
import { readToolSchema, type ToolSchema } from "./schema"

/**
 * Which of the client's tools are registered, **in what order**, and how the pieces are handed to a
 * `query()` launch.
 *
 * **Order is not cosmetic.** The registered catalogue is rendered into the SDK's system prompt in
 * registration order, and a system prompt that differs by one line is a prompt-cache miss on the
 * *whole* prefix — every turn, for every client whose tool list arrives in a different order than
 * last time (docs/idea/11-anthropic-agent-sdk.md §7). Clients do reorder: a tool map iterated from a
 * hash, a plugin list loaded concurrently. So registration is sorted by name, by code point, with no
 * locale in it — the same set of tools always produces the same prompt.
 *
 * **Duplicates keep the first declaration.** Anthropic rejects a duplicate tool name outright, so
 * this only fires on a client that got it wrong; keeping the first is deterministic, and it means
 * the choice does not depend on where in the array the duplicate happened to land.
 *
 * **Deferred loading is described here and not enabled today, on purpose.** Above roughly fifteen
 * tools the SDK can keep the tail out of the prompt and let the model pull it in through
 * `ToolSearch`, at the cost of one extra turn. `ToolSearch` is a tool that must be permitted to
 * *run on this host*, and `allowlist.ts` — the one reviewed constant that decides that — names
 * nothing. So the threshold is honoured only when the allowlist grants it, and every tool is
 * otherwise kept loaded. Deferring behind a search the model may not call would hide the tail from
 * it entirely, which is worse than a long prompt (docs/idea/07-security.md).
 *
 * A client that sent no tools gets **none of this**: no MCP server, no hook, no stream wrapper. A
 * plain chat request must not pay for machinery that exists to bound a tool loop (§8).
 */

/** Above this many registered tools, the tail may be deferred behind `ToolSearch` — if permitted. */
export const DEFER_LOADING_THRESHOLD = 15

/** The SDK tool the deferred tail is loaded through. Named here, granted only in `allowlist.ts`. */
export const TOOL_SEARCH = "ToolSearch"

/**
 * A tool as an Anthropic Messages body declares it. Read loosely on purpose: `services/translate`
 * owns the fidelity contract for a tool declaration, and re-imposing it here would put the same
 * refusal in two layers — with the wrong one winning (`session/conversation.ts` makes the same call).
 */
const declaredToolSchema = z.looseObject({
  name: z.string(),
  description: z.string().nullish(),
  input_schema: z.unknown().optional(),
  /** Anthropic's own per-tool deferral opt-in. The client's decision, honoured over ours. */
  defer_loading: z.boolean().nullish(),
})

const toolsSchema = z.looseObject({ tools: z.array(declaredToolSchema).nullish() })

export type DeclaredTool = z.infer<typeof declaredToolSchema>

export interface Passthrough {
  /** Merge into `Options.mcpServers`. */
  readonly mcpServers: Record<string, McpSdkServerConfigWithInstance>
  /** Merge into `Options.hooks`. */
  readonly hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>
  /** Wrap the SDK's message stream with this before handing it to the renderer. */
  filter(messages: AsyncIterable<unknown>): AsyncIterable<unknown>
  /** The registered names, in registration order. Diagnostics; nothing routes on it. */
  readonly registered: readonly string[]
  readonly captures: readonly CapturedToolCall[]
  integrity(): ToolIntegrity
}

export interface PassthroughInput {
  readonly tools: readonly DeclaredTool[]
  /** Terminates the subprocess, for an early stop. */
  readonly abort?: () => void
}

/**
 * @returns null when the client declared no tools — the signal to launch without passthrough at all.
 */
export function createPassthrough(input: PassthroughInput): Passthrough | null {
  const ordered = orderForRegistration(input.tools)
  if (ordered.length === 0) return null

  const deferrable = ordered.length > DEFER_LOADING_THRESHOLD && isPermittedTool(TOOL_SEARCH)
  const schemas = new Map<string, ToolSchema>()
  const definitions = ordered.map((declared, position) => {
    const schema = readToolSchema(declared.input_schema)
    schemas.set(declared.name, schema)
    return passthroughToolDefinition({
      name: declared.name,
      description: declared.description ?? "",
      schema,
      alwaysLoad: alwaysLoad(declared, position, deferrable),
    })
  })

  const earlyStop = createEarlyStop({
    rewriter: createToolRewriter(schemas),
    ...(input.abort === undefined ? {} : { abort: input.abort }),
  })

  return {
    mcpServers: { [PASSTHROUGH_SERVER_NAME]: createPassthroughServer(definitions) },
    hooks: earlyStop.hooks,
    filter: (messages) => earlyStop.filter(messages),
    registered: ordered.map((declared) => declared.name),
    captures: earlyStop.captures,
    integrity: () => earlyStop.integrity(),
  }
}

/**
 * The client's tools from an Anthropic Messages body.
 *
 * A convenience for a caller holding nothing but bytes. A launcher that already decoded the body
 * for the prompt should pass `tools` straight to `createPassthrough` instead — decoding twice is
 * two parses of the same megabyte, and this path is the one place a body is read at all (§6).
 *
 * @returns an empty list for a body that is absent, unreadable, or carries no `tools` — all three
 * mean the same thing here, which is that there is no client toolkit to register.
 */
export function readDeclaredTools(body: Uint8Array | null): DeclaredTool[] {
  if (body === null || body.length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return []
  }
  const result = toolsSchema.safeParse(parsed)
  if (!result.success) return []
  return readToolList(result.data.tools)
}

/**
 * The same read, for the caller that already decoded the body — `request.ts`, which decodes it once
 * for the prompt and hands the `tools` value straight here. It exists so the megabyte is parsed
 * once rather than twice; the schema stays private because the shape is this module's.
 *
 * @returns an empty list for anything that is not a list of declared tools.
 */
export function readToolList(value: unknown): DeclaredTool[] {
  if (value === null || value === undefined) return []
  const result = z.array(declaredToolSchema).safeParse(value)
  return result.success ? result.data : []
}

/** Deduplicated, then sorted by code point — the same set always yields the same system prompt. */
function orderForRegistration(tools: readonly DeclaredTool[]): DeclaredTool[] {
  const byName = new Map<string, DeclaredTool>()
  for (const tool of tools) {
    if (tool.name.length > 0 && !byName.has(tool.name)) byName.set(tool.name, tool)
  }
  // `localeCompare` would make the prompt depend on the router's locale, and therefore on which
  // replica served the turn.
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * Whether a tool stays in the prompt rather than behind `ToolSearch`.
 *
 * The client's own `defer_loading` wins where it stated one — it knows which of its tools are the
 * ones this conversation is about, and we do not.
 */
function alwaysLoad(tool: DeclaredTool, position: number, deferrable: boolean): boolean {
  if (typeof tool.defer_loading === "boolean") return !tool.defer_loading
  return !deferrable || position < DEFER_LOADING_THRESHOLD
}
