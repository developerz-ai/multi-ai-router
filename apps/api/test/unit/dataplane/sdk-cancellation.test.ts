import { expect, test } from "bun:test"
import { sdkCancellation } from "../../../src/services/dataplane/sdk-cancellation"

for (const first of ["caller", "deadline"] as const) {
  test(`SDK wrapped abort keeps ${first} as the first cause`, () => {
    const caller = new AbortController()
    const deadline = new AbortController()
    const signal = AbortSignal.any([deadline.signal, caller.signal])
    if (first === "caller") caller.abort(new Error("caller ended request"))
    else deadline.abort(new DOMException("deadline elapsed", "TimeoutError"))
    if (first === "caller") deadline.abort(new DOMException("later deadline", "TimeoutError"))
    else caller.abort(new Error("later caller cancellation"))
    expect(
      sdkCancellation(new DOMException("wrapped abort", "AbortError"), signal, caller.signal),
    ).toBe(first)
    expect(sdkCancellation(signal.reason, signal, caller.signal)).toBe(first)
    expect(
      sdkCancellation(
        new Error("authentication_error: invalid credentials"),
        signal,
        caller.signal,
      ),
    ).toBeUndefined()
  })
}

/**
 * The SDK's own echo of an aborted launch controller: a plain `Error`, so neither its name nor its
 * identity is abort-shaped (#297). It attributes like any other wrapped abort — first cause wins —
 * and only while the composed signal is actually aborted.
 */
for (const first of ["caller", "deadline"] as const) {
  test(`SDK abort echo keeps ${first} as the first cause`, () => {
    const caller = new AbortController()
    const deadline = new AbortController()
    const signal = AbortSignal.any([deadline.signal, caller.signal])
    if (first === "caller") caller.abort(new Error("caller ended request"))
    else deadline.abort(new DOMException("deadline elapsed", "TimeoutError"))
    if (first === "caller") deadline.abort(new DOMException("later deadline", "TimeoutError"))
    else caller.abort(new Error("later caller cancellation"))
    expect(sdkCancellation(new Error("Operation aborted"), signal, caller.signal)).toBe(first)
    const stamped = new Error("Claude Code process aborted by user") as Error & {
      errorClass?: string
    }
    stamped.errorClass = "aborted"
    expect(sdkCancellation(stamped, signal, caller.signal)).toBe(first)
  })
}

test("SDK abort echo with a live signal is an SDK-side abort, not a cancellation", () => {
  const caller = new AbortController()
  const deadline = new AbortController()
  const signal = AbortSignal.any([deadline.signal, caller.signal])
  expect(sdkCancellation(new Error("Operation aborted"), signal, caller.signal)).toBeUndefined()
  expect(sdkCancellation(new Error("Operation aborted"), signal, undefined)).toBeUndefined()
})
