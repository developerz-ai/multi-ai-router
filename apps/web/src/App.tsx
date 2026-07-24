import { Route, Router } from "@solidjs/router"
import { AppShell, CONSOLE_ROUTES, LOGIN_PATH, LoginScreen, NotFoundScreen } from "./lib/routes"

/**
 * The route shell. `/login` sits outside `AppShell`; every console surface
 * nests inside it, so the nav is defined once and derived from the same table.
 */
export function App() {
  return (
    <Router>
      <Route path={LOGIN_PATH} component={LoginScreen} />
      <Route path="/" component={AppShell}>
        {/*
          `.map`, not `<For>`: the router walks its children once at setup to
          build the match tree, and a `<For>` yields a memo it cannot walk.
          This is static configuration, not reactive data — the one place in the
          app where mapping is the correct choice.
        */}
        {CONSOLE_ROUTES.map((route) => (
          <Route path={route.path} component={route.component} />
        ))}
        <Route path="*" component={NotFoundScreen} />
      </Route>
    </Router>
  )
}
