import { A, type RouteSectionProps, useLocation } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { Icon } from "../components/Icon"
import { ThemeToggle } from "../components/ThemeToggle"
import { createFocusTrap } from "../lib/focus-trap"
import { createMediaQuery, SIDEBAR_QUERY } from "../lib/media"
import { CONSOLE_ROUTES } from "../lib/routes"
import { createScrollLock } from "../lib/scroll-lock"
import styles from "./AppLayout.module.scss"

/**
 * Chrome for every authenticated surface. `/login` renders outside it — a login
 * screen with a nav to pages you cannot reach is a bug, not a shell.
 *
 * One nav element serves both layouts. Below `SIDEBAR_QUERY` it is a modal
 * off-canvas drawer; at and above it, a permanent full-height sidebar. Nothing
 * is duplicated, so a link cannot exist in one and not the other.
 */
export default function AppLayout(props: RouteSectionProps) {
  const isSidebar = createMediaQuery(SIDEBAR_QUERY)
  const [drawerOpen, setDrawerOpen] = createSignal(false)
  const location = useLocation()

  let navRef: HTMLElement | undefined
  let toggleRef: HTMLButtonElement | undefined

  /** The nav is modal only while it is a drawer. As a sidebar it never is. */
  const modal = createMemo(() => !isSidebar() && drawerOpen())
  /** Closed drawer: out of the a11y tree and out of the tab order entirely. */
  const navHidden = createMemo(() => !isSidebar() && !drawerOpen())

  const close = () => setDrawerOpen(false)

  // Navigating is the drawer's whole job; once it is done, get out of the way.
  createEffect(on(() => location.pathname, close, { defer: true }))

  // Growing past the breakpoint turns the drawer into the sidebar. Drop the
  // open state so shrinking back does not reveal a drawer nobody opened.
  createEffect(
    on(isSidebar, (wide) => {
      if (wide) close()
    }),
  )

  createFocusTrap({
    container: () => navRef,
    active: modal,
    onEscape: close,
    restoreTo: () => toggleRef,
  })
  createScrollLock(modal)

  return (
    <div class={styles.shell}>
      <a class={styles.skipLink} href="#main">
        Skip to content
      </a>

      <header class={styles.topbar}>
        <button
          aria-controls="app-nav"
          aria-expanded={drawerOpen() ? "true" : "false"}
          aria-label={drawerOpen() ? "Close navigation" : "Open navigation"}
          class={styles.menuButton}
          onClick={() => setDrawerOpen(!drawerOpen())}
          ref={toggleRef}
          type="button"
        >
          <Icon name={drawerOpen() ? "close" : "menu"} />
        </button>
        <span class={styles.topbarBrand}>multi-ai-router</span>
      </header>

      <Show when={modal()}>
        {/* Dismiss on outside tap. Keyboard users get Escape. */}
        <div aria-hidden="true" class={styles.scrim} onClick={close} />
      </Show>

      <nav
        aria-label="Sections"
        class={styles.sidebar}
        data-open={drawerOpen() ? "true" : "false"}
        id="app-nav"
        inert={navHidden()}
        ref={navRef}
      >
        <div class={styles.brand}>
          <span class={styles.brandName}>multi-ai-router</span>
          <span class={styles.brandNote}>admin console</span>
        </div>

        <ul class={styles.navList}>
          <For each={CONSOLE_ROUTES}>
            {(route) => (
              <li>
                <A
                  activeClass={styles.navLinkActive}
                  class={styles.navLink}
                  end={route.end === true}
                  href={route.path}
                >
                  {/* The current route is marked by shape and weight as well as
                      colour: a rail on the inline edge plus a heavier label. */}
                  <span aria-hidden="true" class={styles.navRail} />
                  <Icon name={route.icon} />
                  <span class={styles.navLabel}>{route.label}</span>
                </A>
              </li>
            )}
          </For>
        </ul>

        <div class={styles.navFooter}>
          <ThemeToggle />
        </div>
      </nav>

      <main class={styles.main} id="main" tabindex="-1">
        {props.children}
      </main>
    </div>
  )
}
