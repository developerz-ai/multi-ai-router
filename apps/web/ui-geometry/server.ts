// The static file server a geometry run serves the built SPA from — the browser
// half of the "no router process exists" guarantee. It owns exactly one origin,
// 127.0.0.1 on an ephemeral port, and never proxies anywhere: the only things it
// can hand out are files under the built dist directory it is handed.
import { serve } from "bun"

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".map": "application/json",
}

export interface StaticServer {
  readonly origin: string
  stop: () => void
}

/**
 * Serve `distDir` with the SPA's history-API fallback: any path that is not a
 * file answers `index.html`, exactly as the router's own SPA handler does, so
 * `/accounts` and `/keys` deep links work.
 */
export function startStaticServer(distDir: string): Promise<StaticServer> {
  return new Promise((resolve, reject) => {
    const server = serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 255,
      fetch(request): Response | Promise<Response> {
        const url = new URL(request.url)
        // Only GET is meaningful for static assets; anything else on this origin
        // is a bug in the harness, not something to paper over.
        if (
          request.method !== "GET" ||
          url.hostname !== "127.0.0.1" ||
          url.pathname.includes("..")
        ) {
          return new Response("not found", { status: 404 })
        }
        // Resolve inside dist only: a crafted path must not read outside it.
        const path = `${distDir}/${url.pathname}`.replace(/\/+$/, "")
        const file = Bun.file(path)
        // The fallback is the whole point of the SPA fallback: deep links first.
        return file.exists().then((exists) => {
          if (exists && url.pathname !== "/") return fileResponse(path)
          return fileResponse(`${distDir}/index.html`)
        })
      },
    })

    server.unref?.()
    if (!server.url) {
      reject(new Error("static server failed to bind"))
      return
    }
    resolve({ origin: server.url.toString().replace(/\/$/, ""), stop: () => server.stop(true) })
  })
}

function fileResponse(path: string): Response {
  const dot = path.lastIndexOf(".")
  const type =
    dot === -1
      ? "application/octet-stream"
      : (CONTENT_TYPES[path.slice(dot)] ?? "application/octet-stream")
  const file = Bun.file(path)
  return new Response(file, { headers: { "content-type": type } })
}
