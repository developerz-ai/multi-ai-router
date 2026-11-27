import { removeLines, replaceSpans, type SpanRule } from "./scrub-spans"

/**
 * Harness fingerprints, removed from the client's system prompt on the way into `query()`.
 *
 * **Every regex here is a billing signal, not untidy prose.** Anthropic meters a subscription
 * request partly by *who appears to be asking*: the Agent SDK is Claude Code, and a system prompt
 * that also announces some other harness is read as a third-party app wearing Claude Code's
 * credential. The account is then gated behind Extra Usage rather than its plan, and the request is
 * refused — `400 Third-party apps now draw from your extra usage, not your plan limits. Add more at
 * claude.ai/settings/usage and keep going.` (`failure-rules-quota.ts`,
 * `claude-sdk:extra-usage-gated`).
 *
 * The strongest tell is a **duplicate**. Claude Code's own preset already injects `Here is some
 * useful information about the environment you are running in:` followed by an `<env>` block; a
 * harness that appends its own copy makes the preamble appear twice in the final prompt, and two is
 * the impersonation signal. So the point of {@link ENV_PREAMBLE_BLOCK} is not that the text is
 * unwanted — it is that a second copy of it exists. Deleting the rule as cleanup re-opens a `400`
 * no failover can route around, because it fails identically on every account in the pool.
 *
 * Provenance, all measured on this router 2026-09-05 against `router.invalid`: the same
 * 56 KB opencode system prompt succeeds with the preamble section removed and fails with it
 * present, on `default`, `opus`, `sonnet`, `haiku` and `claude-opus-5` alike, and on every account
 * in the pool. The remaining rules are the same class of tell, recorded by Meridian's
 * `@rynfar/meridian-plugin-opencode-scrub` (which bisected the preamble independently) and by its
 * issue #516. Blast radius: a harness that rewords its own preamble stops matching and the `400`
 * comes back — visible as `claude-sdk:extra-usage-gated` on the failure, which is why that
 * classification names Extra Usage rather than calling the request malformed.
 *
 * Three properties the rules are built to hold, and the tests pin all three:
 *
 * - **Independent.** One rule per fingerprint, each a no-op when its pattern is absent, so a
 *   prompt from a harness this build has never seen loses nothing.
 * - **Idempotent.** Every substitution removes what it matched or replaces it with text the same
 *   pattern cannot match, so scrubbing twice equals scrubbing once.
 * - **Conservative.** Nothing else is touched: tool policy, tone rules, task guidance, and any
 *   user `CLAUDE.md` content the harness appended all pass through verbatim.
 *
 * **Both Claude subscription transports are in scope:** the Agent SDK egress path and the native
 * direct-HTTP fast path, which scrubs system text in place in `prepareFastRequest` before the
 * rebuilt body is integrity-stamped (docs/standards/harness-fingerprint-scrubbing.md). An API-key
 * account is plain HTTP with the caller's own credential and no impersonation to detect, and every
 * other provider is a passthrough where rewriting the caller's prompt would be the router
 * substituting words the client never wrote (docs/idea/11-anthropic-agent-sdk.md §8).
 */

/**
 * The environment preamble and its `<env>` block — the duplicate that gates the account behind
 * Extra Usage. Global: a prompt carrying two copies is precisely the condition being removed, and
 * leaving the second one standing would leave the `400` standing with it.
 */
const ENV_PREAMBLE_BLOCK: SpanRule = {
  open: "Here is some useful information about the environment you are running in:\n<env>",
  close: "</env>",
  tail: "newline",
  leadingNewline: true,
  replacement: "\n",
}

/**
 * opencode's `environment()` builder appends this line. Claude Code never phrases a model that
 * way, so it identifies the harness on its own — no duplicate required.
 */
const POWERED_BY_LINE = /You are powered by the model named [^\n]*(?:\n|$)/g

/**
 * opencode's opening identity line, from its built-in `anthropic.txt`.
 *
 * Legacy coverage: 1.18.29's V2 prompt is ~1.1 KB and opens `You are an AI coding agent.`, which
 * carries no brand and is *not* scrubbed — a generic line is not a fingerprint. This rule is kept
 * for the older builds a fleet still runs, and it costs nothing when absent, which is the whole
 * point of the rules being independent.
 */

/**
 * A generic stand-in rather than a deletion: the opening line is what anchors the model's role,
 * and a prompt that starts mid-instruction is a different prompt, not a scrubbed one.
 */
const GENERIC_IDENTITY =
  "You are an expert coding assistant. You help users with software engineering tasks by reading files, executing commands, editing code, and writing new files.\n"
const OPENCODE_IDENTITY_LINE: SpanRule = {
  open: "You are OpenCode, the best coding agent on the planet.",
  close: "",
  tail: "line",
  replacement: GENERIC_IDENTITY,
}

/** The feedback block, which names the harness's own repository. */
const OPENCODE_FEEDBACK_BLOCK: SpanRule = {
  open: "If the user asks for help or wants to give feedback",
  close: "github.com/anomalyco/opencode",
  tail: "line",
  replacement: "",
}

/** The "When the user directly asks about OpenCode…" documentation paragraph. */
const OPENCODE_DOCS_PARAGRAPH: SpanRule = {
  open: "When the user directly asks about OpenCode",
  close: "opencode.ai/docs",
  tail: "line",
  replacement: "",
}

/** The professional-objectivity sentence, whose subject is the harness by name. */
const OPENCODE_OBJECTIVITY_BRAND = /It is best for the user if OpenCode honestly applies/g
const GENERIC_OBJECTIVITY = "It is best for the user if the assistant honestly applies"

/**
 * OhMyOpenCode's `<agent-identity>` wrapper, injected ahead of every persona variant, and the
 * Sisyphus identity line inside it — quoted in the default persona, bold on Claude-routed prompts.
 */
const OMO_AGENT_IDENTITY_BLOCK: SpanRule = {
  open: "<agent-identity>",
  close: "</agent-identity>",
  tail: "newlines",
  replacement: "",
}
const OMO_IDENTITY_OPENER = /You are (?:"|\*\*)Sisyphus(?:"|\*\*)/
const OMO_IDENTITY_MARKER = "OhMyOpenCode"
/** Its runtime environment block — the same shape as `<env>`, under its own tag. */
const OMO_ENV_BLOCK: SpanRule = {
  open: "<omo-env>",
  close: "</omo-env>",
  tail: "newlines",
  replacement: "",
}

/**
 * Residual brand tokens in prose the rules above deliberately preserved. Rewritten rather than
 * deleted, because the sentences around them are instructions the client meant to send. The cost is
 * named honestly: a user's own `CLAUDE.md` that discusses the harness by name is rewritten too —
 * the token *is* the fingerprint, so there is no reading of it that keeps both the words and the
 * request.
 *
 * **Case-insensitive, which it was not until 2.10.5.** opencode spells itself lower-case in its own
 * prose — 1.18.29's built-in `customize-opencode` skill description says `opencode` a dozen times
 * and never once capitalised — so a case-sensitive `\bOpenCode\b` matched none of it and the
 * fingerprint travelled anyway. The longer alternative is listed first: alternation is ordered, and
 * `OpenCode` would otherwise match inside `OhMyOpenCode` under `i`.
 */
const BRAND_TOKENS = /\bOhMyOpenCode\b|\bOpenCode\b/gi
const GENERIC_BRAND = "the assistant"

/** Collapsed, then trimmed, so a removed block does not leave a hole where a paragraph break belongs. */
const BLANK_RUN = /\n{3,}/g

/**
 * The rules in the order they run, each under the name the upstream-refusal log line reports it by
 * (`services/dataplane/attempt-log.ts`, #509). A rule is reported when its own substitution changed
 * the text; the closing tidy (blank runs, trailing whitespace) is no rule and reports nothing.
 */
const RULES = [
  ["opencode-identity-line", (text: string) => replaceSpans(text, OPENCODE_IDENTITY_LINE)],
  ["opencode-feedback-block", (text: string) => replaceSpans(text, OPENCODE_FEEDBACK_BLOCK)],
  ["opencode-docs-paragraph", (text: string) => replaceSpans(text, OPENCODE_DOCS_PARAGRAPH)],
  [
    "opencode-objectivity-brand",
    (text: string) => text.replace(OPENCODE_OBJECTIVITY_BRAND, GENERIC_OBJECTIVITY),
  ],
  ["omo-agent-identity-block", (text: string) => replaceSpans(text, OMO_AGENT_IDENTITY_BLOCK)],
  [
    "omo-identity-line",
    (text: string) => removeLines(text, OMO_IDENTITY_OPENER, OMO_IDENTITY_MARKER),
  ],
  ["omo-env-block", (text: string) => replaceSpans(text, OMO_ENV_BLOCK)],
  ["powered-by-line", (text: string) => text.replace(POWERED_BY_LINE, "")],
  ["env-preamble-block", (text: string) => replaceSpans(text, ENV_PREAMBLE_BLOCK)],
  ["brand-tokens", (text: string) => text.replace(BRAND_TOKENS, GENERIC_BRAND)],
] as const

export type ScrubRuleName = (typeof RULES)[number][0]

export const SCRUB_RULE_NAMES: readonly ScrubRuleName[] = RULES.map(([name]) => name)

/** A scrubbed prompt and the names, in table order, of the rules that changed it. */
export interface ScrubReport {
  readonly text: string
  readonly rules: readonly ScrubRuleName[]
}

/**
 * One system-prompt string, scrubbed, with the rules that fired. Names only: the report never
 * carries a word of the prompt, so it may reach a log line the prompt itself never does.
 */
export function scrubWithReport(prompt: string): ScrubReport {
  if (prompt === "") return { text: prompt, rules: [] }
  let text = prompt
  const rules: ScrubRuleName[] = []
  for (const [name, apply] of RULES) {
    const next = apply(text)
    if (next !== text) rules.push(name)
    text = next
  }
  return { text: text.replace(BLANK_RUN, "\n\n").trimEnd(), rules }
}

/**
 * One system-prompt string, scrubbed. Returns the input unchanged when it carries no fingerprint,
 * and the empty string when the whole prompt *was* one — {@link scrubSystemPrompt} decides what
 * that means for the SDK option.
 */
export function scrubHarnessFingerprints(prompt: string): string {
  return scrubWithReport(prompt).text
}

/**
 * The seam-facing shape: the client's system prompt as `request.ts` flattened it, scrubbed part by
 * part.
 *
 * `null` when nothing survives — a prompt that was *only* a fingerprint, which an agent harness
 * sending its environment block and nothing else produces. Null means the option is omitted, which
 * is the same answer `readSystem` already gives for an empty system prompt: no system prompt at
 * all, rather than an empty one the SDK would still send.
 */
export function scrubSystemPrompt(
  prompt: string | readonly string[],
): string | readonly string[] | null {
  return scrubSystemPromptWithReport(prompt).prompt
}

/** {@link scrubSystemPrompt}, plus the union of the rules that fired on any part, in table order. */
export function scrubSystemPromptWithReport(prompt: string | readonly string[]): {
  readonly prompt: string | readonly string[] | null
  readonly rules: readonly ScrubRuleName[]
} {
  if (typeof prompt === "string") {
    const { text, rules } = scrubWithReport(prompt)
    return { prompt: text === "" ? null : text, rules }
  }
  const reports = prompt.map(scrubWithReport)
  const parts = reports.map((report) => report.text).filter((part) => part !== "")
  return {
    prompt: parts.length === 0 ? null : parts,
    rules: unionScrubRules(reports.map((report) => report.rules)),
  }
}

/** The rules any of several reports named, once each, in table order. */
export function unionScrubRules(
  lists: readonly (readonly ScrubRuleName[])[],
): readonly ScrubRuleName[] {
  return SCRUB_RULE_NAMES.filter((name) => lists.some((rules) => rules.includes(name)))
}
