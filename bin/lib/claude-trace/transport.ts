import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { localOrigin, replayHeaders } from "./local-origin"
import { traceEnv } from "./options"

/** Compare real CLI and Bun TLS/header serialization against a local stub, with fake credentials. */
export async function transportTrace(
  model: string,
  cli: string,
  privateWire: boolean,
): Promise<void> {
  if (!Bun.which(cli) || !Bun.which("openssl"))
    throw new Error("transport requires claude and openssl")
  const root = resolve(
    "tmp/claude-http/runs",
    `${new Date().toISOString().replaceAll(":", "-")}-transport`,
  )
  await mkdir(resolve(root, "account"), { recursive: true, mode: 0o700 })
  const certificate = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      resolve(root, "key.pem"),
      "-out",
      resolve(root, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdout: "ignore", stderr: "ignore" },
  )
  if ((await certificate.exited) !== 0)
    throw new Error("cannot generate temporary local certificate")
  const cert = await readFile(resolve(root, "cert.pem"))
  const key = await readFile(resolve(root, "key.pem"))
  const origin = await localOrigin(key, cert, model)
  const env = traceEnv(resolve(root, "account"), "http://127.0.0.1:9", root)
  env.NODE_EXTRA_CA_CERTS = resolve(root, "cert.pem")
  env.ANTHROPIC_BASE_URL = origin.url
  env.ANTHROPIC_API_KEY = "sk-ant-api03-synthetic-trace-stub"
  const child = Bun.spawn(
    [
      cli,
      "-p",
      "Reply LOCAL_OK.",
      "--model",
      model,
      "--tools",
      "",
      "--setting-sources",
      "",
      "--settings",
      '{"disableAllHooks":true}',
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--permission-mode",
      "dontAsk",
      "--max-turns",
      "1",
      "--no-session-persistence",
      "--output-format",
      "json",
      "--system-prompt",
      "You are a synthetic trace assistant.",
    ],
    { env, cwd: root, stdout: "pipe", stderr: "pipe" },
  )
  const timer = setTimeout(() => child.kill(), 30_000)
  try {
    // Drain both pipes so a future CLI's diagnostics cannot fill one and wedge the probe.
    const [exitCode] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    const original = origin.requests[0]
    if (exitCode !== 0 || !original)
      throw new Error("local CLI probe failed; no provider was contacted")
    const response = await fetch(`${origin.url}/v1/messages?beta=true`, {
      method: "POST",
      headers: replayHeaders(original.rawHeaders),
      body: original.body,
      tls: { ca: cert.toString("utf8") },
      keepalive: true,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    })
    await response.text()
    const headerNames = origin.requests.map((request) =>
      request.rawHeaders.filter((_, i) => i % 2 === 0),
    )
    const sameJa3 =
      origin.captures.length === 2 && origin.captures[0]?.ja3 === origin.captures[1]?.ja3
    const sameHeaderOrder =
      headerNames.length === 2 && JSON.stringify(headerNames[0]) === JSON.stringify(headerNames[1])
    const report = {
      bun: Bun.version,
      cli,
      model,
      mode: "local-stub-key",
      captures: origin.captures,
      requests: origin.requests.map((request, i) => ({
        headers: headerNames[i],
        bodyBytes: Buffer.byteLength(request.body),
      })),
      sameJa3,
      sameHeaderOrder,
    }
    await writeFile(resolve(root, "transport.json"), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    })
    if (privateWire)
      await writeFile(
        resolve(root, "private-bodies.jsonl"),
        `${origin.requests
          .map((request) =>
            JSON.stringify({
              body_base64: Buffer.from(request.body).toString("base64"),
            }),
          )
          .join("\n")}\n`,
        { mode: 0o600 },
      )
    process.stdout.write(`${JSON.stringify({ root, sameJa3, sameHeaderOrder })}\n`)
    if (!sameJa3 || !sameHeaderOrder)
      throw new Error("local transport parity differs; inspect transport.json")
  } finally {
    clearTimeout(timer)
    child.kill()
    origin.close()
  }
}
