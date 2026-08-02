import type { ClientFrame } from "./frames"

/**
 * The `Response`-writing half of `renderSdkResponse` (`stream.ts`): the pump contract, and the two
 * renderings of one frame sequence — SSE for a streaming client, one folded JSON body for a
 * non-streaming one. Split from the pump so the file that decides *what* the frames are stays
 * separate from the one that decides how they leave the process.
 */

/** `done` is true when the SDK loop is already over and `frames` are its terminal ones. */
export interface Primed {
  readonly frames: readonly ClientFrame[]
  readonly done: boolean
}

export interface Pump {
  /** Reads until the first client frames exist, or the loop ends and its terminal frames do. */
  prime(): Promise<Primed>
  /** @returns the next client frames, or null once the loop has ended. */
  next(): Promise<readonly ClientFrame[] | null>
  /** The terminal frames the client is owed. */
  finish(): readonly ClientFrame[]
  /** The terminal `error` frame for a failure that arrived after the first byte. */
  fail(error: unknown): readonly ClientFrame[]
  /** Installs the keep-alive writer, once a client stream exists to write to. */
  heartbeat(write: () => void): void
  /** Client bytes went out; the keep-alive clock restarts. */
  wrote(): void
  close(): void
}

const EVENT_STREAM_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
} as const

const JSON_HEADERS = { "content-type": "application/json" } as const

/** The keep-alive comment. An SSE comment line carries no event and no data — only a byte. */
const PING = ": ping\n\n"

export async function drain(
  pump: Pump,
  sink: (frames: readonly ClientFrame[]) => void,
): Promise<void> {
  for (;;) {
    const frames = await pump.next()
    if (frames === null) break
    sink(frames)
  }
  sink(pump.finish())
}

export function sseResponse(pump: Pump, primed: Primed): Response {
  const encoder = new TextEncoder()

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string): void => {
        if (text.length === 0) return
        // Enqueue first. Everything after this line happens on time the client already has.
        controller.enqueue(encoder.encode(text))
        pump.wrote()
      }
      pump.heartbeat(() => write(PING))

      try {
        write(encode(primed.frames))
        if (!primed.done) await drain(pump, (frames) => write(encode(frames)))
      } catch (error) {
        // Bytes are already out, so the status cannot say this. The frame does.
        write(encode(pump.fail(error)))
      } finally {
        pump.close()
        controller.close()
      }
    },

    cancel() {
      pump.close()
    },
  })

  return new Response(body, { status: 200, headers: EVENT_STREAM_HEADERS })
}

export function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function encode(frames: readonly ClientFrame[]): string {
  let out = ""
  for (const frame of frames) out += `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`
  return out
}
