import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { parseModelList } from "../../src/lib/account-models"
import type { ProviderTransport } from "../../src/lib/api/types"
import { AccountModels } from "../../src/routes/accounts/AccountModels"

/**
 * The Models cell — what an account declares, and the button that fills it in.
 *
 * The rule it has to get across is the one everything else about this column follows from: an
 * account declaring nothing is not broken, it accepts anything. It just cannot be enumerated, so
 * `GET /v1/models` has nothing to say about it.
 *
 * `container` is queried directly and removed after, rather than `document.body` — happy-dom's
 * `document` is one global shared by every test file in this process.
 */
function withMount(
  props: {
    readonly models: readonly string[] | null
    readonly transport?: ProviderTransport
    readonly onDiscover?: (id: string) => void
  },
  run: (container: HTMLElement) => void,
): void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(
    () => (
      <AccountModels
        accountId="acc-1"
        busy={false}
        models={props.models}
        onDiscover={props.onDiscover ?? (() => {})}
        transport={props.transport ?? "http"}
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

describe("AccountModels", () => {
  test("an account declaring nothing reads 'any model', not a warning", () => {
    withMount({ models: null }, (container) => {
      expect(container.textContent).toContain("any model")
      // The empty state is a fact, not a fault: no danger tone, no "missing".
      expect(container.textContent).not.toContain("missing")
    })
  })

  test("an empty list reads the same as none — both are unknown, therefore passthrough", () => {
    withMount({ models: [] }, (container) => {
      expect(container.textContent).toContain("any model")
    })
  })

  test("a declared set shows its count and the names it holds", () => {
    withMount({ models: ["glm-4.6", "glm-4.7"] }, (container) => {
      expect(container.textContent).toContain("2 models")
      expect(container.textContent).toContain("glm-4.6, glm-4.7")
    })
  })

  test("one model is not '1 models'", () => {
    withMount({ models: ["glm-4.7"] }, (container) => {
      expect(container.textContent).toContain("1 model")
      expect(container.textContent).not.toContain("1 models")
    })
  })

  test("the discover button fires with the account's id", () => {
    const pressed: string[] = []
    withMount({ models: null, onDiscover: (id) => pressed.push(id) }, (container) => {
      const button = container.querySelector("button")
      expect(button?.textContent).toContain("Discover")
      button?.click()
      expect(pressed).toEqual(["acc-1"])
    })
  })

  test("a Claude subscription offers no button and says who owns its catalog", () => {
    withMount({ models: null, transport: "agent-sdk" }, (container) => {
      expect(container.querySelector("button")).toBeNull()
      expect(container.textContent).toContain("Agent SDK")
    })
  })
})

describe("parseModelList", () => {
  test("splits on commas, trims, and drops empties", () => {
    expect(parseModelList(" glm-4.6 , glm-4.7 ,, ")).toEqual(["glm-4.6", "glm-4.7"])
  })

  test("deduplicates but never reorders or renames — these are the upstream's own ids", () => {
    expect(parseModelList("z-model, a-model, z-model")).toEqual(["z-model", "a-model"])
  })

  test("an empty field is an empty list, which the form then omits entirely", () => {
    expect(parseModelList("   ")).toEqual([])
  })
})
