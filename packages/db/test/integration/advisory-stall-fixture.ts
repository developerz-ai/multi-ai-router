import { connect, createServer, type Socket } from "node:net"
/** Disposable TCP fault injection: withhold the advisory SQL packet, never fake a DB reply. */
export async function stalledProxy(url: string, needle: string) {
  const target = new URL(url)
  const upstreamHost = target.hostname
  const upstreamPort = Number(target.port || 5432)
  const stalled = Promise.withResolvers<void>()
  const sockets = new Set<Socket>()
  let connections = 0
  let injected = false
  let resume: () => void = () => undefined
  const server = createServer((client) => {
    connections++
    const upstream = connect({ host: upstreamHost, port: upstreamPort })
    sockets.add(client)
    sockets.add(upstream)
    let paused = false
    let buffer = Buffer.alloc(0)
    let startup = true
    client.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (paused) return
      while (buffer.length >= (startup ? 4 : 5)) {
        const size = startup ? buffer.readInt32BE(0) : buffer.readInt32BE(1) + 1
        if (buffer.length < size) return
        const packet = buffer.subarray(0, size)
        buffer = buffer.subarray(size)
        const initial = startup
        startup = false
        if (
          !injected &&
          (needle === "__startup__" ? initial : packet.includes(Buffer.from(needle)))
        ) {
          injected = true
          paused = true
          resume = () => {
            upstream.write(packet)
            upstream.write(buffer)
            buffer = Buffer.alloc(0)
            paused = false
          }
          stalled.resolve()
          return
        }
        upstream.write(packet)
      }
    })
    upstream.on("data", (chunk) => client.write(chunk))
    upstream.on("error", () => client.destroy())
    client.on("error", () => upstream.destroy())
    client.on("close", () => {
      sockets.delete(client)
      upstream.destroy()
    })
    upstream.on("close", () => {
      sockets.delete(upstream)
      client.destroy()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("proxy address missing")
  target.hostname = "127.0.0.1"
  target.port = String(address.port)
  return {
    url: target.toString(),
    stalled: stalled.promise,
    resume: () => resume(),
    connections: () => connections,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
