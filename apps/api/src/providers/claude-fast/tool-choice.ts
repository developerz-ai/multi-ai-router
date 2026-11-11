import { anthropicOutputSchema } from "../../services/translate/shared/anthropic-output-schema"
import { type DropSink, IGNORE_DROPS } from "../../services/translate/shared/drops"
import { STRUCTURED_OUTPUT_TOOL } from "../../services/translate/shared/structured-output-anthropic"
import { nativeStructuredSchema } from "./native-schema"

/**
 * A forced tool choice on the fast transport, adapted to what Claude subscriptions accept.
 *
 * Anthropic answers `400` to `tool_choice {type:"tool"}` for claude-opus-5-5 and claude-sonnet-5-5
 * on this transport, with or without `thinking` (prod replay, 2026-11-09, issue #370), while
 * `{type:"auto"}` and native `output_config.format` are served on every model tried. So:
 *
 * - `{type:"tool", name}` keeps only the named tool; `{type:"any"}` keeps the declared tools. Both
 *   send `{type:"auto"}` (keeping `disable_parallel_tool_use`) and drop a `thinking: disabled`,
 *   which only existed to permit the force. A non-streaming answer is checked for the call by the
 *   invoker, as the Agent-SDK transport does.
 * - The router's own structured-output tool, when it is the only tool and its schema closes every
 *   object node (`native-schema.ts`), becomes `output_config.format` json_schema: the answer
 *   arrives as text, which the openai-chat renderer already returns as `message.content`. Any
 *   other schema (json_object's bare `{type:"object"}` included) is refused natively, so it stays
 *   the adapted forced tool above, whose `tool_use` the renderer also returns as content.
 *
 * Decided here rather than at translation: only code that has committed to direct HTTP may drop
 * the force. The translator runs before the invoker picks fast mode or the SDK fallback (cold
 * credential, unknown alias, uncalibrated profile), and the SDK transport enforces a forced tool
 * itself — an `output_config` written at translation would reach it as an unconstrained turn.
 *
 * Unchanged (the same object back): `auto`, `none` or no choice; a forced name the request does
 * not declare, or `any` with no tools — left for the upstream to refuse as before rather than
 * silently turned into a free-form answer. Pure; never mutates its input.
 */
export type FastToolAdaptation = "forced-tool" | "structured-output" | null

export function adaptFastToolChoice(
  body: Readonly<Record<string, unknown>>,
  options: {
    readonly native?: boolean
    /** Where the reduction reports a constraint it restated as text (`anthropic-output-schema.ts`). */
    readonly onDrop?: DropSink
  } = {},
): {
  readonly body: Readonly<Record<string, unknown>>
  readonly adapted: FastToolAdaptation
  /** The schema sent as `output_config.format`, when the adaptation is `structured-output`. */
  readonly nativeSchema?: Readonly<Record<string, unknown>>
} {
  const choice = body.tool_choice
  if (!isRecord(choice) || (choice.type !== "tool" && choice.type !== "any")) {
    return { body, adapted: null }
  }
  const declared = Array.isArray(body.tools) ? body.tools.filter(isRecord) : []
  const kept =
    choice.type === "any" ? declared : declared.filter((tool) => tool.name === choice.name)
  if (kept.length === 0) return { body, adapted: null }

  const { tool_choice: _forced, ...rest } = body
  const unforced: Record<string, unknown> = { ...rest }
  if (isRecord(body.thinking) && body.thinking.type === "disabled") delete unforced.thinking

  const declaredSchema = kept[0]?.input_schema
  const structured =
    options.native !== false && choice.name === STRUCTURED_OUTPUT_TOOL && declared.length === 1
  // Reduced to the subset Anthropic compiles first: an unsupported keyword (`maxItems`, …) is
  // restated in the node's description rather than sent, and `null` (too deep or too large) keeps
  // the tool. Then `native-schema.ts` decides: closed objects, no recursion, inside the budget.
  // `native: false` is the invoker's retry after Anthropic refused or stalled on the native schema.
  const reduced =
    structured && isRecord(declaredSchema)
      ? anthropicOutputSchema(declaredSchema, options.onDrop ?? IGNORE_DROPS)
      : null
  const schema = reduced?.schema
  if (schema !== undefined && nativeStructuredSchema(schema)) {
    const existing = isRecord(body.output_config) ? body.output_config : {}
    return {
      body: {
        ...unforced,
        // The fast body always carries a `tools` array, empty when none is declared; the replay
        // that proved `output_config.format` sent it that way.
        tools: [],
        output_config: { ...existing, format: { type: "json_schema", schema } },
      },
      adapted: "structured-output",
      nativeSchema: schema,
    }
  }
  return {
    body: {
      ...unforced,
      tools: kept,
      tool_choice: {
        type: "auto",
        ...(choice.disable_parallel_tool_use === undefined
          ? {}
          : { disable_parallel_tool_use: choice.disable_parallel_tool_use }),
      },
    },
    adapted: "forced-tool",
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
