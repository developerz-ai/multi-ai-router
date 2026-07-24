import { QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import { App } from "./App"
import { queryClient } from "./lib/query"
import "./styles/global.scss"

const root = document.getElementById("root")

if (root === null) {
  throw new Error("#root is missing from index.html")
}

render(
  () => (
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  ),
  root,
)
