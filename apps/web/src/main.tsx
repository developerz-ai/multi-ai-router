import { QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import { App } from "./App"
import { ScreenErrorBoundary } from "./components/ScreenErrorBoundary"
import { queryClient } from "./lib/query"
import { installStaleBundleReload } from "./lib/stale-bundle"
import "./styles/global.scss"

const root = document.getElementById("root")

if (root === null) {
  throw new Error("#root is missing from index.html")
}

installStaleBundleReload()

// The outer boundary catches what the shell's own cannot: the login screen and the shell chunk.
render(
  () => (
    <ScreenErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ScreenErrorBoundary>
  ),
  root,
)
