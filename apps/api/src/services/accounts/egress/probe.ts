import { connect as connectTcp, isIP, type Socket } from "node:net"
import { connect as connectTls } from "node:tls"
import type { EgressProxyOutcome } from "@multi-ai-router/db"

export interface ProbeResult {
  readonly outcome: Extract<
    EgressProxyOutcome,
    "ok" | "auth" | "unreachable" | "timeout" | "refused"
  >
  /** The proxy's answer to CONNECT, when it gave one. */
  readonly status: number | null
  readonly latencyMs: number
}

/** `host:port` a proxy is asked to open a tunnel to. */
export type ProbeTarget = string

export type ProxyProbe = (
  proxyUrl: string,
  target: ProbeTarget,
  signal?: AbortSignal,
) => Promise<ProbeResult>

/**
 * A host that is nobody's AI provider (IANA's, for documentation). Where a proxy not yet given to an
 * account is asked to connect, and the second question before one is called dead.
 */
export const NEUTRAL_TARGET: ProbeTarget = "example.com:443"

/** A status line is short; anything longer is not a proxy talking to us. */
const MAX_HEAD_BYTES = 4_096

/**
 * Asks the proxy to open a tunnel and reads its answer, and nothing more. No TLS to the upstream, no
 * HTTP request and no credential of the account's, so the AI provider sees a connection open and
 * close. The result is therefore about the proxy alone: any answer but `407` means it is alive.
 */
export function createProxyProbe(timeoutMs: number): ProxyProbe {
  return async (proxyUrl, target, signal) => {
    const started = performance.now()
    const result = (
      outcome: ProbeResult["outcome"],
      status: number | null = null,
    ): ProbeResult => ({ outcome, status, latencyMs: Math.round(performance.now() - started) })
    const url = new URL(proxyUrl)
    const deadline = AbortSignal.timeout(timeoutMs)
    const stop = signal === undefined ? deadline : AbortSignal.any([deadline, signal])

    return await new Promise<ProbeResult>((resolve) => {
      let settled = false
      let head = ""
      const finish = (value: ProbeResult): void => {
        if (settled) return
        settled = true
        stop.removeEventListener("abort", onAbort)
        socket.destroy()
        resolve(value)
      }
      const onAbort = (): void => finish(result("timeout"))
      const socket = open(url, () => socket.write(connectRequest(url, target)))
      socket.on("error", () => finish(result("unreachable")))
      socket.on("close", () => finish(result("unreachable")))
      socket.on("data", (chunk: Buffer) => {
        head += chunk.toString("latin1")
        const status = /^HTTP\/1\.[01] (\d{3})(?=[ \r\n])/.exec(head)?.[1]
        if (status !== undefined) return finish(verdict(Number(status), result))
        if (head.includes("\n") || head.length > MAX_HEAD_BYTES) finish(result("unreachable"))
      })
      if (stop.aborted) onAbort()
      else stop.addEventListener("abort", onAbort, { once: true })
    })
  }
}

/**
 * The same question, with the upstream's answer taken out of it. An upstream that drops or blackholes
 * this address looks exactly like a dead proxy from here, and moving the account for it would be
 * rotating around a provider's block. So no silence counts until the proxy is silent to a neutral
 * host too; one that answers for that host is alive, and the upstream declined it: `refused`.
 */
export function withNeutralControl(probe: ProxyProbe): ProxyProbe {
  return async (proxyUrl, target, signal) => {
    const first = await probe(proxyUrl, target, signal)
    const silent = first.outcome === "unreachable" || first.outcome === "timeout"
    if (!silent || target === NEUTRAL_TARGET || signal?.aborted === true) return first
    const control = await probe(proxyUrl, NEUTRAL_TARGET, signal)
    if (control.outcome === "unreachable" || control.outcome === "timeout") return first
    if (control.outcome === "auth") return control
    return { outcome: "refused", status: null, latencyMs: first.latencyMs }
  }
}

function verdict(
  status: number,
  result: (outcome: ProbeResult["outcome"], status: number) => ProbeResult,
): ProbeResult {
  if (status >= 200 && status < 300) return result("ok", status)
  return result(status === 407 ? "auth" : "refused", status)
}

function open(url: URL, ready: () => void): Socket {
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (url.protocol !== "https:") return connectTcp({ host, port: Number(url.port || 80) }, ready)
  return connectTls(
    { host, port: Number(url.port || 443), ...(isIP(host) === 0 ? { servername: host } : {}) },
    ready,
  )
}

function connectRequest(url: URL, target: ProbeTarget): string {
  const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`]
  if (url.username !== "" || url.password !== "") {
    const userinfo = `${decoded(url.username)}:${decoded(url.password)}`
    lines.push(`Proxy-Authorization: Basic ${Buffer.from(userinfo, "utf8").toString("base64")}`)
  }
  return `${lines.join("\r\n")}\r\n\r\n`
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
