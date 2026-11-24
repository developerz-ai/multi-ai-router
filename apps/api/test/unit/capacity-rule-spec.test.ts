import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The owner-authorized narrowing of the "never a router-made 429" rule is spec, and spec drifts
 * unless something fails when it does. This pins the exact sentence in `CLAUDE.md` and the places
 * that stated the old, unconditional rule (router CLAUDE.md "Tests ship with the fix").
 */

const ROOT = join(import.meta.dir, "../../../..")
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8")

describe("the capacity-answer exception", () => {
  test("CLAUDE.md carries the amended rule verbatim", () => {
    expect(read("CLAUDE.md")).toContain(
      "A router-made `429` while an eligible account is in scope is a bug, except a capacity answer after the bounded gate wait (`CLAUDE_SDK_QUEUE_WAIT_MS`): every eligible account was at its in-flight limit, or the replica at its global one, for the whole wait.",
    )
  })

  test("the gate's header and the client guide no longer say a capacity wait never fails", () => {
    expect(read("apps/api/src/providers/claude-sdk/concurrency.ts")).not.toContain(
      "Excess callers **queue** rather than",
    )
    // Without a trailing newline: the claim must not survive with another sentence on its line.
    expect(read("docs/clients.md")).not.toContain(
      "A failure that reaches\nyou has already been tried across the pool.",
    )
    expect(read("docs/clients.md")).toContain("CLAUDE_SDK_QUEUE_WAIT_MS")
  })

  test("the knob is in the example env and the deployment table", () => {
    expect(read(".env.example")).toContain("# CLAUDE_SDK_QUEUE_WAIT_MS=60000")
    expect(read("docs/idea/09-deployment.md")).toContain(
      "| `CLAUDE_SDK_QUEUE_WAIT_MS` | no | `60000` |",
    )
  })
})
