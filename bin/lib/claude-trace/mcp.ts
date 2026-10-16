export {}

// Synthetic, side-effect-free MCP for wire tracing. No filesystem or shell tools.
let buffer = ""
const decoder = new TextDecoder()
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true })
  while (buffer.includes("\n")) {
    const newline = buffer.indexOf("\n")
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line.trim()) continue
    const message: {
      id?: string | number
      method: string
      params?: {
        protocolVersion?: string
        name?: string
        arguments?: { marker?: string }
      }
    } = JSON.parse(line)
    if (message.id === undefined) continue
    let result: unknown
    switch (message.method) {
      case "initialize":
        result = {
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "synthetic-trace", version: "1.0.0" },
        }
        break
      case "tools/list":
        result = {
          tools: [
            {
              name: "echo_marker",
              description: "Echo a synthetic test marker.",
              inputSchema: {
                type: "object",
                properties: { marker: { type: "string" } },
                required: ["marker"],
                additionalProperties: false,
              },
            },
          ],
        }
        break
      case "tools/call":
        result =
          message.params?.name === "echo_marker"
            ? {
                content: [
                  {
                    type: "text",
                    text: `Echoed synthetic marker: ${message.params.arguments?.marker ?? ""}`,
                  },
                ],
                isError: false,
              }
            : { content: [{ type: "text", text: "Unknown synthetic tool" }], isError: true }
        break
      case "ping":
        result = {}
        break
      default:
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not found" },
          })}\n`,
        )
        continue
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`)
  }
}
