import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

// The API in production serves this bundle from its own origin, so there is no
// CORS layer to configure. Dev has two ports, and proxying the API's two path
// prefixes back through Vite keeps the origin single there too — cookie auth
// and CSRF behave in dev exactly as they do in the image.
const API_ORIGIN = "http://localhost:8080"

const proxyToApi = {
  target: API_ORIGIN,
  changeOrigin: false,
  // SSE and streamed completions must not be buffered by the dev proxy.
  ws: false,
}

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/v1": proxyToApi,
      "/admin": proxyToApi,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
  },
})
