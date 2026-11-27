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

/** The text from `from` up to the next `until` after it (or the end), whitespace-normalised input. */
function section(text: string, from: string, until: string): string {
  const start = text.indexOf(from)
  if (start < 0) throw new Error(`docs/clients.md lost its "${from}" heading`)
  const end = text.indexOf(until, start + from.length)
  return text.slice(start, end < 0 ? undefined : end)
}

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

  test("the client guide states the full-replica exception and the attempt-cap qualifier", () => {
    // Whitespace-normalised: the guide wraps its prose, the claims must not depend on where.
    const guide = read("docs/clients.md").replace(/\s+/g, " ")
    // Deleting the exception leaves the old, wrong "tried across the pool" promise standing.
    expect(guide).toContain("the remaining Claude accounts are not asked")
    expect(guide).toContain("an account of another kind still is")
    // With `ROUTING_MAX_ATTEMPTS` set the walk stops at the cap, so "the eligible accounts" and
    // "tried across the pool" are only true for the default, uncapped router.
    expect(guide).toContain("up to `ROUTING_MAX_ATTEMPTS` accounts")
    // Each passage that promises a walk carries the qualifier itself: counting mentions across the
    // whole guide lets one passage keep it while the other goes uncapped.
    const errors = section(guide, "## Errors, retries and timeouts", "### ")
    const retries = section(guide, "### Retries: let the router do it", "- **Never retry")
    expect(errors).toContain("`ROUTING_MAX_ATTEMPTS`")
    expect(retries).toContain("up to `ROUTING_MAX_ATTEMPTS` accounts")
  })

  test("no passage of the client guide promises the whole pool is tried without the cap", () => {
    const guide = read("docs/clients.md").replace(/\s+/g, " ")
    const claims = /(tries|tried|walks) (across )?the (eligible accounts|pool)/g
    const uncapped = [...guide.matchAll(claims)].filter((hit) => {
      // The qualifier must live in the same sentence as the claim.
      const rest = guide.slice(hit.index)
      const stop = rest.search(/\. [A-Z]/)
      return !(stop < 0 ? rest : rest.slice(0, stop)).includes("ROUTING_MAX_ATTEMPTS")
    })
    expect(uncapped.map((hit) => hit[0])).toEqual([])
    expect(guide.match(claims)?.length ?? 0).toBeGreaterThanOrEqual(2) // the guard still sees the claims
  })

  test("the knob is in the example env and the deployment table", () => {
    expect(read(".env.example")).toContain("# CLAUDE_SDK_QUEUE_WAIT_MS=60000")
    expect(read("docs/idea/09-deployment.md")).toContain(
      "| `CLAUDE_SDK_QUEUE_WAIT_MS` | no | `60000` |",
    )
  })
})
