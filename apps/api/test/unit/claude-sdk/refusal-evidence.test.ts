import { describe, expect, test } from "bun:test"
import {
  SCRUB_RULE_NAMES,
  scrubHarnessFingerprints,
  scrubSystemPromptWithReport,
  scrubWithReport,
} from "../../../src/providers/claude-sdk/scrub"
import { createEvidenceCapture } from "../../../src/services/dataplane/sdk-attempt-evidence"

/**
 * Which harness fingerprints the scrub removed, by rule name (#509). The upstream-refusal log line
 * carries the names so a third-party-app refusal can later be grouped by what the prompt looked
 * like, without the prompt itself ever reaching a log. Names only: a rule name is not prompt text.
 */

const ENV_PREAMBLE = `Here is some useful information about the environment you are running in:
<env>
  Working directory: /home/router/workspace
  Platform: linux
</env>
`

/** One fixture per rule, each firing that rule and no other. Every line rule needs its newline. */
const FIXTURES: Readonly<Record<string, string>> = {
  "opencode-identity-line": "You are OpenCode, the best coding agent on the planet.\nBe terse.",
  "opencode-feedback-block":
    "If the user asks for help or wants to give feedback, see https://github.com/anomalyco/opencode/issues\nBe terse.",
  "opencode-docs-paragraph":
    "When the user directly asks about OpenCode, point them at https://opencode.ai/docs\nBe terse.",
  "opencode-objectivity-brand":
    "It is best for the user if OpenCode honestly applies the same standards.\nBe terse.",
  "omo-agent-identity-block":
    "<agent-identity>\nYour designated identity is the orchestrator.\n</agent-identity>\nBe terse.",
  "omo-identity-line": 'You are "Sisyphus", the orchestrator persona of OhMyOpenCode.\nBe terse.',
  "omo-env-block": "<omo-env>\n  model: claude-opus-5\n</omo-env>\nBe terse.",
  "powered-by-line": "You are powered by the model named Claude Opus 5.\nBe terse.",
  "env-preamble-block": `Be concise.\n\n${ENV_PREAMBLE}\nBe terse.`,
  "brand-tokens": "Use the opencode tools when asked.\nBe terse.",
}

describe("the scrub reports which rules fired", () => {
  test("the table names all ten rules, in the order they run", () => {
    expect([...SCRUB_RULE_NAMES]).toEqual([
      "opencode-identity-line",
      "opencode-feedback-block",
      "opencode-docs-paragraph",
      "opencode-objectivity-brand",
      "omo-agent-identity-block",
      "omo-identity-line",
      "omo-env-block",
      "powered-by-line",
      "env-preamble-block",
      "brand-tokens",
    ])
  })

  for (const name of SCRUB_RULE_NAMES) {
    test(`${name} is reported exactly when its own fixture fires it`, () => {
      const fixture = FIXTURES[name]
      if (fixture === undefined) throw new Error(`no fixture for ${name}`)
      const report = scrubWithReport(fixture)
      expect([...report.rules]).toEqual([name])
      // The reporting path scrubs exactly as the plain one does.
      expect(report.text).toBe(scrubHarnessFingerprints(fixture))
      expect(report.text).toContain("Be terse.")
    })
  }

  test("a prompt with no fingerprint reports [] and passes through", () => {
    const prompt = "Be concise and direct.\n\nAlways run the tests."
    const report = scrubWithReport(prompt)
    expect([...report.rules]).toEqual([])
    expect(report.text).toBe(prompt)
  })

  test("trailing blank lines alone are tidied, and fire no rule", () => {
    const report = scrubWithReport("Be terse.\n\n\n\n")
    expect([...report.rules]).toEqual([])
    expect(report.text).toBe(scrubHarnessFingerprints("Be terse.\n\n\n\n"))
  })

  test("several fingerprints in one prompt are named in table order", () => {
    const prompt = [
      FIXTURES["brand-tokens"],
      FIXTURES["powered-by-line"],
      FIXTURES["opencode-identity-line"],
    ].join("\n\n")
    expect([...scrubWithReport(prompt).rules]).toEqual([
      "opencode-identity-line",
      "powered-by-line",
      "brand-tokens",
    ])
  })

  test("a prompt split in parts reports the union, in table order, and keeps the scrubbed parts", () => {
    const { prompt, rules } = scrubSystemPromptWithReport([
      "Use opencode tools when asked.",
      ENV_PREAMBLE,
      "You are powered by the model named Claude Opus 5.\nBe terse.",
    ])
    expect([...rules]).toEqual(["powered-by-line", "env-preamble-block", "brand-tokens"])
    // The preamble-only part scrubs to nothing and is dropped, as `scrubSystemPrompt` drops it.
    expect(prompt).toEqual(["Use the assistant tools when asked.", "Be terse."])
  })

  test("a prompt that was only a fingerprint is null, and still names its rule", () => {
    const { prompt, rules } = scrubSystemPromptWithReport(ENV_PREAMBLE)
    expect(prompt).toBeNull()
    expect([...rules]).toEqual(["env-preamble-block"])
  })
})

describe("the attempt's evidence capture", () => {
  test("the last transport report wins: a later invoker owns transport, model and scrubRules", () => {
    const capture = createEvidenceCapture()
    capture.onTransport({ transport: "fast", model: "claude-opus-5", scrubRules: ["brand-tokens"] })
    capture.onTransport({ transport: "sdk", model: "opus" })
    expect(capture.evidence(false)).toEqual({ transport: "sdk", model: "opus" })
  })

  test("no report and no refusal is no evidence at all", () => {
    expect(createEvidenceCapture().evidence(true)).toBeUndefined()
  })

  test("a refusal's in-flight count and headers ride only where the refusal is the answer", () => {
    const capture = createEvidenceCapture()
    const headers = new Headers({ "request-id": "req_1" })
    capture.onTransport({ transport: "fast", model: "claude-opus-5", scrubRules: [] })
    capture.onRefusalEvidence({ inFlight: 2, headers })
    expect(capture.evidence(true)).toEqual({
      transport: "fast",
      model: "claude-opus-5",
      scrubRules: [],
      inFlight: 2,
      headers,
    })
    expect(capture.evidence(false)).toEqual({
      transport: "fast",
      model: "claude-opus-5",
      scrubRules: [],
    })
  })
})
