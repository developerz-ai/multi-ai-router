import { describe, expect, test } from "bun:test"
import {
  scrubHarnessFingerprints,
  scrubSystemPrompt,
} from "../../../src/providers/claude-sdk/scrub"

/**
 * The prompt shape that took the whole subscription pool down on 2026-09-05: every agent-sized
 * request from opencode answered `400 Third-party apps now draw from your extra usage…` on every
 * account and every model. Bisected to one section — the environment preamble and its `<env>`
 * block, which Claude Code's own preset already injects — so these tests hold the fingerprints by
 * their exact text, because the exact text is the whole provenance.
 */

/** Verbatim, as opencode's `environment()` builder emits it. */
const ENV_PREAMBLE = `Here is some useful information about the environment you are running in:
<env>
  Working directory: /home/sebastian/workspace/tesote/tesote.ai
  Workspace root folder: /home/sebastian/workspace/tesote/tesote.ai
  Is directory a git repo: yes
  Platform: linux
</env>
`

describe("the environment preamble — the block that gates the account behind Extra Usage", () => {
  test("the preamble and its <env> block are gone, and nothing of them is left behind", () => {
    const scrubbed = scrubHarnessFingerprints(
      `Be concise and direct.\n\n${ENV_PREAMBLE}\nAlways run the tests.`,
    )

    expect(scrubbed).not.toContain("Here is some useful information about the environment")
    expect(scrubbed).not.toContain("<env>")
    expect(scrubbed).not.toContain("Working directory")
    // Everything the client actually meant to send survives, verbatim.
    expect(scrubbed).toContain("Be concise and direct.")
    expect(scrubbed).toContain("Always run the tests.")
  })

  test("a second copy is removed too — two is the impersonation signal, not one", () => {
    const scrubbed = scrubHarnessFingerprints(`${ENV_PREAMBLE}\nmiddle\n${ENV_PREAMBLE}`)

    expect(scrubbed).not.toContain("<env>")
    expect(scrubbed).toContain("middle")
  })

  test("a prompt that is nothing but the fingerprint is no system prompt at all", () => {
    // The acceptance shape: a client whose whole system prompt is the environment block. An empty
    // string is a different thing to send than nothing, so the option is dropped instead.
    expect(scrubSystemPrompt(ENV_PREAMBLE)).toBeNull()
  })
})

describe("the other harness tells", () => {
  test("the self-outing 'powered by the model named' line goes", () => {
    const scrubbed = scrubHarnessFingerprints(
      "You are a coding agent.\nYou are powered by the model named Claude Opus 5. The exact model ID is claude-opus-5.\nBe terse.",
    )

    expect(scrubbed).not.toContain("powered by the model named")
    expect(scrubbed).toContain("You are a coding agent.")
    expect(scrubbed).toContain("Be terse.")
  })

  test("the identity line is replaced rather than deleted — the role still has an anchor", () => {
    const scrubbed = scrubHarnessFingerprints(
      "You are OpenCode, the best coding agent on the planet.\n\nYou run in a terminal.",
    )

    expect(scrubbed).not.toContain("OpenCode")
    expect(scrubbed).toStartWith("You are an expert coding assistant.")
    expect(scrubbed).toContain("You run in a terminal.")
  })

  test("the feedback block and the docs paragraph, which name the harness's own URLs", () => {
    const scrubbed = scrubHarnessFingerprints(
      [
        "If the user asks for help or wants to give feedback, open an issue at https://github.com/anomalyco/opencode/issues",
        "When the user directly asks about OpenCode, point them at https://opencode.ai/docs",
        "Keep this line.",
      ].join("\n\n"),
    )

    expect(scrubbed).not.toContain("github.com/anomalyco/opencode")
    expect(scrubbed).not.toContain("opencode.ai/docs")
    expect(scrubbed).toContain("Keep this line.")
  })

  test("the OhMyOpenCode persona blocks and their runtime env", () => {
    const scrubbed = scrubHarnessFingerprints(
      [
        "<agent-identity>\nYour designated identity for this session is Sisyphus.\n</agent-identity>",
        'You are "Sisyphus", the orchestrator persona of OhMyOpenCode.',
        "<omo-env>\n  model: claude-opus-5\n</omo-env>",
        "Phase 0: explore before you edit.",
      ].join("\n"),
    )

    expect(scrubbed).not.toContain("<agent-identity>")
    expect(scrubbed).not.toContain("<omo-env>")
    expect(scrubbed).not.toContain("OhMyOpenCode")
    // The orchestration rules are what the client came for; only the identity is a fingerprint.
    expect(scrubbed).toContain("Phase 0: explore before you edit.")
  })

  test("a residual brand token in preserved prose is rewritten, not left as a tell", () => {
    expect(scrubHarnessFingerprints("Follow the OpenCode conventions.")).toBe(
      "Follow the the assistant conventions.",
    )
  })
})

describe("the three properties every rule is built to hold", () => {
  test("idempotent: scrubbing twice is scrubbing once", () => {
    const prompt = [
      "You are OpenCode, the best coding agent on the planet.",
      "",
      "You are powered by the model named Claude Opus 5.",
      "",
      ENV_PREAMBLE,
      "Run the tests before you claim success.",
    ].join("\n")

    const once = scrubHarnessFingerprints(prompt)
    expect(scrubHarnessFingerprints(once)).toBe(once)
  })

  test("independent: a prompt carrying one fingerprint keeps everything the others describe", () => {
    const prompt = `Tone: terse.\n\n${ENV_PREAMBLE}\nTool policy: never write outside the repo.`
    const scrubbed = scrubHarnessFingerprints(prompt)

    expect(scrubbed).toContain("Tone: terse.")
    expect(scrubbed).toContain("Tool policy: never write outside the repo.")
  })

  test("conservative: a prompt with no fingerprint at all is returned unchanged", () => {
    const prompt =
      "You are a helpful assistant.\n\n# CLAUDE.md\n\nRun `bin/check` before every commit.\n\nUse tabs."

    expect(scrubHarnessFingerprints(prompt)).toBe(prompt)
    expect(scrubSystemPrompt(prompt)).toBe(prompt)
  })

  test("an empty prompt is left exactly as it was", () => {
    expect(scrubHarnessFingerprints("")).toBe("")
  })
})

describe("the flattened shapes request.ts produces", () => {
  test("a block list is scrubbed part by part, and emptied parts drop out", () => {
    const scrubbed = scrubSystemPrompt([ENV_PREAMBLE, "Be terse."])

    expect(scrubbed).toEqual(["Be terse."])
  })

  test("a list that was all fingerprints is no system prompt at all", () => {
    expect(scrubSystemPrompt([ENV_PREAMBLE, ENV_PREAMBLE])).toBeNull()
  })
})

/**
 * opencode spells itself lower-case in its own prose — 1.18.29's built-in `customize-opencode`
 * skill description says `opencode` a dozen times and never once capitalised — so the
 * case-sensitive rule this shipped with matched none of it and the fingerprint travelled anyway
 * (measured on a box, 2026-09-06).
 */
describe("the brand token, however it is spelled", () => {
  test("lower-case is caught, which it was not until 2.10.5", () => {
    const scrubbed = scrubHarnessFingerprints("Use the opencode skill to customize opencode.")

    expect(scrubbed).not.toContain("opencode")
    expect(scrubbed).toContain("the assistant")
  })

  test("the OhMyOpenCode token stays whole rather than being eaten from the middle", () => {
    // Alternation is ordered: the longer token is listed first, or `OpenCode` would match inside it
    // under a case-insensitive flag and leave `OhMy` behind.
    expect(scrubHarnessFingerprints("Built on OhMyOpenCode.")).toBe("Built on the assistant.")
  })

  test("and it is still idempotent, which the case-insensitive form could quietly break", () => {
    const once = scrubHarnessFingerprints("opencode and OpenCode and OhMyOpenCode")
    expect(scrubHarnessFingerprints(once)).toBe(once)
  })

  test("a generic identity line is not a fingerprint and is left alone", () => {
    // 1.18.29's V2 prompt opens with this. It carries no brand, so scrubbing it would be the router
    // rewriting instructions rather than removing a tell.
    const prompt = "You are an AI coding agent.\n\nBe concise."
    expect(scrubHarnessFingerprints(prompt)).toBe(prompt)
  })
})
