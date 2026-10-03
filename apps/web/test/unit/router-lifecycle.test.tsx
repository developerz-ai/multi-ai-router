import { afterEach, describe, expect, test } from "bun:test"
import { A, createMemoryHistory, MemoryRouter, Route, useNavigate } from "@solidjs/router"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { render } from "solid-js/web"

const disposals: (() => void)[] = []

afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
})

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("router lifecycle across console and login navigation", () => {
  test("disposed outlets stay disposed when login replaces the console and it mounts again", async () => {
    const history = createMemoryHistory()
    history.set({ value: "/accounts" })
    const [visible, setVisible] = createSignal(true)
    let mounted = 0
    let disposed = 0
    let navigate: ReturnType<typeof useNavigate> | undefined

    function Accounts() {
      onMount(() => mounted++)
      onCleanup(() => disposed++)
      navigate = useNavigate()
      return <p>Account list</p>
    }

    const container = document.createElement("div")
    document.body.appendChild(container)
    const stop = render(
      () => (
        <Show when={visible()}>
          <MemoryRouter history={history}>
            <Route path="/accounts" component={Accounts} />
            <Route path="/login" component={() => <p>Login</p>} />
          </MemoryRouter>
        </Show>
      ),
      container,
    )
    disposals.push(() => {
      stop()
      container.remove()
    })
    await settle()
    expect(mounted).toBe(1)
    navigate?.("/login", { replace: true })
    await settle()
    expect(container.textContent).toBe("Login")
    expect(disposed).toBe(1)

    setVisible(false)
    await settle()
    history.set({ value: "/accounts" })
    setVisible(true)
    await settle()
    expect(container.textContent).toBe("Account list")
    expect(mounted).toBe(2)
    history.set({ value: "/login", replace: true })
    await settle()
    expect(container.textContent).toBe("Login")
    expect(disposed).toBe(2)
  })

  test("back and forward restore nested routes and exact active links", async () => {
    const history = createMemoryHistory()
    const container = document.createElement("div")
    document.body.appendChild(container)
    const stop = render(
      () => (
        <MemoryRouter history={history}>
          <Route
            path="/"
            component={(props) => (
              <>
                <A href="/" end activeClass="current">
                  Overview
                </A>
                <A href="/accounts/" activeClass="current">
                  Accounts
                </A>
                {props.children}
              </>
            )}
          >
            <Route path="/" component={() => <p>Overview page</p>} />
            <Route path="/accounts" component={() => <p>Account list</p>} />
            <Route path="*" component={() => <p>Not found</p>} />
          </Route>
        </MemoryRouter>
      ),
      container,
    )
    disposals.push(() => {
      stop()
      container.remove()
    })
    await settle()
    history.set({ value: "/accounts" })
    await settle()
    expect(container.querySelector("p")?.textContent).toBe("Account list")
    expect(container.querySelector('a[href="/"]')?.classList.contains("current")).toBe(false)
    expect(container.querySelector('a[href="/accounts/"]')?.classList.contains("current")).toBe(
      true,
    )
    history.back()
    await settle()
    expect(container.querySelector("p")?.textContent).toBe("Overview page")
    history.forward()
    await settle()
    expect(container.querySelector("p")?.textContent).toBe("Account list")
    history.set({ value: "/missing" })
    await settle()
    expect(container.querySelector("p")?.textContent).toBe("Not found")
  })
})
