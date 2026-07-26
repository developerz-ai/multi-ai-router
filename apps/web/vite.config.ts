import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

// The API in production serves this bundle from its own origin, so there is no
// CORS layer to configure. Dev has two ports, and proxying the API's path
// prefixes back through Vite keeps the origin single there too — cookie auth
// and CSRF behave in dev exactly as they do in the image.
const API_ORIGIN = "http://localhost:8080"

const proxyToApi = {
  target: API_ORIGIN,
  changeOrigin: false,
  // SSE and streamed completions must not be buffered by the dev proxy.
  ws: false,
}

// The prefixes the API actually mounts. A proxy path that is *nearly* right
// fails silently — the request lands on Vite's own 404 and reads as a broken
// API rather than a broken config, which is exactly what `/admin` did here
// while the API mounts `/api/admin`.
//
//   /api      — every `ADMIN_*_BASE_PATH` in apps/api/src/routes/admin/*.ts is
//               `/api/admin/<group>`. One prefix, not five, so a new admin
//               group needs no change here.
//   /v1       — apps/api/src/routes/v1/, mounted at `DATA_PLANE_BASE_PATH`.
//   /healthz  — apps/api/src/routes/health.ts. Unguarded by design.
//   /readyz   — likewise.
//   /metrics  — apps/api/src/routes/metrics.ts.
//
// The same list, for the same reason, is `API_PREFIXES` in
// apps/api/src/routes/spa.ts: there the API is what must not be swallowed by
// the SPA's history-API fallback, here by Vite's. The two must agree.
const API_PREFIXES = ["/api", "/v1", "/healthz", "/readyz", "/metrics"] as const

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(API_PREFIXES.map((prefix) => [prefix, proxyToApi])),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
  },
})
