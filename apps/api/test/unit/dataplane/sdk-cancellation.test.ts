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
