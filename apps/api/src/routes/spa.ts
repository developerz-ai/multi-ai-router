import type { MiddlewareHandler } from "hono"
import { Hono } from "hono"
import { serveStatic } from "hono/bun"
import type { AppEnv } from "../types"

/**
 * The built admin SPA, served by the router process itself.
 *
 * Same origin as `/api/admin/**` on purpose: the console authenticates with a `SameSite=Strict`
 * session cookie, so a second origin would mean CORS, a relaxed cookie policy, and a CSRF story
 * that is weaker than the one we have. One process, one origin, no proxy to configure.
 *
 * Two behaviours, and both are what makes a client-routed app work over plain HTTP:
 *
 * - **Files win.** `assets/<name>-<hash>.js` is answered from disk with its own MIME type.
 * - **Everything else is `index.html`.** `/accounts` is a route in the SolidJS router, not a file;
 *   a reload on it must return the shell and let the client decide. That is the history-API
 *   fallback, and without it every deep link is a 404.
 *
 * **It can never answer for the API.** The mount is registered last, after every API route, so a
 * path a route already claimed is answered by that route and the chain stops before it gets here.
 * The prefix guard below covers the other half — an *unknown* path under an API prefix, which
 * would otherwise be handed a page of HTML by the fallback. `POST /accounts` is not a document
 * request either, so a wrong-method call to a real API path still gets JSON rather than a page.
 */

/**
 * Prefixes the API owns. A path under one of these is never answered from disk and never gets the
 * shell: it falls through to `notFoundHandler`, which renders the dialect-appropriate JSON.
 *
 * Kept here rather than derived from the mounted routers because it must hold for paths no router
 * claims — the exact case a derived list could not see. It mirrors `apps/web/vite.config.ts`'s
 * `API_PREFIXES`, which is the same statement made to the dev proxy.
 */
const API_PREFIXES = ["/api", "/v1", "/healthz", "/readyz", "/metrics"] as const

/** The document methods a browser navigates with. Anything else is an API call, wrong. */
const DOCUMENT_METHODS = ["GET", "HEAD"]

const INDEX_DOCUMENT = "index.html"

/**
 * Vite content-hashes everything under `assets/`, so a byte change is a name change and the old
 * name is never reused. That makes a year-long immutable cache correct rather than optimistic.
 */
const IMMUTABLE_ASSET_PREFIX = "/assets/"
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"

/**
 * The shell, by contrast, is revalidated every time. It names the hashed bundles, so a cached copy
 * surviving an image upgrade points at files that no longer exist — a white screen an operator
 * cannot clear from the server side.
 */
const DOCUMENT_CACHE_CONTROL = "no-cache"

export interface SpaRoutesDeps {
  /** Directory holding the Vite build — `index.html` plus `assets/`. */
  readonly root: string
}

export function spaRoutes(deps: SpaRoutesDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  const file = serveStatic({
    root: deps.root,
    onFound: (_path, c) => {
      c.header("Cache-Control", cacheControlFor(c.req.path))
    },
  })

  // A fixed `path` — never the request's — so the fallback cannot be steered at a file, whatever
  // the URL says. Hono's static middleware already refuses `..` segments; this needs no traversal
  // defence because it reads one name.
  const shell = serveStatic({
    root: deps.root,
    path: INDEX_DOCUMENT,
    onFound: (_path, c) => {
      c.header("Cache-Control", DOCUMENT_CACHE_CONTROL)
    },
  })

  // Two registrations, in this order: the file server answers what exists, and hands anything
  // missing to the shell by calling `next()`.
  routes.on(DOCUMENT_METHODS, "*", exceptApiPaths(file))
  routes.on(DOCUMENT_METHODS, "*", exceptApiPaths(shell))

  return routes
}

/** Wraps a static handler so a path the API owns is passed straight through, never answered. */
function exceptApiPaths(handler: MiddlewareHandler): MiddlewareHandler {
  return (c, next) => (isApiPath(c.req.path) ? next() : handler(c, next))
}

function isApiPath(path: string): boolean {
  return API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

function cacheControlFor(path: string): string {
  return path.startsWith(IMMUTABLE_ASSET_PREFIX) ? IMMUTABLE_CACHE_CONTROL : DOCUMENT_CACHE_CONTROL
}
