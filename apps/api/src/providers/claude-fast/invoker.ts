import type { Logger } from "../../logging/logger"
import { releasingWith } from "../../services/dataplane/sdk-attempt-response"
import {
  createTranslationDropLog,
  dropReporter,
} from "../../services/dataplane/translation-drop-log"
import type { FetchLike } from "../../services/dataplane/types"
import type { TranslationDrop } from "../../services/translate/shared/drops"
import type { SdkConcurrency } from "../claude-sdk/concurrency"
import { CLI_REFRESH_LEAD_MS } from "../claude-sdk/credential-freshness"
import type { SdkInvocation, SdkInvoker } from "../claude-sdk/invoke"
import { UpstreamAdmissionRefused } from "../upstream-admission"
import type { FastCredential } from "./credential"
import { FastTransportError, failureReason } from "./failure"
import { createNativeSchemaMemo } from "./native-schema-memo"
import { FAST_URL, fastHeaders } from "./profile"
import { reportFastQuota } from "./quota"
import { prepareFastRequest, readFastRequest } from "./request"
import {
  collectFastResponse,
  FastForcedToolUnmet,
  fastErrorResponse,
  isNativeSchemaRejection,
  readFastErrorText,
  validateFastResponse,
} from "./response"

export type FastFallbackReason = "credential" | "model" | "profile"

export interface FastInvokerDeps {
  readonly concurrency: SdkConcurrency
  readonly sdk: SdkInvoker
  /** Must read under this Account's existing metadata-owner fence (or its stat-keyed cache). */
  readonly credential: (accountId: string, configDir: string) => Promise<FastCredential | null>
  /** Drops a cached credential after Anthropic answered `401`/`403` (`credential-cache.ts`). */
  readonly forgetCredential?: (accountId: string) => void
  readonly resolveModel: (accountId: string, model: string) => string | null
  readonly errorMaxBytes: number
  /**
   * How long a native structured-output request may wait for Anthropic's response headers
   * (`CLAUDE_FAST_NATIVE_SCHEMA_TIMEOUT_SECONDS`). Anthropic compiles the schema before it answers
   * and held prod clients ~180 s for a `Schema is too complex.` 400 (101 finding 10.4); past this
   * bound the attempt is abandoned and re-sent on the adapted tool, which needs no compile.
   */
  readonly nativeSchemaTimeoutMs?: number
  /** Schemas remembered as refused natively, so a repeat skips the wait (bounded, oldest out). */
  readonly nativeSchemaMemoSize?: number
  readonly fetch?: FetchLike
  readonly now?: () => number
  /**
   * The `translation dropped fields` warn window (`TRANSLATION_DROP_LOG_WINDOW_SECONDS`), shared
   * with the translator's own line: one warn per key and drop signature per window, then `debug`.
   */
  readonly dropLogWindowMs?: number
  /** Every fallback, for the `claude_fast_fallback_total{reason}` counter. */
  readonly onFallback?: (reason: FastFallbackReason, accountId: string) => void
  /** Warn-once per Account and reason for fallbacks; the transport and native-schema reasons. */
  readonly logger?: Logger
}

const DEFAULT_NATIVE_SCHEMA_TIMEOUT_MS = 20_000
/** The drop line's dialect pair: the Anthropic body, reduced to the native schema subset. */
const NATIVE_SCHEMA_PAIR = { ingress: "anthropic", egress: "claude-native-schema" } as const
const DEFAULT_NATIVE_SCHEMA_MEMO_SIZE = 512

/** Warm requests perform HTTP only. SDK fallback owns every credential refresh. */
export function createFastInvoker(deps: FastInvokerDeps): SdkInvoker {
  const call = deps.fetch ?? ((request: Request) => fetch(request))
  const nativeTimeoutMs = deps.nativeSchemaTimeoutMs ?? DEFAULT_NATIVE_SCHEMA_TIMEOUT_MS
  const refusedSchemas = createNativeSchemaMemo(
    deps.nativeSchemaMemoSize ?? DEFAULT_NATIVE_SCHEMA_MEMO_SIZE,
  )
  const warned = new Set<string>()
  const dropLog = createTranslationDropLog({
    windowMs: deps.dropLogWindowMs,
    now: deps.now ?? Date.now,
  })
  const reportDrops = (keyId: string) => dropReporter(dropLog, deps.logger, keyId)
  const fallback = (input: SdkInvocation, reason: FastFallbackReason) => {
    deps.onFallback?.(reason, input.accountId)
    // A permanent fallback (an identity-less `.claude.json`, an unresolved alias) is otherwise
    // invisible: say so once per Account and reason, never per request.
    const key = `${input.accountId}\0${reason}`
    if (!warned.has(key)) {
      warned.add(key)
      deps.logger?.warn("Claude fast mode falls back to the SDK for this account", {
        component: "claude-fast",
        accountId: input.accountId,
        reason,
      })
    }
    return deps.sdk({ ...input, session: { kind: "fresh", reason: "no-session" } })
  }
  return async (input) => {
    input.signal.throwIfAborted()
    const model = deps.resolveModel(input.accountId, input.model)
    if (!model) return fallback(input, "model")
    const body = readFastRequest(input.body)
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
      const credential = await deps.credential(input.accountId, input.configDir)
      if (
        !credential ||
        credential.expiresAt <= (deps.now?.() ?? Date.now()) + CLI_REFRESH_LEAD_MS
      ) {
        release()
        return fallback(input, "credential")
      }
      const contextTag = model.endsWith("[1m]")
      const drops: TranslationDrop[] = []
      const prepare = (native: boolean) => {
        drops.length = 0
        try {
          return prepareFastRequest({
            request: body,
            model: contextTag ? model.slice(0, -4) : model,
            identity: credential,
            accountId: input.accountId,
            apiKeyId: input.apiKeyId ?? "",
            sessionKey:
              input.sessionKey ??
              input.clientHeaders?.get("x-claude-code-session-id") ??
              input.configDir,
            nativeStructuredOutput: native,
            onDrop: (drop) => drops.push(drop),
          })
        } catch (error) {
          // A calibration bug ("uncalibrated Claude request profile", a missing checksum) is the
          // documented pre-inference fallback, not a transport failure — and it is logged.
          deps.logger?.warn("Claude fast mode request preparation failed", {
            component: "claude-fast",
            accountId: input.accountId,
            reason: failureReason(error),
          })
          return null
        }
      }
      let prepared = prepare(true)
      if (prepared?.nativeSchema !== undefined && refusedSchemas.has(prepared.nativeSchema))
        prepared = prepare(false)
      // Constraints the native schema reduction restated as text: the client's request went out
      // without them as keywords. Reported only when the reduced schema is what is sent.
      if (prepared?.nativeSchema !== undefined && drops.length > 0)
        reportDrops(input.apiKeyId ?? "")(NATIVE_SCHEMA_PAIR, drops)
      if (!prepared) {
        release()
        return fallback(input, "profile")
      }
      const send = async (
        meta: NonNullable<typeof prepared>,
        headerTimeoutMs?: number,
      ): Promise<Response | "stalled"> => {
        const stall = new AbortController()
        const timer =
          headerTimeoutMs === undefined
            ? undefined
            : setTimeout(() => stall.abort(new Error("native schema stalled")), headerTimeoutMs)
        try {
          const response = await call(
            new Request(FAST_URL, {
              method: "POST",
              signal: AbortSignal.any([input.signal, stall.signal]),
              redirect: "manual",
              headers: fastHeaders({
                accessToken: credential.accessToken,
                sessionId: meta.sessionId,
                ...(meta.promptId ? { promptId: meta.promptId } : {}),
                betas: input.clientHeaders?.get("anthropic-beta"),
                contextTag,
                requestClass: input.clientHeaders?.get("x-claude-code-request-class"),
                agentType: input.clientHeaders?.get("x-claude-code-agent-type"),
                subagent: meta.subagent,
                toolNames: meta.toolNames,
              }),
              body: meta.text,
            }),
          )
          reportFastQuota(response.headers, input.onRateLimit)
          return response
        } catch (error) {
          if (stall.signal.aborted && !input.signal.aborted) return "stalled"
          throw error
        } finally {
          clearTimeout(timer)
        }
      }
      input.beforeUpstreamStart?.()
      input.onUpstreamStarted?.()
      const native = prepared.nativeSchema
      let outcome = await send(prepared, native === undefined ? undefined : nativeTimeoutMs)
      let errorText: string | null = null
      if (native !== undefined) {
        if (outcome !== "stalled" && outcome.status === 400) {
          errorText = await readFastErrorText(outcome, deps.errorMaxBytes, [credential.accessToken])
        }
        const refused =
          outcome === "stalled" || (errorText !== null && isNativeSchemaRejection(400, errorText))
        if (refused) {
          // Still before a byte reached the client, on the same Account and slot: the one re-send
          // the "never retry after bytes are on the wire" rule allows, on the pre-2.55 adaptation.
          refusedSchemas.add(native)
          deps.logger?.warn("Claude refused the native structured-output schema; using the tool", {
            component: "claude-fast",
            accountId: input.accountId,
            reason: outcome === "stalled" ? "header-timeout" : "schema-rejected",
          })
          const viaTool = prepare(false)
          if (!viaTool) {
            release()
            return fallback(input, "profile")
          }
          prepared = viaTool
          errorText = null
          outcome = await send(viaTool)
        }
      }
      if (outcome === "stalled") throw new FastTransportError(new Error("stalled"))
      let response = outcome
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
          if (response.status === 401 || response.status === 403)
            deps.forgetCredential?.(input.accountId)
          const text =
            errorText ??
            (await readFastErrorText(response, deps.errorMaxBytes, [credential.accessToken]))
          return fastErrorResponse(response, text)
        } finally {
          release()
        }
      }
      response = await validateFastResponse(response)
      if (!response.ok) {
        release()
        return response
      }
      if (!prepared.streaming) {
        try {
          // A relaxed force (`tool-choice.ts`) is checked on a non-streaming turn only, as on the
          // Agent-SDK transport: a streaming answer is already the client's as it arrives.
          return await collectFastResponse(
            response,
            input.signal,
            prepared.forcedTool === "forced-tool",
          )
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
      // A classified refusal, not a transport failure: its sentence is what fails it over.
      if (error instanceof FastForcedToolUnmet) throw error
      const failure = error instanceof FastTransportError ? error : new FastTransportError(error)
      deps.logger?.warn("Claude direct HTTP request failed", {
        component: "claude-fast",
        accountId: input.accountId,
        reason: failure.reason,
      })
      throw failure
    }
  }
}
