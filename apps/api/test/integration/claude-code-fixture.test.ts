import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The public-safe rule for the committed Claude Code capture (#211), enforced on the file itself
 * so a future recapture cannot regress it: the repo is public, and the fixture is a real CLI
 * request — anything the capture machine leaked stays leaked.
 *
 * Two layers of assertion, because they fail differently:
 *
 *  - **raw text** — no `@` (a mailto or `user@host`), no non-loopback IP, no credential shape,
 *    no home path. These scan every byte, including fields the structural checks do not name.
 *  - **structure** — `metadata.user_id` is `"<user_id>"`, and every system and user text is a
 *    placeholder. The fields the capture carried real values in (`user_identity`, the git branch,
 *    cwd/home inside the safeguards block) are pinned to their placeholders by name.
 */

const FIXTURE = join(import.meta.dir, "../fixtures/claude-code/claude-code-2.1.299-main-turn.json")
const RAW = readFileSync(FIXTURE, "utf8")

interface Fixture {
  readonly metadata?: { readonly user_id?: unknown }
  readonly system?: ReadonlyArray<{ readonly text?: unknown }>
  readonly messages?: ReadonlyArray<{
    readonly role?: unknown
    readonly content?: unknown
  }>
  readonly tools?: ReadonlyArray<{ readonly description?: unknown }>
  readonly safeguards?: ReadonlyArray<{
    readonly classifier_context?: {
      readonly user_identity?: unknown
      readonly live_cwd?: unknown
      readonly home_dir?: unknown
      readonly git_state?: {
        readonly branch?: unknown
        readonly cwd?: unknown
        readonly root?: unknown
      }
    }
  }>
}

const fixture = JSON.parse(RAW) as Fixture

describe("the committed Claude Code fixture is public-safe (#211)", () => {
  test("metadata.user_id is the placeholder", () => {
    expect(fixture.metadata?.user_id).toBe("<user_id>")
  })

  test("every system and user text is a placeholder", () => {
    for (const block of fixture.system ?? []) {
      expect(block.text).toBe("<placeholder>")
    }
    for (const message of fixture.messages ?? []) {
      if (message.role !== "user" && message.role !== "system") continue
      const content = message.content
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content
      expect(Array.isArray(blocks)).toBe(true)
      for (const block of blocks as ReadonlyArray<{ type?: unknown; text?: unknown }>) {
        if (block.type !== "text") continue
        expect(block.text).toBe("<placeholder>")
      }
    }
    // Tool descriptions came from the capture machine's own configuration; same rule.
    for (const tool of fixture.tools ?? []) {
      expect(tool.description).toBe("<placeholder>")
    }
  })

  test("the fields the capture carried real values in are placeholders", () => {
    for (const safeguard of fixture.safeguards ?? []) {
      const context = safeguard.classifier_context
      expect(context?.user_identity).toBe("<placeholder>")
      expect(context?.live_cwd).toBe("<placeholder>")
      expect(context?.home_dir).toBe("<placeholder>")
      expect(context?.git_state?.branch).toBe("<placeholder>")
      expect(context?.git_state?.cwd).toBe("<placeholder>")
      expect(context?.git_state?.root).toBe("<placeholder>")
    }
  })

  test("no @, no non-loopback IP, no credential shape, no home path anywhere in the bytes", () => {
    expect(RAW).not.toContain("@")

    const ips = RAW.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []
    for (const ip of ips) {
      expect(ip.startsWith("127.")).toBe(true)
    }

    // Anthropic/OpenAI key shapes, JWTs, and an inline bearer token.
    expect(RAW).not.toMatch(/sk-[A-Za-z0-9_-]/)
    expect(RAW).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/)
    expect(RAW).not.toMatch(/bearer\s+[A-Za-z0-9._-]+/i)
    expect(RAW).not.toMatch(/oauth/i)

    expect(RAW).not.toMatch(/"\/home\/|\/Users\/|[A-Z]:\\\\Users\\\\/)
    // A private-network hostname suffix would name the capture machine's network.
    expect(RAW).not.toMatch(/\.(lan|local|internal|corp)\b/i)
  })
})
