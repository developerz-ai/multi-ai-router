import { describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { ApiKeyView } from "../../src/lib/api/types"
import {
  distinctOwners,
  distinctTools,
  filterKeys,
  liveSelection,
} from "../../src/routes/keys/filter-keys"
import { KeyFilters } from "../../src/routes/keys/KeyFilters"

/**
 * The chips are the console's read of the attribution the router now stores:
 * who owns a key and which tool presents it. They narrow the table the operator
 * is already looking at — the full list stays in hand so the chip vocabulary
 * never shrinks to whatever a filter left behind.
 */
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

function withMount(
  props: Parameters<typeof KeyFilters>[0],
  run: (container: HTMLElement) => void,
): void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(() => <KeyFilters {...props} />, container)
  try {
    run(container)
  } finally {
    dispose()
    container.remove()
  }
}

const chipLabelled = (container: HTMLElement, label: string): HTMLButtonElement => {
  const found = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === label,
  )
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no chip labelled "${label}"`)
  return found
}

describe("filterKeys", () => {
  const ROWS = [
    key({ id: "a", owner: "marta", tool: "claude-code" }),
    key({ id: "b", owner: "marta", tool: "aider" }),
    key({ id: "c", owner: "ci-team", tool: "claude-code" }),
    key({ id: "d" }),
  ]

  test("null filters keep every row", () => {
    expect(filterKeys(ROWS, null, null)).toHaveLength(4)
  })

  test("narrows by owner or tool exactly, and combines both with AND", () => {
    expect(filterKeys(ROWS, "marta", null).map((row) => row.id)).toEqual(["a", "b"])
    expect(filterKeys(ROWS, null, "claude-code").map((row) => row.id)).toEqual(["a", "c"])
    expect(filterKeys(ROWS, "marta", "claude-code").map((row) => row.id)).toEqual(["a"])
  })

  test("an owner no row carries matches nothing — honestly, not everything", () => {
    expect(filterKeys(ROWS, "nobody", null)).toHaveLength(0)
  })
})

describe("liveSelection", () => {
  test("keeps a selection that is still on offer, drops one that left the list", () => {
    expect(liveSelection("marta", ["ci-team", "marta"])).toBe("marta")
    expect(liveSelection("marta", ["ci-team"])).toBeNull()
    expect(liveSelection(null, ["marta"])).toBeNull()
  })
})

describe("distinct attribution values", () => {
  test("owners and tools are distinct, sorted, and null never becomes a chip", () => {
    const rows = [key({ owner: "marta", tool: "aider" }), key({ owner: "ci-team" }), key()]
    expect(distinctOwners(rows)).toEqual(["ci-team", "marta"])
    expect(distinctTools(rows)).toEqual(["aider"])
  })
})

describe("KeyFilters", () => {
  const KEYS = [key({ owner: "marta", tool: "claude-code" }), key({ owner: "ci-team" })]

  test("offers a chip per distinct owner and tool, pressed state included", () => {
    withMount(
      { keys: KEYS, owner: "marta", tool: null, onOwnerChange: () => {}, onToolChange: () => {} },
      (container) => {
        expect(chipLabelled(container, "marta").getAttribute("aria-pressed")).toBe("true")
        expect(chipLabelled(container, "ci-team").getAttribute("aria-pressed")).toBe("false")
        expect(chipLabelled(container, "claude-code").getAttribute("aria-pressed")).toBe("false")
      },
    )
  })

  test("clicking a chip selects it; clicking the pressed one clears it", () => {
    const owners: (string | null)[] = []
    // Controlled like its one real caller: the route feeds the chosen owner back
    // in, so the second press reads the pressed state and clears it.
    const [owner, setOwner] = createSignal<string | null>(null)
    const container = document.createElement("div")
    document.body.appendChild(container)
    const dispose = render(
      () => (
        <KeyFilters
          keys={KEYS}
          onOwnerChange={(next) => {
            owners.push(next)
            setOwner(next)
          }}
          onToolChange={() => {}}
          owner={owner()}
          tool={null}
        />
      ),
      container,
    )
    try {
      chipLabelled(container, "marta").click()
      expect(owners).toEqual(["marta"])
      chipLabelled(container, "marta").click()
      expect(owners).toEqual(["marta", null])
    } finally {
      dispose()
      container.remove()
    }
  })

  test("renders nothing on a fleet with no attribution at all", () => {
    withMount(
      { keys: [key()], owner: null, tool: null, onOwnerChange: () => {}, onToolChange: () => {} },
      (container) => {
        expect(container.textContent).toBe("")
      },
    )
  })
})
