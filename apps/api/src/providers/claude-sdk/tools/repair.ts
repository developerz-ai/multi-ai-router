import type { ToolSchema } from "./schema"

/**
 * Renaming a tool argument the model spelled in the wrong case — and **only** then.
 *
 * Claude Code's own system prompt teaches `snake_case` argument names, and the SDK subprocess is
 * Claude Code. A client whose tools declare `filePath` therefore gets `file_path` back often enough
 * that it is a class of bug rather than an anecdote, and the client — which owns the execution —
 * sees a required argument missing and fails the call (docs/idea/11-anthropic-agent-sdk.md §7).
 *
 * **The trigger is a missing *required* parameter, never a spelling that merely looks wrong.** Two
 * reasons, and both rule out the broader rule:
 *
 * - An optional argument the model omitted was not necessarily a rename — the model is allowed to
 *   omit it, and renaming some other key onto it invents an argument the model did not pass.
 * - A tool may legitimately declare `filePath` *and* `file_path`. Repair only ever moves a value
 *   onto a name the schema declares and the payload does not already carry, so a schema that
 *   declares both is left exactly as it arrived.
 *
 * Case is the only difference tolerated. `file_path` → `filePath` is a repair; `path` → `filePath`
 * is a guess, and this module does not guess.
 *
 * Pure: same input, same output, no clock and no I/O (non-negotiable 9).
 */

export interface ToolInputRepair {
  /** The input to forward. Identical to the argument when nothing was renamed. */
  readonly input: Record<string, unknown>
  /** `from` → `to` for each rename, in the order applied. Diagnostics; nothing routes on it. */
  readonly renamed: readonly (readonly [string, string])[]
}

/**
 * @param input the model's `tool_use.input`, already parsed.
 * @param schema the client's own declaration — the authority on which names are required.
 */
export function repairToolInput(
  input: Record<string, unknown>,
  schema: ToolSchema,
): ToolInputRepair {
  // `Object.hasOwn`, never `in`: `"toString" in input` is true of every object, and a required
  // parameter named after an inherited member would silently read as already supplied.
  const missing = schema.required.filter((name) => !Object.hasOwn(input, name))
  if (missing.length === 0) return { input, renamed: [] }

  // Only keys the schema does *not* declare are candidates: a key that is itself a declared
  // property is the model answering a different parameter, not misspelling this one.
  const declared = new Set(schema.properties)
  const candidates = new Map<string, string>()
  for (const key of Object.keys(input)) {
    if (declared.has(key)) continue
    const folded = fold(key)
    // First spelling wins. Two keys folding alike is the model contradicting itself, and picking
    // the later one would make the result depend on JSON key order.
    if (!candidates.has(folded)) candidates.set(folded, key)
  }
  if (candidates.size === 0) return { input, renamed: [] }

  const renames = new Map<string, string>()
  for (const name of missing) {
    const from = candidates.get(fold(name))
    if (from === undefined || renames.has(from)) continue
    renames.set(from, name)
  }
  if (renames.size === 0) return { input, renamed: [] }

  // Rebuilt through entries rather than assigned into: the keys are the model's, and `input.x = v`
  // with `x === "__proto__"` writes through the inherited setter.
  const entries = Object.entries(input).map(([key, value]) => [renames.get(key) ?? key, value])
  return {
    input: Object.fromEntries(entries),
    renamed: [...renames].map(([from, to]) => [from, to] as const),
  }
}

/**
 * The case-insensitive, separator-insensitive spelling of a name.
 *
 * `filePath`, `file_path`, `File-Path`, and `FILEPATH` all fold to `filepath`; `path` does not. That
 * is the whole tolerance — everything a repair is allowed to see through, and nothing more.
 */
function fold(name: string): string {
  return name.replaceAll(/[-_\s]/g, "").toLowerCase()
}
