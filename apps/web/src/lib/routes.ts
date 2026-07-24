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
