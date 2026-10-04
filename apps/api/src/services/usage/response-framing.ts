import { createResponseSalvage, type ResponseSalvage } from "./response-salvage"

const DATA_FIELD = [100, 97, 116, 97, 58] // "data:"
const encoder = new TextEncoder()

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
  // An over-cap frame is not dropped outright: its bytes stream through a bounded salvage scanner
  // that keeps only the shallow usage/terminal members (see response-salvage.ts).
  let salvage: ResponseSalvage | null = null
  let salvageLineBytes = 0
  let salvageField: "pending" | "data" | "skip" = "pending"
  let salvageDataSeen = false
  let salvageSpace = false
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
    salvage = null
  }
  const settleSalvage = (scanner: ResponseSalvage) => {
    const body = scanner.finish()
    if (body === null) input.unavailable()
    else input.payload(body, event)
  }
  /** SSE field handling while salvaging: only `data:` values reach the scanner, joined by LF. */
  const salvageByte = (scanner: ResponseSalvage, byte: number) => {
    const at = salvageLineBytes++
    if (salvageField === "data") {
      if (salvageSpace) {
        salvageSpace = false
        if (byte === 32) return
      }
      scanner.push(byte)
    } else if (salvageField === "pending") {
      if (byte !== DATA_FIELD[at]) salvageField = "skip"
      else if (at === DATA_FIELD.length - 1) {
        salvageField = "data"
        salvageSpace = true
        if (salvageDataSeen) scanner.push(10)
        salvageDataSeen = true
      }
    }
  }
  const startSalvage = (): ResponseSalvage => {
    const scanner = createResponseSalvage(input.maximumBytes)
    data.forEach((text, index) => {
      if (index > 0) scanner.push(10)
      for (const byte of encoder.encode(text)) scanner.push(byte)
    })
    salvageDataSeen = data.length > 0
    salvageLineBytes = 0
    salvageField = "pending"
    data = []
    eventBytes = 0
    salvage = scanner
    return scanner
  }
  const consumeLine = () => {
    if (salvage !== null) {
      if (salvageLineBytes === 0) {
        settleSalvage(salvage)
        reset()
      }
      salvageLineBytes = 0
      salvageField = "pending"
      return
    }
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
    if (eventBytes > input.maximumBytes) startSalvage()
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
        if (salvage !== null) {
          if (sse) salvageByte(salvage, byte)
          else salvage.push(byte)
          continue
        }
        // A discarded line still needs its length distinction at the next blank boundary.
        if (dropping) {
          if (line.length === 0) line.push(0)
          continue
        }
        if (line.length + eventBytes >= input.maximumBytes) {
          const pending = line
          line = []
          const scanner = startSalvage()
          for (const held of pending) {
            if (sse) salvageByte(scanner, held)
            else scanner.push(held)
          }
          if (sse) salvageByte(scanner, byte)
          else scanner.push(byte)
        } else line.push(byte)
      }
    },
    finish() {
      if (ended) return
      ended = true
      if (json && salvage !== null) settleSalvage(salvage)
      else if (json && !dropping && line.length > 0) {
        try {
          parse(decoder.decode(Uint8Array.from(line)))
        } catch {
          input.unavailable()
        }
      } else if (!sse && !json) input.unavailable()
      else if (line.length > 0 || data.length > 0 || dropping || salvage !== null)
        input.unavailable()
      line = []
      reset()
    },
    get retainedBytes() {
      return line.length + eventBytes + (salvage?.retainedBytes ?? 0)
    },
  }
}
