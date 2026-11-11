import { createEffect, ErrorBoundary, type JSX, on } from "solid-js"
import { ErrorState } from "./ErrorState"

export interface ScreenErrorBoundaryProps {
  /** Clears the failure when it changes — the path, so the nav still gets the operator out. */
  readonly resetKey?: () => unknown
  /** Reloads the page. Injected so a test can see the press without leaving the page. */
  readonly reload?: () => void
  readonly children: JSX.Element
}

/**
 * What a screen shows when it cannot render: a chunk that failed to load, or a throw while
 * rendering. Without it the failure is uncaught and `<main>` stays empty with nothing saying why.
 *
 * The common cause is a release: a tab opened on the previous build asks for
 * `assets/<Screen>-<oldhash>.js`, which no longer exists. Reloading picks up the new build, so
 * that is the one action offered.
 */
export function ScreenErrorBoundary(props: ScreenErrorBoundaryProps) {
  return (
    <ErrorBoundary
      fallback={(error, reset) => {
        if (props.resetKey !== undefined) {
          createEffect(on(props.resetKey, () => reset(), { defer: true }))
        }
        return (
          <ErrorState
            error={error}
            onRetry={() => (props.reload ?? reloadPage)()}
            retryLabel="Reload console"
            title="This screen could not be shown. The console may have been updated since this tab loaded."
          />
        )
      }}
    >
      {props.children}
    </ErrorBoundary>
  )
}

function reloadPage(): void {
  window.location.reload()
}
