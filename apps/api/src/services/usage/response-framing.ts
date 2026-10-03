/** Observes complete bounded frames independently of the already-forwarded byte stream. */
export function createResponseFraming(input: {
  readonly contentType: string | null
  readonly maximumBytes: number
  readonly payload: (body: unknown, event: string | undefined) => void
  readonly done: () => void
  readonly unavailable: () => void
}) {
  const media = input.contentType?.split(";", 1)[0]?.trim().toLowerCase()
  const sse = media === "text/event-stream"
  const json = media === "application/json" || media?.endsWith("+json") === true
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let line: number[] = []
  let data: string[] = []
  let event: string | undefined
  let eventBytes = 0
  let dropping = false
  let pendingCR = false
  let ended = false
  const parse = (text: string, name?: string) => {
    if (text === "[DONE]") {
      if (sse) input.done()
      else input.unavailable()
      return
    }
    try {
      input.payload(JSON.parse(text), name)
    } catch {
      input.unavailable()
    }
  }
  const reset = () => {
    data = []
    event = undefined
    eventBytes = 0
    dropping = false
  }
  const consumeLine = () => {
    if (line.length === 0) {
      if (!dropping && data.length > 0) parse(data.join("\n"), event)
      reset()
      return
    }
    if (dropping) {
      line = []
      return
    }
    let text: string
    try {
      text = decoder.decode(Uint8Array.from(line))
    } catch {
      input.unavailable()
      dropping = true
      line = []
      return
    }
    const bytes = line.length
    line = []
    if (text.startsWith("data:")) {
      let value = text.slice(5)
      if (value.startsWith(" ")) value = value.slice(1)
      data.push(value)
      eventBytes += bytes + 1
    } else if (text.startsWith("event:")) {
      event = text.slice(6).trimStart()
      eventBytes += bytes
    }
    if (eventBytes > input.maximumBytes) {
      input.unavailable()
      data = []
      event = undefined
      eventBytes = 0
      dropping = true
    }
  }
  return {
    observe(chunk: Uint8Array) {
      if (ended) return
      if (!sse && !json) {
        input.unavailable()
        return
      }
      for (const byte of chunk) {
        if (sse && (byte === 10 || byte === 13)) {
          if (byte === 10 && pendingCR) {
            pendingCR = false
            continue
          }
          consumeLine()
          pendingCR = byte === 13
          continue
        }
        pendingCR = false
        // A discarded line still needs its length distinction at the next blank boundary.
        if (dropping) {
          if (line.length === 0) line.push(0)
          continue
        }
        if (line.length + eventBytes >= input.maximumBytes) {
          input.unavailable()
          line = sse ? [0] : []
          data = []
          event = undefined
          eventBytes = 0
          dropping = true
        } else line.push(byte)
      }
    },
    finish() {
      if (ended) return
      ended = true
      if (json && !dropping && line.length > 0) {
        try {
          parse(decoder.decode(Uint8Array.from(line)))
        } catch {
          input.unavailable()
        }
      } else if (!sse && !json) input.unavailable()
      else if (line.length > 0 || data.length > 0 || dropping) input.unavailable()
      line = []
      reset()
    },
    get retainedBytes() {
      return line.length + eventBytes
    },
  }
}
