/** The root of the router's error hierarchy — see `errors.ts`. */

import type { RouterErrorDetail, RouterErrorInit } from "./wall"

export const ROUTER_ERROR_CODES = [
  "no_healthy_account",
  "quota_exhausted",
  "credits_exhausted",
  "scope_violation",
  "key_revoked",
  "key_rate_limited",
  "key_verification_unavailable",
  "admin_auth_failed",
  "csrf_token_invalid",
  "upstream_auth_failed",
  "upstream_timeout",
  "upstream_overloaded",
  "credential_decrypt_failed",
  "translation_failed",
  "model_not_found",
  "request_too_large",
  "invalid_request",
  "unsupported_content_encoding",
] as const

export type RouterErrorCode = (typeof ROUTER_ERROR_CODES)[number]

/**
 * Base of the hierarchy. `code` is the machine-readable identifier clients and metrics key on;
 * `status` is the HTTP status the transport layer renders. Both are fixed per subclass — a
 * subclass never negotiates its status at construction time.
 */
export abstract class RouterError extends Error {
  abstract readonly code: RouterErrorCode
  abstract readonly status: number
  /** What the throw site knew beyond the class; rendered as `error.router` (`wall.ts`). */
  readonly detail: RouterErrorDetail

  constructor(message: string, options?: RouterErrorInit) {
    super(message, options)
    // The subclass name is what `UsageRecord.errorClass` and the logs record.
    this.name = new.target.name
    this.detail = options?.detail ?? {}
  }
}

/** Narrows an unknown thrown value to a {@link RouterError}. */
export function isRouterError(value: unknown): value is RouterError {
  return value instanceof RouterError
}
