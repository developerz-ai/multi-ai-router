import { InvalidRequestError, UnsupportedContentEncodingError } from "@multi-ai-router/core"
import type { ScanResult } from "./scanner"
import { MODEL_NAME_MAX_BYTES } from "./scanner"

/**
 * The refusals a request earns before it has named a model the router can route on.
 *
 * Each one is told apart by something already in hand — a header, a byte count, a flag the scanner
 * set while the body streamed past. Nothing here parses, decodes, or sniffs the body: a refusal
 * must cost less than the request it refuses, and decompressing a body to find out whether it was
 * compressed is the opposite of that.
 *
 * They used to share one sentence ("must name a model") under `translation_failed`, which told a
 * caller with an empty body to look for a missing field and an operator to look for a dialect
 * problem. One class per remedy instead.
 */

/** A header value is echoed into an error body; this bounds what a hostile one can put there. */
const MAX_ECHOED_ENCODING = 40

/**
 * The content coding the body arrived under, or null when it arrived as itself. `identity` is the
 * RFC 9110 spelling of "not encoded" and some clients send it explicitly.
 */
export function requestContentEncoding(headers: Pick<Headers, "get">): string | null {
  const raw = headers.get("content-encoding")
  if (raw === null) return null
  const codings = raw
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding.length > 0 && coding !== "identity")
  return codings.length === 0 ? null : codings.join(", ")
}

/**
 * Refuses an encoded body before a byte of it is read.
 *
 * The router does not decode request bodies: routing reads the model name out of the raw bytes, and
 * a same-dialect body goes upstream untouched. A compressed one therefore never named a model as
 * far as the scanner could see, and was answered "must name a model" — true of the bytes, useless
 * to the caller, whose body named one perfectly well.
 *
 * @throws UnsupportedContentEncodingError
 */
export function refuseEncodedBody(headers: Pick<Headers, "get">): void {
  const encoding = requestContentEncoding(headers)
  if (encoding === null) return
  throw new UnsupportedContentEncodingError(
    `Compressed request bodies are not supported (Content-Encoding: ${encoding.slice(0, MAX_ECHOED_ENCODING)}). ` +
      "Send the body uncompressed, without a Content-Encoding header",
  )
}

/** The body named a model, and it is too long to be one. */
export function modelTooLongError(): InvalidRequestError {
  return new InvalidRequestError(
    `The request body's model name is longer than ${MODEL_NAME_MAX_BYTES} bytes`,
  )
}

/**
 * The scanner found no top-level string `"model"`. An empty body is the one case worth its own
 * sentence, because it is the one the byte count alone identifies. Nonempty malformed JSON is
 * refused by grammar admission first; a valid object without a string model reaches this error.
 */
export function missingModelError(bodyBytes: number): InvalidRequestError {
  return new InvalidRequestError(
    bodyBytes === 0
      ? "The request body is empty: send a JSON object that names a model"
      : "The request body must name a model: a JSON object with a top-level string `model`",
  )
}

export function invalidRoutingBodyError(): InvalidRequestError {
  return new InvalidRequestError(
    "The request body must be one structurally complete JSON object with a unique top-level model",
  )
}

/** Field capture and complete grammar validation precede all model-dependent dispatch. */
export function admitRoutingModel(fields: ScanResult, bodyBytes: number): string {
  if (bodyBytes === 0) throw missingModelError(bodyBytes)
  if (fields.duplicateModel || fields.invalid) throw invalidRoutingBodyError()
  // Refuse rather than truncate: a shortened model would be a substituted model.
  if (fields.modelTooLong) throw modelTooLongError()
  if (fields.model === null) throw missingModelError(bodyBytes)
  return fields.model
}
