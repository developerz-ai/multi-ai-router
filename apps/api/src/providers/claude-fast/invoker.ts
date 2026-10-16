import { releasingWith } from "../../services/dataplane/sdk-attempt-response"
import type { FetchLike } from "../../services/dataplane/types"
import type { SdkConcurrency } from "../claude-sdk/concurrency"
import { CLI_REFRESH_LEAD_MS } from "../claude-sdk/credential-freshness"
import type { SdkInvocation, SdkInvoker } from "../claude-sdk/invoke"
import type { FastCredential } from "./credential"
import { FAST_URL, fastHeaders } from "./profile"
import { reportFastQuota } from "./quota"
import { prepareFastRequest, readFastRequest } from "./request"
import { collectFastResponse, sanitizeFastError } from "./response"

export interface FastInvokerDeps {
  readonly concurrency: SdkConcurrency
  readonly sdk: SdkInvoker
  /** Must read under this Account's existing metadata-owner fence. */
  readonly credential: (accountId: string, configDir: string) => Promise<FastCredential | null>
  readonly resolveModel: (accountId: string, model: string) => string | null
  readonly errorMaxBytes: number
  readonly fetch?: FetchLike
  readonly now?: () => number
  readonly onFallback?: (reason: "credential" | "model" | "profile") => void
}

/** Warm requests perform HTTP only. SDK fallback owns every credential refresh. */
export function createFastInvoker(deps: FastInvokerDeps): SdkInvoker {
  const call = deps.fetch ?? ((request: Request) => fetch(request))
  const fallback = (input: SdkInvocation, reason: "credential" | "model" | "profile") => {
    deps.onFallback?.(reason)
    return deps.sdk({ ...input, session: { kind: "fresh", reason: "no-session" } })
  }
  return async (input) => {
    input.signal.throwIfAborted()
    const model = deps.resolveModel(input.accountId, input.model)
    if (!model) return fallback(input, "model")
    const credential = await deps.credential(input.accountId, input.configDir)
    if (!credential || credential.expiresAt <= (deps.now?.() ?? Date.now()) + CLI_REFRESH_LEAD_MS)
      return fallback(input, "credential")
    const body = readFastRequest(input.body)
    const contextTag = model.endsWith("[1m]")
    const prepared = prepareFastRequest({
      request: body,
      model: contextTag ? model.slice(0, -4) : model,
      identity: credential,
      accountId: input.accountId,
      apiKeyId: input.apiKeyId ?? "",
      sessionKey:
        input.sessionKey ?? input.clientHeaders?.get("x-claude-code-session-id") ?? input.configDir,
    })
    if (!prepared) return fallback(input, "profile")
    const slot = await deps.concurrency.acquire(input.accountId, input.signal)
    let released = false
    const release = () => {
      if (released) return
      released = true
      input.signal.removeEventListener("abort", release)
      slot.release()
    }
    input.signal.addEventListener("abort", release, { once: true })
    try {
      input.signal.throwIfAborted()
      const request = new Request(FAST_URL, {
        method: "POST",
        signal: input.signal,
        redirect: "manual",
        headers: fastHeaders({
          accessToken: credential.accessToken,
          sessionId: prepared.sessionId,
          ...(prepared.promptId ? { promptId: prepared.promptId } : {}),
          betas: input.clientHeaders?.get("anthropic-beta"),
          contextTag,
          requestClass: input.clientHeaders?.get("x-claude-code-request-class"),
          agentType: input.clientHeaders?.get("x-claude-code-agent-type"),
          subagent: prepared.subagent,
        }),
        body: prepared.text,
      })
      input.beforeUpstreamStart?.()
      input.onUpstreamStarted?.()
      const response = await call(request)
      reportFastQuota(response.headers, input.onRateLimit)
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        release()
        return Response.json(
          {
            type: "error",
            error: { type: "api_error", message: "Claude redirects are not permitted" },
          },
          { status: 502 },
        )
      }
      if (!response.ok) {
        try {
          return await sanitizeFastError(response, deps.errorMaxBytes)
        } finally {
          release()
        }
      }
      if (!prepared.streaming) {
        try {
          return await collectFastResponse(response, input.signal)
        } finally {
          release()
        }
      }
      return releasingWith(response, release)
    } catch (error) {
      release()
      if (input.signal.aborted) throw input.signal.reason
      // Admission refusal is meaningful to the shared planner; never wrap it as a provider error.
      if (error instanceof UpstreamAdmissionRefused) throw error
      throw new Error("Claude direct HTTP request failed")
    }
  }
}

import { UpstreamAdmissionRefused } from "../upstream-admission"
