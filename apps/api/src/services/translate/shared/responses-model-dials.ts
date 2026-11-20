import { isRecord } from "./is-record"
import type { ResponsesEgressRules } from "./responses-egress"

/**
 * The Responses dials decided by the **upstream** model (post-alias, the billed name) on a body the
 * router wrote. Applied where the per-attempt model is reapplied (`dataplane/translate-body.ts`),
 * never baked into the cached conversion, which every account in the chain shares. Pure.
 *
 * Neither fact is in a listing the request path can read: the Codex listing states
 * `support_verbosity` but an API-key account has no such listing, and no listing states whether
 * top-level `instructions` are cached. So both are named rules over the model id, each citing where
 * it came from.
 */

/**
 * "Models starting with GPT-6.2, including Astra and Sol, append [top-level `instructions`] after
 * `input`" and "bill those tokens at the uncached input rate, even on a cache hit"; reusable
 * instructions go "in a `developer` message at the beginning of `input`"
 * (developers.openai.com/api/docs/guides/prompt-caching.md, read 2026-11-20). The rule is stated as
 * a version, so it is a version threshold — `gpt-6.2` onward, any later major included — rather
 * than an id list that misses the next release.
 */
const GPT_VERSION = /^gpt-(\d+)(?:\.(\d+))?(?![\d.])/

export function cachesTopLevelInstructions(model: string): boolean {
  const match = GPT_VERSION.exec(model)
  if (match === null) return true
  const major = Number(match[1])
  const minor = Number(match[2] ?? 0)
  return major < 6 || (major === 6 && minor < 2)
}

/**
 * The models that take `text.verbosity` — opencode's `supportsVerbosity`, restated
 * (anomalyco/opencode `packages/core/src/plugin/verbosity.ts`, dev, read 2026-11-20; MIT). Outside
 * it the field can be a `400` (a model taking only `medium`), so the default is never sent there.
 */
export function takesTextVerbosity(model: string): boolean {
  const id = model.trim().toLowerCase()
  if (id.includes("gpt-6")) return true
  if (id.includes("-chat") || id.includes("-image")) return false
  return (
    /(?:^|[/.])gpt-5\.[1-6](?:[.:-]|$)/.test(id) ||
    /(?:^|[/.])gpt-5(?:-(?:mini|nano)(?:[.:-]|$)|$)/.test(id)
  )
}

/** What Codex (`default_verbosity` on every models.json entry) and opencode send this family. */
const DEFAULT_VERBOSITY = "low"

/**
 * 1. A non-empty `instructions`, toward a model that does not cache it, leads `input` as a
 *    `developer` message instead; the field stays `""` where the surface requires it
 *    (`requireInstructions`, the Codex backend) and is removed elsewhere.
 * 2. `text.verbosity` is set to `low` toward a model that takes it, unless the caller's own value is
 *    already there — carried by the translator from `output_config.verbosity` (anthropic) or
 *    `verbosity` (openai-chat). A structured-output `text.format` is kept beside it.
 */
export function applyResponsesModelDials(
  body: Record<string, unknown>,
  upstreamModel: string,
  rules: ResponsesEgressRules | undefined,
): Record<string, unknown> {
  let out = body
  const instructions = body.instructions
  if (
    typeof instructions === "string" &&
    instructions.length > 0 &&
    Array.isArray(body.input) &&
    !cachesTopLevelInstructions(upstreamModel)
  ) {
    const lead = {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: instructions }],
    }
    const { instructions: _moved, ...rest } = out
    out = {
      ...rest,
      ...(rules?.requireInstructions === true ? { instructions: "" } : {}),
      input: [lead, ...body.input],
    }
  }
  const text = isRecord(body.text) ? body.text : {}
  if (text.verbosity === undefined && takesTextVerbosity(upstreamModel)) {
    out = { ...out, text: { ...text, verbosity: DEFAULT_VERBOSITY } }
  }
  return out
}
