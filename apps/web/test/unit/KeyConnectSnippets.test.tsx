import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { KeyConnectSnippets } from "../../src/routes/keys/KeyConnectSnippets"

const BASE = "https://router.example.com"
const KEY = "mar_live_0123456789abcdef"

/**
 * Mounted for real, not prop-checked: the whole point of this panel is that the
 * *rendered* block is copy-paste correct, and a tab that never swaps its panel
 * would still pass a shallow assertion. `dispose` runs even when an assertion
 * throws, so a failure cannot leak a mount into the next test.
 */
function withMount(run: (root: HTMLElement) => void): void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(
    () => <KeyConnectSnippets baseUrl={BASE} keyName="ci-runner" keyValue={KEY} />,
    container,
  )
  try {
    run(container)
  } finally {
    dispose()
    container.remove()
  }
}

const tabs = (root: HTMLElement): HTMLButtonElement[] =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]'))

const selectedTab = (root: HTMLElement): HTMLButtonElement | undefined =>
  tabs(root).find((tab) => tab.getAttribute("aria-selected") === "true")

const panelText = (root: HTMLElement): string =>
  root.querySelector('[role="tabpanel"]')?.textContent ?? ""

const press = (element: HTMLElement, key: string): void => {
  element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
}

describe("KeyConnectSnippets", () => {
  test("offers one tab per client, with exactly one selected", () => {
    withMount((root) => {
      expect(tabs(root).map((tab) => tab.textContent)).toEqual([
        "Claude Code",
        "Cursor",
        "Codex CLI",
        "Aider",
        "OpenAI SDK",
        "curl",
      ])
      expect(tabs(root).filter((tab) => tab.getAttribute("aria-selected") === "true")).toHaveLength(
        1,
      )
    })
  })

  test("shows the operator's real base URL and key, ready to paste", () => {
    withMount((root) => {
      expect(panelText(root)).toContain(`ANTHROPIC_BASE_URL="${BASE}"`)
      expect(panelText(root)).toContain(`ANTHROPIC_AUTH_TOKEN="${KEY}"`)
    })
  })

  test("clicking a tab swaps the panel for that client's wiring", () => {
    withMount((root) => {
      tabs(root)[1]?.click()

      expect(selectedTab(root)?.textContent).toBe("Cursor")
      expect(panelText(root)).toContain(`${BASE}/v1`)
      expect(panelText(root)).toContain("Tab-autocomplete")
      expect(panelText(root)).not.toContain("ANTHROPIC_AUTH_TOKEN")
    })
  })

  test("a multi-line block keeps its line breaks — a config.toml is not one line", () => {
    withMount((root) => {
      tabs(root)[2]?.click()

      const config = Array.from(root.querySelectorAll("output")).find((output) =>
        output.textContent?.includes("model_providers"),
      )
      expect(config?.textContent?.split("\n").length).toBeGreaterThan(3)
      expect(config?.textContent).toContain(`base_url = "${BASE}/v1"`)
    })
  })

  test("every block has its own copy control", () => {
    withMount((root) => {
      tabs(root)[5]?.click()

      const outputs = root.querySelectorAll('[role="tabpanel"] output')
      const copies = Array.from(root.querySelectorAll('[role="tabpanel"] button')).filter(
        (button) => button.textContent === "Copy",
      )
      expect(outputs.length).toBe(3)
      expect(copies).toHaveLength(outputs.length)
    })
  })

  test("arrow keys move between tabs and Home/End reach the ends", () => {
    withMount((root) => {
      const first = tabs(root)[0]
      if (first === undefined) throw new Error("no tabs rendered")

      press(first, "ArrowRight")
      expect(selectedTab(root)?.textContent).toBe("Cursor")

      press(document.activeElement as HTMLElement, "End")
      expect(selectedTab(root)?.textContent).toBe("curl")

      // Wraps rather than dead-ending: the last tab's ArrowRight lands on the first.
      press(document.activeElement as HTMLElement, "ArrowRight")
      expect(selectedTab(root)?.textContent).toBe("Claude Code")

      press(document.activeElement as HTMLElement, "ArrowLeft")
      expect(selectedTab(root)?.textContent).toBe("curl")

      press(document.activeElement as HTMLElement, "Home")
      expect(selectedTab(root)?.textContent).toBe("Claude Code")
    })
  })

  test("keyboard focus enters the tablist once — only the selected tab is tabbable", () => {
    withMount((root) => {
      tabs(root)[3]?.click()

      const tabbable = tabs(root).filter((tab) => tab.getAttribute("tabindex") === "0")
      expect(tabbable).toHaveLength(1)
      expect(tabbable[0]?.textContent).toBe("Aider")
    })
  })

  test("the panel is labelled by the tab that opened it", () => {
    withMount((root) => {
      tabs(root)[4]?.click()

      const panel = root.querySelector('[role="tabpanel"]')
      const tab = selectedTab(root)
      expect(panel?.getAttribute("aria-labelledby")).toBe(tab?.id ?? "")
      expect(tab?.getAttribute("aria-controls")).toBe(panel?.id ?? "")
    })
  })
})
