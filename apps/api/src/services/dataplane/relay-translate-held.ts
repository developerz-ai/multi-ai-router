import type { Dialect } from "@multi-ai-router/core"
import { refusalBody } from "../../errors/render"
import { TranslationStreamError } from "../translate/shared/stream-error"
import { join } from "./relay-body-read"

/**
 * A non-streamed translated answer is read whole before it is converted, so nothing obliges the
 * router to commit a status first. It is held until the conversion decides: a body the translator
 * could not convert faithfully (undecodable tool arguments, a truncated forced stream) is answered
 * as a typed `502` in the client's dialect — never a `200` whose body breaks off (ruling on plan
 * 101, 06.4). Any other failure (the client left, the upstream broke) keeps the old shape: the body
 * errors, and the relay's own row says why.
 */

/** Who to name in the refusal: the router's own verdict on one account's untranslatable answer. */
export interface HeldRefusalFacts {
  readonly ingress: Dialect
  readonly requestId: string | null
  readonly accountId: string
  readonly attempt: number
}

/** The status a translation failure on a non-streamed answer is refused with. Stable. */
export const TRANSLATION_FAILURE_STATUS = 502

/**
 * The status the client was answered with when a held translation was refused, else `undefined`:
 * only a non-streaming client of a translated answer is held (`held`), and only a translation
 * failure before any byte is answered rather than cut.
 */
export function refusedStatus(
  error: unknown,
  streamed: boolean,
  held: boolean,
): number | undefined {
  return error instanceof TranslationStreamError && !streamed && held
    ? TRANSLATION_FAILURE_STATUS
    : undefined
}

const decided = new WeakMap<Response, Promise<Response>>()

/** The decided answer for a held translated response, when it is one. */
export function decidedTranslation(response: Response): Promise<Response> | undefined {
  return decided.get(response)
}

/**
 * Reads `body` (the converted answer) to its end, then answers with it, or with the typed refusal.
 * The returned stand-in carries the same bytes for a caller that never asks for the decision.
 */
export function holdTranslated(
  body: ReadableStream<Uint8Array>,
  init: ResponseInit,
  facts: HeldRefusalFacts | undefined,
): Response {
  // The bytes are decided once; each Response built from them owns its own body.
  const reader = body.getReader()
  const decision: Promise<Decided> = readAll(() => reader.read()).then(
    (bytes) => ({ bytes, init }),
    (error: unknown) => {
      if (error instanceof TranslationStreamError && facts !== undefined)
        return refusal(error, facts)
      throw error
    },
  )
  const answer = (decided: Decided) => new Response(decided.bytes, decided.init)
  const standIn = new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue((await decision).bytes)
          controller.close()
        } catch (error) {
          controller.error(error)
        }
      },
      // A caller reading the stand-in that goes away cancels the held read, as before.
      cancel(reason) {
        return reader.cancel(reason)
      },
    }),
    init,
  )
  decided.set(
    standIn,
    decision.then(answer, (error: unknown) => new Response(failing(error), init)),
  )
  return standIn
}

async function readAll(
  read: () => Promise<{ readonly done: boolean; readonly value?: Uint8Array | undefined }>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await read()
    if (done || value === undefined) break
    chunks.push(value)
    total += value.length
  }
  return join(chunks, total)
}

interface Decided {
  readonly bytes: Uint8Array
  readonly init: ResponseInit
}

function refusal(error: TranslationStreamError, facts: HeldRefusalFacts): Decided {
  const body = refusalBody(
    facts.ingress,
    TRANSLATION_FAILURE_STATUS,
    `the upstream's answer could not be translated faithfully: ${error.message}`,
    error.errorClass,
    {
      // The router could not represent this account's answer; resending the same turn to the same
      // account is not expected to change it.
      wall: "internal",
      scope: "account",
      signal: error.errorClass,
      attempts: facts.attempt,
      accounts: [{ accountId: facts.accountId, state: error.errorClass }],
    },
    facts.requestId,
  )
  return {
    bytes: new TextEncoder().encode(JSON.stringify(body)),
    init: {
      status: TRANSLATION_FAILURE_STATUS,
      headers: { "content-type": "application/json" },
    },
  }
}

function failing(error: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(error)
    },
  })
}
