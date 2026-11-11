import { describe, expect, test } from "bun:test"
import { createSignal, lazy } from "solid-js"
import { render } from "solid-js/web"
import { ScreenErrorBoundary } from "../../src/components/ScreenErrorBoundary"
import {
  reloadForStaleChunk,
  STALE_RELOAD_GUARD_MS,
  STALE_RELOAD_KEY,
} from "../../src/lib/stale-bundle"

/**
 * A screen that cannot render must say so and offer the reload — never leave `<main>` empty.
 *
 * The production case: a tab opened before a release imports `assets/<Screen>-<oldhash>.js`,
 * which the new build no longer serves, and the lazy route rejects.
 */

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

function mount(view: () => ReturnType<typeof ScreenErrorBoundary>) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(view, container)
  return {
    container,
    [Symbol.dispose]: () => {
      dispose()
      container.remove()
    },
  }
}

function reloadButton(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Reload console",
  )
}

describe("ScreenErrorBoundary", () => {
  test("a lazy screen whose chunk fails to load shows the reload prompt", async () => {
    const Screen = lazy(() =>
      Promise.reject(new TypeError("Failed to fetch dynamically imported module")),
    )
    let reloads = 0
    using mounted = mount(() => (
      <ScreenErrorBoundary reload={() => reloads++}>
        <Screen />
      </ScreenErrorBoundary>
    ))
    await settle()

    const button = reloadButton(mounted.container)
    expect(button).toBeDefined()
    expect(mounted.container.textContent).toContain("could not be shown")
    button?.click()
    expect(reloads).toBe(1)
  })

  test("a render throw shows the same prompt, and navigating away clears it", () => {
    const [path, setPath] = createSignal("/usage")
    const Broken = () => {
      if (path() === "/usage") throw new Error("shape drift")
      return <p>overview</p>
    }
    using mounted = mount(() => (
      <ScreenErrorBoundary reload={() => {}} resetKey={path}>
        <Broken />
      </ScreenErrorBoundary>
    ))

    expect(reloadButton(mounted.container)).toBeDefined()
    expect(mounted.container.textContent).toContain("shape drift")

    setPath("/")
    expect(reloadButton(mounted.container)).toBeUndefined()
    expect(mounted.container.textContent).toContain("overview")
  })
})

describe("reloadForStaleChunk", () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const items = new Map(Object.entries(initial))
    return {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    }
  }

  test("reloads once and records when", () => {
    const storage = memoryStorage()
    let reloads = 0
    expect(reloadForStaleChunk({ storage, reload: () => reloads++, nowMs: () => 1_000 })).toBe(true)
    expect(reloads).toBe(1)
    expect(storage.getItem(STALE_RELOAD_KEY)).toBe("1000")
  })

  test("does not loop: a second failure inside the guard window leaves it to the boundary", () => {
    const storage = memoryStorage({ [STALE_RELOAD_KEY]: "1000" })
    let reloads = 0
    const reload = () => reloads++
    expect(reloadForStaleChunk({ storage, reload, nowMs: () => 1_000 + 5_000 })).toBe(false)
    expect(
      reloadForStaleChunk({ storage, reload, nowMs: () => 1_000 + STALE_RELOAD_GUARD_MS }),
    ).toBe(true)
    expect(reloads).toBe(1)
  })

  test("without storage there is no guard, so no automatic reload", () => {
    let reloads = 0
    expect(reloadForStaleChunk({ storage: null, reload: () => reloads++, nowMs: () => 1 })).toBe(
      false,
    )
    const throwing = {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
    }
    expect(
      reloadForStaleChunk({ storage: throwing, reload: () => reloads++, nowMs: () => 1 }),
    ).toBe(false)
    expect(reloads).toBe(0)
  })
})
