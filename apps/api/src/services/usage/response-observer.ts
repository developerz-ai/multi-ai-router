import { createResponseFraming } from "./response-framing"
import type {
  ResponseObservationFacts,
  ResponseObservationSpec,
  ResponseObserver,
} from "./response-observer-types"
import { protocolFailure, readResponseTerminal } from "./response-terminal"
import { readResponseUsage } from "./response-usage"
import { ZERO_TOKENS } from "./tokens"

export function createResponseObserver(spec: ResponseObservationSpec): ResponseObserver {
  if (!Number.isSafeInteger(spec.maximumObservationBytes) || spec.maximumObservationBytes <= 0)
    throw new Error("response observation byte bound must be a positive integer")
  let counts = ZERO_TOKENS
  let usageInvalid = false
  let evidenceUnavailable = false
  let terminal: ResponseObservationFacts["terminal"] = "none"
  let failure: ResponseObservationFacts["failure"] = null
  let incompleteReason: ResponseObservationFacts["incompleteReason"] = null
  /** The first driver-supplied classification, kept separately so `relay-terminal` can read its signal. */
  let provider: ResponseObservationFacts["provider"] = null
  let finished = false
  const snapshot = (): ResponseObservationFacts =>
    Object.freeze({
      counts: Object.freeze({ ...counts }),
      usageInvalid,
      evidenceUnavailable,
      terminal,
      failure: failure === null ? null : Object.freeze({ ...failure }),
      incompleteReason,
      provider: provider === null ? null : Object.freeze({ ...provider }),
    })
  const framing = createResponseFraming({
    contentType: spec.contentType,
    maximumBytes: spec.maximumObservationBytes,
    unavailable: () => {
      evidenceUnavailable = true
    },
    done: () => {
      if (spec.dialect === "openai-chat" && terminal === "none") terminal = "completed"
    },
    payload(body, event) {
      if (spec.operation !== "count-tokens") {
        const reading = readResponseUsage(spec.dialect, body, event, counts)
        counts = reading.counts
        usageInvalid ||= reading.invalid
      }
      const observed = readResponseTerminal(spec.dialect, body, event)
      const providerClassification = spec.descriptor?.inspectPayload?.(body, event) ?? null
      if (terminal === "explicit_error") return
      if (providerClassification !== null || observed.failure !== null) {
        const detected = providerClassification ?? observed.failure
        terminal = "explicit_error"
        // Persist only fixed bounded classification vocabulary, never provider messages.
        failure =
          detected === null
            ? null
            : {
                kind: detected.kind,
                status: detected.status,
                retryable: detected.retryable,
                signal: detected.signal,
                rateLimit: null,
              }
        // Retain the hook's verdict separately so `relay-terminal` can carry the bounded
        // `codex:stream-error:<code>` signal into the usage row's `errorClass`. Without this,
        // an in-stream Codex refusal would land on the protocol-default `upstream_protocol_error`
        // and a `codex:stream-error:invalid_prompt` would be lost.
        if (providerClassification !== null) {
          provider = { ...providerClassification }
        }
        incompleteReason = null
      } else if (observed.terminal === "explicit_incomplete") {
        terminal = "explicit_incomplete"
        incompleteReason = observed.incompleteReason
      } else if (observed.terminal === "completed" && terminal === "none") terminal = "completed"
    },
  })
  return {
    observe(chunk) {
      if (!finished) framing.observe(chunk)
    },
    snapshot,
    finish() {
      if (!finished) {
        framing.finish()
        finished = true
        const sse = spec.contentType?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream"
        if (
          spec.operation === "messages" &&
          sse &&
          spec.descriptor?.terminalPolicy === "require-completion" &&
          terminal === "none" &&
          !evidenceUnavailable
        ) {
          terminal = "explicit_incomplete"
          failure = protocolFailure("protocol:missing-completion")
          incompleteReason = "unknown"
        }
      }
      return snapshot()
    },
    get retainedBytes() {
      return framing.retainedBytes
    },
  }
}
