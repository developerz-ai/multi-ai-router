import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
  tool,
} from "@anthropic-ai/claude-agent-sdk"
import { toolDenial } from "../allowlist"
import { PASSTHROUGH_SERVER_NAME } from "./names"
import type { ToolSchema } from "./schema"

/**
 * The client's tools, offered to the SDK by an in-process MCP server **whose handlers never run
 * anything**.
 *
 * The SDK ships two tool-execution modes and only one of them is available to a multi-tenant router.
 * *Internal MCP* — the in-process server actually performs `bash`, `read`, `write` **on the host
 * running the SDK** — is arbitrary command execution on behalf of anyone holding any router key, and
 * that host holds `ENCRYPTION_KEY`, the Postgres credentials, and every Account's
 * `CLAUDE_CONFIG_DIR`. It is disqualified, permanently and by design, not deferred
 * (docs/idea/07-security.md#tool-execution-on-the-agent-sdk-path, CLAUDE.md non-negotiable 2).
 *
 * *Passthrough* is the mode we support and the only one we will: the tool call is returned to the
 * client, which owns the user's filesystem, working directory, and consent — which is what a router
 * should do irrespective of security.
 *
 * So why register the tools at all, if nothing executes? **Because the model has to be told they
 * exist to emit a well-formed call for one.** Without a declaration the model either invents a
 * schema or answers in prose; with one it emits a `tool_use` block naming the client's own tool,
 * which is exactly the block the client is waiting for. The server is a *declaration surface*, and
 * the handler is the part that never happens (§7).
 *
 * The handler is nonetheless written as a refusal rather than an empty success, and that is the
 * fourth lock on a door already bolted three times — `PreToolUse` denies the call before the SDK
 * dispatches it (`early-stop.ts`), `canUseTool` denies anything the reviewed allowlist does not name
 * (`options.ts`), and `permissionMode: "dontAsk"` refuses rather than parks whatever reaches
 * neither. If execution somehow arrives here anyway, it must fail loudly and do nothing, never
 * return a plausible empty result the model would reason on.
 */

/** Fixed, because the server name and version reach the model inside the tool catalogue. */
const SERVER_VERSION = "1.0.0"

export interface PassthroughTool {
  /** The client's own name, unqualified. `names.ts` adds the MCP prefix, and the SDK removes it. */
  readonly name: string
  /** The client's description, verbatim. Empty when it sent none — never a synthesized one. */
  readonly description: string
  readonly schema: ToolSchema
  /**
   * Keep this tool in the prompt instead of behind the SDK's deferred-loading search (`register.ts`).
   */
  readonly alwaysLoad: boolean
}

/**
 * The definition shape every passthrough tool shares.
 *
 * The handler is typed on `unknown` rather than on the SDK's `InferShape` of the client's raw
 * shape, and that is not laziness: since SDK 0.3.261 `tool()` infers the handler's argument type
 * from the shape it was given, and a definition built over a runtime `ZodRawShape` infers a
 * parameter no concrete call site can satisfy. The refusal below ignores its arguments by design
 * (it never runs), so a handler that accepts anything states the truth *and* is what the SDK's
 * `createSdkMcpServer` accepts.
 */
export type PassthroughToolDefinition = Omit<
  SdkMcpToolDefinition<ToolSchema["shape"]>,
  "handler"
> & {
  readonly handler: (args: unknown, extra: unknown) => Promise<CallToolResult>
}

/** What a tool handler answers with — the MCP result type, reached through the SDK's own surface. */
type CallToolResult = Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>

/**
 * One client tool as an SDK tool definition.
 *
 * The handler closes over the client's name rather than the qualified one: if it ever does run, the
 * message the model reads should name the tool the way the conversation does.
 */
export function passthroughToolDefinition(declared: PassthroughTool): PassthroughToolDefinition {
  const refuse = async (): Promise<CallToolResult> => ({
    content: [{ type: "text" as const, text: toolDenial(declared.name) }],
    isError: true,
  })
  // `tool()` still builds the definition — it is what stamps `alwaysLoad` into `_meta` under the
  // SDK's own key — and only the handler's declared type is widened afterwards, to the same
  // function.
  const definition = tool(declared.name, declared.description, declared.schema.shape, refuse, {
    alwaysLoad: declared.alwaysLoad,
  })
  return { ...definition, handler: refuse }
}

/**
 * The `mcpServers` entry a `query()` launch is given.
 *
 * One server for the whole client toolkit rather than one per tool: the server name is part of every
 * qualified tool name, and a per-tool namespace would make the catalogue — and therefore the system
 * prompt — different for every request shape.
 */
export function createPassthroughServer(
  tools: readonly PassthroughToolDefinition[],
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: PASSTHROUGH_SERVER_NAME,
    version: SERVER_VERSION,
    tools: [...tools],
  })
}
