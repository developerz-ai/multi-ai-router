import { createServer as createHttpsServer } from "node:https"
import { connect, createServer as createTcpServer } from "node:net"
import { inspectClientHello } from "./tls-hello"

export interface LocalRequest {
  readonly rawHeaders: readonly string[]
  readonly body: string
}

/** Local authenticated-TLS stub and a byte-preserving ClientHello observer. No provider egress. */
export async function localOrigin(key: Buffer, cert: Buffer, model: string) {
  const captures: ReturnType<typeof inspectClientHello>[] = []
  const requests: LocalRequest[] = []
  const frame = (value: { type: string } & Record<string, unknown>) =>
    `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`
  const answer = [
    {
      type: "message_start",
      message: {
        id: "msg_trace",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "LOCAL_OK" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]
    .map(frame)
    .join("")
  const sockets = new Set<import("node:net").Socket>()
  const upstream = createHttpsServer({ key, cert }, (request, response) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > 2 * 1024 * 1024) {
        request.destroy()
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    request.on("end", () => {
      if (!request.url?.startsWith("/v1/messages")) {
        response.writeHead(404).end("{}")
        return
      }
      requests.push({
        rawHeaders: request.rawHeaders,
        body: Buffer.concat(chunks).toString("utf8"),
      })
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(answer)
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const backend = upstream.address()
  if (!backend || typeof backend === "string") throw new Error("cannot bind local TLS origin")
  const proxy = createTcpServer((socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    const remote = connect(backend.port, "127.0.0.1")
    let raw = Buffer.alloc(0)
    let done = false
    socket.on("data", (chunk) => {
      if (done) return
      raw = Buffer.concat([raw, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
      if (raw.length >= 5 && raw.length >= 5 + raw.readUInt16BE(3)) {
        done = true
        captures.push(inspectClientHello(raw))
        raw = Buffer.alloc(0)
      }
    })
    socket.pipe(remote)
    remote.pipe(socket)
    socket.on("error", () => remote.destroy())
    remote.on("error", () => socket.destroy())
  })
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  const front = proxy.address()
  if (!front || typeof front === "string") throw new Error("cannot bind TLS observer")
  return {
    url: `https://localhost:${front.port}`,
    captures,
    requests,
    close() {
      for (const socket of sockets) socket.destroy()
      proxy.close()
      upstream.closeAllConnections()
      upstream.close()
    },
  }
}

/** Let Bun generate transport framing; passing those back as custom headers changes their order. */
export function replayHeaders(rawHeaders: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {}
  const managed = new Set(["connection", "host", "accept-encoding", "content-length"])
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]
    const value = rawHeaders[i + 1]
    if (name && value !== undefined && !managed.has(name.toLowerCase())) result[name] = value
  }
  return result
}
