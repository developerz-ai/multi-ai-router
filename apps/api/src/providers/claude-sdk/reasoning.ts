import type { EffortLevel, ThinkingConfig } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

/**
 * The client's `thinking` and `output_config.effort`, read into the Agent SDK's own `thinking` and
 * `effort` options (docs/idea/11-anthropic-agent-sdk.md §6, "Where fidelity is lost").
 *
 * **Lenient by design, and never a `400`.** The same body on an API-key Account is byte
 * passthrough, so refusing a value here would fail a turn on one transport that succeeds on the
 * other. And clients run ahead of the bundled CLI — Claude Code sends display values the SDK does
 * not type yet — while the SDK hands `display` to the CLI as `--thinking-display`, which exits
 * before the turn starts on a word it does not know (Meridian #1249). So a value outside the SDK's
 * vocabulary is **dropped and reported**: the field falls back to the SDK's own default, and the
 * caller can see that it did.
 *
 * Absence stays absence. A client that sent neither field launches with neither option, so the
 * CLI's defaults apply exactly as they did before this module existed.
 */

/** A field this module could not carry to the SDK. `value` is the client's, for the debug log. */
export interface IgnoredOption {
  readonly field: string
  readonly value: unknown
}

export interface Reasoning {
  readonly thinking: ThinkingConfig | null
  readonly effort: EffortLevel | null
  readonly ignored: readonly IgnoredOption[]
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly EffortLevel[]
const DISPLAYS = ["summarized", "omitted"] as const

const effortSchema = z.enum(EFFORTS)
const displaySchema = z.enum(DISPLAYS)
const budgetSchema = z.number().int().positive()

const thinkingShape = z.looseObject({
  type: z.unknown(),
  display: z.unknown().optional(),
  budget_tokens: z.unknown().optional(),
})
const outputConfigShape = z.looseObject({ effort: z.unknown().optional() })

export function readReasoning(thinking: unknown, outputConfig: unknown): Reasoning {
  const ignored: IgnoredOption[] = []
  return {
    thinking: readThinking(thinking, ignored),
    effort: readEffort(outputConfig, ignored),
    ignored,
  }
}

function readThinking(value: unknown, ignored: IgnoredOption[]): ThinkingConfig | null {
  if (value === undefined || value === null) return null
  const parsed = thinkingShape.safeParse(value)
  if (!parsed.success) {
    ignored.push({ field: "thinking", value })
    return null
  }
  const { type, display, budget_tokens: budget } = parsed.data

  if (type === "disabled") return { type: "disabled" }
  if (type !== "adaptive" && type !== "enabled") {
    ignored.push({ field: "thinking.type", value: type })
    return null
  }

  const shown = readDisplay(display, ignored)
  if (type === "adaptive") return shown === null ? { type } : { type, display: shown }

  const budgetTokens = readBudget(budget, ignored)
  return {
    type,
    ...(budgetTokens === null ? {} : { budgetTokens }),
    ...(shown === null ? {} : { display: shown }),
  }
}

function readDisplay(value: unknown, ignored: IgnoredOption[]): (typeof DISPLAYS)[number] | null {
  if (value === undefined || value === null) return null
  const parsed = displaySchema.safeParse(value)
  if (parsed.success) return parsed.data
  ignored.push({ field: "thinking.display", value })
  return null
}

function readBudget(value: unknown, ignored: IgnoredOption[]): number | null {
  if (value === undefined || value === null) return null
  const parsed = budgetSchema.safeParse(value)
  if (parsed.success) return parsed.data
  ignored.push({ field: "thinking.budget_tokens", value })
  return null
}

function readEffort(outputConfig: unknown, ignored: IgnoredOption[]): EffortLevel | null {
  const config = outputConfigShape.safeParse(outputConfig)
  if (!config.success) return null
  const value = config.data.effort
  if (value === undefined || value === null) return null
  const parsed = effortSchema.safeParse(value)
  if (parsed.success) return parsed.data
  ignored.push({ field: "output_config.effort", value })
  return null
}
