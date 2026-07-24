import type { RouteSectionProps } from "@solidjs/router"
import { type Component, lazy } from "solid-js"
import type { IconName } from "../components/Icon"

// The lazy route table. Every screen is a separate chunk, so the login page
// ships the shell and nothing else — an operator console that hands the whole
// console to an unauthenticated visitor is doing it wrong.
//
// This module stays cheap on purpose: paths, labels, icon names and import
// thunks. The thunks are not called until a route matches, and the `IconName`
// import is types-only, so nothing here drags a screen into the entry chunk.

export interface ConsoleRoute {
  readonly path: string
  readonly component: Component<RouteSectionProps>
  /** Nav label. Every console route has one — the nav is derived from this table. */
  readonly label: string
  readonly icon: IconName
  /** `/` would otherwise match every path as a prefix and mark itself current. */
  readonly end?: boolean
}

export const LOGIN_PATH = "/login"

/**
 * Where to send an operator whose session just ended, carrying the surface they
 * were on so signing back in returns them there.
 *
 * The login screen itself is never a destination — a redirect loop back to
 * `/login?next=/login` is the bug this guard rules out.
 */
export function loginPathFor(pathname: string): string {
  if (pathname === LOGIN_PATH || pathname === "/") return LOGIN_PATH
  return `${LOGIN_PATH}?next=${encodeURIComponent(pathname)}`
}

/**
 * Reads `?next=` back, refusing anything that is not a path on this origin.
 * `//evil.example` is the case that matters: browsers treat a leading double
 * slash as protocol-relative, so it is an off-origin redirect wearing a path's
 * clothes. An open redirect on a login form is how a phished operator ends up
 * authenticating somewhere else entirely.
 */
export function safeNextPath(value: string | string[] | undefined): string {
  if (typeof value !== "string") return "/"
  if (!value.startsWith("/") || value.startsWith("//")) return "/"
  return value
}

/** Rendered outside the authed shell. */
export const LoginScreen = lazy(() => import("../routes/LoginRoute"))

/** The authed shell itself: sidebar, drawer, skip link, theme toggle. */
export const AppShell = lazy(() => import("../layout/AppLayout"))

export const NotFoundScreen = lazy(() => import("../routes/NotFoundRoute"))

/**
 * The documented console surfaces, in the order an operator works through
 * them. Single source of truth for both the router and the navigation.
 */
export const CONSOLE_ROUTES: readonly ConsoleRoute[] = [
  {
    path: "/",
    label: "Overview",
    icon: "overview",
    end: true,
    component: lazy(() => import("../routes/OverviewRoute")),
  },
  {
    path: "/accounts",
    label: "Accounts",
    icon: "accounts",
    component: lazy(() => import("../routes/AccountsRoute")),
  },
  {
    path: "/pools",
    label: "Pools",
    icon: "pools",
    component: lazy(() => import("../routes/PoolsRoute")),
  },
  {
    path: "/keys",
    label: "Keys",
    icon: "keys",
    component: lazy(() => import("../routes/KeysRoute")),
  },
  {
    path: "/usage",
    label: "Usage",
    icon: "usage",
    component: lazy(() => import("../routes/UsageRoute")),
  },
  {
    path: "/settings",
    label: "Settings",
    icon: "settings",
    component: lazy(() => import("../routes/SettingsRoute")),
  },
]
