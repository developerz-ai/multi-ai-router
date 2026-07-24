import { A, type RouteSectionProps } from "@solidjs/router"
import { For } from "solid-js"
import { ThemeToggle } from "../components/ThemeToggle"
import { CONSOLE_ROUTES } from "../lib/routes"
import styles from "./AppLayout.module.scss"

/**
 * Chrome for every authenticated surface. `/login` renders outside it — a login
 * screen with a nav to pages you cannot reach is a bug, not a shell.
 */
export default function AppLayout(props: RouteSectionProps) {
  return (
    <div class={styles.shell}>
      <a class={styles.skipLink} href="#main">
        Skip to content
      </a>
      <aside class={styles.sidebar}>
        <div class={styles.brand}>
          multi-ai-router
          <span class={styles.brandNote}>admin console</span>
        </div>
        <nav class={styles.nav} aria-label="Sections">
          <For each={CONSOLE_ROUTES}>
            {(route) => (
              <A
                class={styles.navLink}
                activeClass={styles.navLinkActive}
                href={route.path}
                end={route.end === true}
              >
                {route.label}
              </A>
            )}
          </For>
        </nav>
        <div class={styles.footer}>
          <ThemeToggle />
        </div>
      </aside>
      <main class={styles.main} id="main" tabindex="-1">
        {props.children}
      </main>
    </div>
  )
}
