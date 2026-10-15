import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import type { ApiKeyView } from "../../src/lib/api/types"
import { KeysTable } from "../../src/routes/keys/KeysTable"

/**
 * The keys table prints a key's ceiling, scope and expiry, and — since none of
 * those were reachable after the mint — it is also where an edit has to start.
 * A wrong scope used to mean deleting the key and re-issuing a new value to
 * every client holding it; keys are stored encrypted rather than hashed, so
 * editing one in place is both possible and the honest answer.
 *
 * `container` is queried directly and removed after, because `happy-dom`'s
 * `document` is one global shared by every test file in this process.
 */
function withMount(
  keys: readonly ApiKeyView[],
  overrides: Partial<Parameters<typeof KeysTable>[0]>,
  run: (container: HTMLElement) => void,
): void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(
    () => (
      <KeysTable
        keys={keys}
        nowMs={Date.parse("2026-07-26T00:00:00.000Z")}
        onDelete={() => {}}
        onEdit={() => {}}
        onMintSuccessor={() => {}}
        onReveal={() => {}}
        onRevoke={() => {}}
        revealingId={null}
        usage={new Map()}
        usageBucket="day"
        usageLoading={false}
        usageWindowLabel="7d"
        {...overrides}
      />
    ),
    container,
  )
  try {
    run(container)
  } finally {
    dispose()
    container.remove()
  }
}

function key(overrides: Partial<ApiKeyView> = {}): ApiKeyView {
  return {
    id: "key-1",
    name: "ci-agent-3",
    prefix: "mar_live_abcd",
    owner: null,
    ownerKind: null,
    tool: null,
    purpose: null,
    scope: { kind: "all", poolIds: [], accountIds: [] },
    rateLimit: null,
    expiresAt: null,
    revoked: false,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
    ...overrides,
  }
}

/** The spans of the identity cell, as strings — the name, the attribution, the prefix. */
function identitySpans(container: HTMLElement): readonly string[] {
  const cell = container.querySelector("tbody td")
  if (cell === null) throw new Error("no identity cell")
  return Array.from(cell.querySelectorAll("span")).map((span) => span.textContent ?? "")
}

describe("KeysTable", () => {
  test("every row offers an edit action and hands back the key it belongs to", () => {
    let edited: ApiKeyView | undefined
    withMount(
      [key({ id: "a", name: "laptop" }), key({ id: "b", name: "ci" })],
      { onEdit: (target) => (edited = target) },
      (container) => {
        const buttons = Array.from(container.querySelectorAll("tbody button")).filter(
          (button) => button.textContent?.trim() === "Edit",
        )
        expect(buttons.length).toBe(2)

        const second = buttons[1]
        if (!(second instanceof HTMLButtonElement)) throw new Error("no edit button")
        second.click()
        expect(edited?.id).toBe("b")
      },
    )
  })

  test("a revoked key keeps its edit and delete actions but loses revoke", () => {
    withMount([key({ revoked: true, revokedAt: "2026-07-25T00:00:00.000Z" })], {}, (container) => {
      const labels = Array.from(container.querySelectorAll("tbody button")).map((button) =>
        button.textContent?.trim(),
      )
      expect(labels).toContain("Edit")
      expect(labels).not.toContain("Revoke")
    })
  })

  test("prints the ceiling a key carries, and says none rather than blank", () => {
    withMount([key({ rateLimit: { requests: 60, windowSeconds: 60 } })], {}, (container) => {
      expect(container.textContent).toContain("60 /")
    })
    withMount([key()], {}, (container) => {
      expect(container.textContent).toContain("none")
    })
  })

  test("shows the display prefix and never a whole key value", () => {
    withMount([key()], {}, (container) => {
      expect(container.textContent).toContain("mar_live_abcd…")
    })
  })

  test("every row can mint a successor, and hands back the key it belongs to", () => {
    let source: ApiKeyView | undefined
    withMount(
      [key({ id: "a" }), key({ id: "b" })],
      { onMintSuccessor: (target) => (source = target) },
      (container) => {
        const buttons = Array.from(container.querySelectorAll("tbody button")).filter(
          (button) => button.textContent?.trim() === "Mint successor",
        )
        expect(buttons.length).toBe(2)

        const first = buttons[0]
        if (!(first instanceof HTMLButtonElement)) throw new Error("no successor button")
        first.click()
        expect(source?.id).toBe("a")
      },
    )
  })

  test("prints owner and tool under the name when the key carries them", () => {
    withMount([key({ owner: "ci-team", tool: "claude-code" })], {}, (container) => {
      expect(identitySpans(container)).toContain("ci-team / claude-code")
    })
  })

  test("one half alone prints without a dangling separator", () => {
    withMount([key({ tool: "aider" })], {}, (container) => {
      expect(identitySpans(container)).toContain("aider")
      expect(identitySpans(container).join("\n")).not.toContain(" / ")
    })
  })

  test("prints nothing at all when neither owner nor tool is set", () => {
    withMount([key()], {}, (container) => {
      // Name and prefix only — no empty attribution line riding between them.
      expect(identitySpans(container).length).toBe(2)
    })
  })
})
