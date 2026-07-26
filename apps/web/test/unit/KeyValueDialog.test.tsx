import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { KeyValueDialog } from "../../src/routes/keys/KeyValueDialog"

const BASE = "https://router.example.com"

/**
 * Rendered through the real `Modal`/`Portal` stack, not a shallow prop check —
 * `Portal` renders as an empty string under Solid's server build (see
 * `test/support/solid-plugin.ts`), so a test that stopped at "the component
 * mounted without throwing" could pass on a dialog that rendered nothing.
 *
 * `dispose` always runs, even when the callback's assertion throws — `Portal`
 * content lives directly under `document.body`, shared across every test in
 * this process, so a leaked mount would leave text behind for the next test
 * to trip over.
 */
function withMount(props: Parameters<typeof KeyValueDialog>[0], run: () => void): void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(() => <KeyValueDialog {...props} />, container)
  try {
    run()
  } finally {
    dispose()
    container.remove()
  }
}

describe("KeyValueDialog", () => {
  test("shows the router key's value in full, on both the mint and the later reveal", () => {
    withMount(
      {
        open: true,
        name: "ci-runner",
        value: "sk-abc123",
        minted: true,
        baseUrl: BASE,
        onClose: () => {},
      },
      () => {
        expect(document.body.textContent).toContain("sk-abc123")
      },
    )
    withMount(
      {
        open: true,
        name: "ci-runner",
        value: "sk-abc123",
        minted: false,
        baseUrl: BASE,
        onClose: () => {},
      },
      () => {
        expect(document.body.textContent).toContain("sk-abc123")
      },
    )
  })

  test("never warns the value is shown once — keys are retrievable by design", () => {
    for (const minted of [true, false]) {
      withMount(
        {
          open: true,
          name: "ci-runner",
          value: "sk-abc123",
          minted,
          baseUrl: BASE,
          onClose: () => {},
        },
        () => {
          const text = (document.body.textContent ?? "").toLowerCase()
          // The component states the opposite as reassurance ("Nothing here is
          // shown once") — that sentence is expected. What must never appear is
          // an actual shown-once *warning*.
          expect(text).not.toContain("you will not see this again")
          expect(text).not.toContain("won't be shown again")
          expect(text).not.toContain("will not be shown again")
          expect(text).toContain("nothing here is shown once")
        },
      )
    }
  })

  test("the value is copyable — a Copy control sits next to it", () => {
    withMount(
      {
        open: true,
        name: "ci-runner",
        value: "sk-abc123",
        minted: true,
        baseUrl: BASE,
        onClose: () => {},
      },
      () => {
        const copyButton = Array.from(document.body.querySelectorAll("button")).find(
          (button) => button.textContent === "Copy",
        )
        expect(copyButton).toBeDefined()
        const output = document.body.querySelector("output")
        expect(output?.textContent).toBe("sk-abc123")
      },
    )
  })

  test("says where to send the key, not just what it is", () => {
    withMount(
      {
        open: true,
        name: "ci-runner",
        value: "sk-abc123",
        minted: true,
        baseUrl: BASE,
        onClose: () => {},
      },
      () => {
        expect(document.body.textContent).toContain("Point your tool at it")
        expect(document.body.textContent).toContain(`ANTHROPIC_BASE_URL="${BASE}"`)
      },
    )
  })

  test("renders nothing when closed", () => {
    withMount(
      {
        open: false,
        name: "ci-runner",
        value: "sk-abc123",
        minted: true,
        baseUrl: BASE,
        onClose: () => {},
      },
      () => {
        expect(document.body.textContent).toBe("")
      },
    )
  })
})
