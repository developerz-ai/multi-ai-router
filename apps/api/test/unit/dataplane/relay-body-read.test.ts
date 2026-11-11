import { expect, test } from "bun:test"
import { readRelayBody } from "../../../src/services/dataplane/relay-body-read"
import { TranslationStreamError } from "../../../src/services/translate/shared/stream-error"

// Plan 101, 02.9: a body the router must read whole is bounded; past the cap the read fails with a
// typed error and the upstream is cancelled, instead of growing until the attempt's deadline.
test("a body past the cap rejects with a typed error and cancels the upstream", async () => {
  let cancelled = false
  const upstream = new ReadableStream<Uint8Array>({
    pull: (controller) => controller.enqueue(new Uint8Array(1_024)),
    cancel: () => {
      cancelled = true
    },
  })
  const read = readRelayBody(upstream, undefined, 4_096)
  await expect(read).rejects.toBeInstanceOf(TranslationStreamError)
  expect(cancelled).toBe(true)
})

test("a body inside the cap is returned whole", async () => {
  const bytes = await readRelayBody(
    new Response("hello").body ?? new ReadableStream(),
    undefined,
    5,
  )
  expect(new TextDecoder().decode(bytes)).toBe("hello")
})
