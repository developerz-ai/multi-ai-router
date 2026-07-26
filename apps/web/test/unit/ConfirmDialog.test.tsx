import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { ConfirmDialog } from "../../src/components/ConfirmDialog"
import { ApiError } from "../../src/lib/api/errors"

/**
 * `dispose` always runs, even if the assertion throws — `Modal` renders
 * through a `Portal` directly under `document.body`, shared by every test in
 * this process, so a leaked mount would bleed into whichever test runs next.
 */
function withMount(props: Parameters<typeof ConfirmDialog>[0], run: () => void): void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(() => <ConfirmDialog {...props} />, container)
  try {
    run()
  } finally {
    dispose()
    container.remove()
  }
}

describe("ConfirmDialog", () => {
  test("names exactly what breaks, one line per consequence — not a generic warning", () => {
    withMount(
      {
        open: true,
        title: "Delete account",
        subject: "prod-claude-1",
        consequences: [
          "Every key scoped only to this account stops routing.",
          "Usage history for this account is kept, not deleted.",
        ],
        confirmLabel: "Delete",
        onConfirm: () => {},
        onClose: () => {},
      },
      () => {
        const text = document.body.textContent ?? ""
        expect(text).toContain("Every key scoped only to this account stops routing.")
        expect(text).toContain("Usage history for this account is kept, not deleted.")
        expect(text.toLowerCase()).not.toContain("cannot be undone")
      },
    )
  })

  test("renders the server's own rejection sentence when a 409 comes back, not a bare status", () => {
    withMount(
      {
        open: true,
        title: "Delete pool",
        subject: "default-pool",
        consequences: ["Every key scoped to this pool would lose its candidates."],
        confirmLabel: "Delete",
        error: new ApiError(409, {
          message: "3 keys still scope to this pool: ci, staging, prod",
          type: "invalid_request_error",
          code: "pool_in_use",
        }),
        onConfirm: () => {},
        onClose: () => {},
      },
      () => {
        const text = document.body.textContent ?? ""
        expect(text).toContain("The router refused")
        expect(text).toContain("3 keys still scope to this pool: ci, staging, prod")
      },
    )
  })

  test("shows no rejection panel when there is no error", () => {
    withMount(
      {
        open: true,
        title: "Delete key",
        subject: "ci",
        consequences: ["Clients presenting this key are refused immediately."],
        confirmLabel: "Delete",
        onConfirm: () => {},
        onClose: () => {},
      },
      () => {
        expect(document.body.querySelector('[role="alert"]')).toBeNull()
      },
    )
  })
})
