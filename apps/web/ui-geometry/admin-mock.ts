// The admin API as seen by the browser during a geometry run: Playwright route
// mocks over `apps/web/ui-geometry/fixture.ts`. This layer is half of the
// "nothing leaves the runner" guarantee — there is no router process to serve
// `/api/admin/**`, so the SPA's fetches are answered in-process, and the
// catch-all below aborts anything aimed at any other origin before the network
// stack could emit it.
import type { BrowserContext } from "playwright"
import { accounts, keys, pools, providers, session, settings, usage } from "./fixture"

/** Everything `GET /api/admin/<path>` can answer with. Fixture-complete or the run fails. */
const GET: Readonly<Record<string, unknown>> = {
  "/api/admin/auth/session": session,
  "/api/admin/auth/methods": { passwordEnabled: false, oidcEnabled: false },
  "/api/admin/settings": settings,
  "/api/admin/providers": providers,
  "/api/admin/accounts": accounts,
  "/api/admin/keys": keys,
  "/api/admin/pools": pools,
  "/api/admin/usage": usage,
}

/** Origins a run may talk to: only the in-process static server. Anything else is a violation. */
export interface Egress {
  /** Requests the catch-all aborted because they left the static origin. */
  readonly blocked: readonly string[]
  /** Admin paths the fixture does not know — a fixture gap, not an app bug. */
  readonly unmapped: readonly string[]
}

export interface MockStack {
  readonly egress: Egress
  /** Cross-origin requests are aborted at the route layer, so the page can never depend on them. */
  readonly violations: () => readonly string[]
}

/** Install the mock API and the structural egress fence on one browser context. */
export function installAdminMock(context: BrowserContext, origin: string): MockStack {
  const blocked: string[] = []
  const unmapped: string[] = []

  // Registered first so the admin handler (registered second) takes precedence:
  // Playwright consults routes in reverse registration order.
  void context.route("**/*", (route) => {
    const url = new URL(route.request().url())
    if (url.origin === origin) {
      void route.continue()
      return
    }
    blocked.push(route.request().url())
    void route.abort()
  })

  void context.route("**/api/admin/**", (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() !== "GET") {
      // A geometry run reads; the SPA mutates only from operator actions, and
      // none happen. A mutation here means something navigated itself.
      unmapped.push(`${route.request().method()} ${url.pathname}`)
      void route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
      return
    }
    const body = GET[url.pathname]
    if (body === undefined) {
      unmapped.push(`GET ${url.pathname}`)
      void route.fulfill({ status: 404, contentType: "application/json", body: "{}" })
      return
    }
    void route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
  })

  const violations = () => [
    ...blocked.map((u) => `cross-origin request: ${u}`),
    ...unmapped.map((p) => `unmocked admin call: ${p}`),
  ]

  return { egress: { blocked, unmapped }, violations }
}
