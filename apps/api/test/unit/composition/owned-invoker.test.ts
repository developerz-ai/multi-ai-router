/**
 * The replica fence wraps a live answer and leaves an error alone: an error is already whole, and the
 * attempt seam reads its verdict by what the invoker returned. Re-wrapping it lost
 * `requestAttributable` for every fast-mode refusal (2.75.0 to 2.76.1), so one poisoned request
 * cooled the account everyone shares.
 */
import { expect, test } from "bun:test"
import { ownedInvoker } from "../../../src/composition/owned-invoker"
import { UpstreamAdmissionRefused } from "../../../src/providers/upstream-admission"

const lease = (assert: () => void = () => {}) => {
  const held = new AbortController()
  return { handle: () => ({ assert, signal: held.signal }), held }
}
const input = { accountId: "sub", signal: new AbortController().signal } as never

test("an error response is the very one the invoker returned", async () => {
  const refusal = Response.json({ type: "error" }, { status: 429 })

  expect(await ownedInvoker(lease() as never, async () => refusal)(input)).toBe(refusal)
})

test("a live answer is still cut when ownership is lost mid-stream", async () => {
  const owned = lease()
  const answer = await ownedInvoker(
    owned as never,
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull: (controller) => controller.enqueue(new Uint8Array([1])),
        }),
      ),
  )(input)
  const reader = answer.body?.getReader()
  await reader?.read()
  owned.held.abort()

  await expect(reader?.read()).rejects.toBeInstanceOf(UpstreamAdmissionRefused)
})

test("an error answered after ownership was lost is refused, not relayed", async () => {
  let held = true
  const owned = lease(() => {
    if (!held) throw new UpstreamAdmissionRefused("lost")
  })
  const call = ownedInvoker(owned as never, async () => {
    held = false
    return Response.json({}, { status: 429 })
  })(input)

  await expect(call).rejects.toBeInstanceOf(UpstreamAdmissionRefused)
})
