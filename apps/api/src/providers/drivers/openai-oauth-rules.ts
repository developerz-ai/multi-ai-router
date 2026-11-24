import {
  type ClassificationRule,
  codeRule,
  messageRule,
  onStatus,
  typeRule,
} from "../failure/classify"
import {
  CODEX_DEACTIVATED_CODES,
  CODEX_LIMIT_CODES,
  CODEX_OVERLOAD_CODES,
  CODEX_OVERLOADED_WORDING,
  CODEX_QUOTA_CODES,
} from "./openai-oauth-stream-errors"

/**
 * The Codex driver's HTTP classification rules, evaluated in order. The code lists are shared with
 * the in-stream hook (`openai-oauth-stream-errors.ts`), which carries their provenance.
 */

const CODEX_MODEL_REFUSED = /model is not supported when using codex/i

/** The two account-level types the CLI reads off a `429` (`codex-api/src/api_bridge.rs`). */
const QUOTA_TYPES: readonly string[] = ["insufficient_quota", "usage_not_included"]

export const CODEX_HTTP_RULES: readonly ClassificationRule[] = [
  typeRule("rate-limited", "openai-oauth:usage_limit_reached", CODEX_LIMIT_CODES),
  codeRule("rate-limited", "openai-oauth:usage_limit_reached", CODEX_LIMIT_CODES),
  typeRule("credits-exhausted", "openai-oauth:account_deactivated", CODEX_DEACTIVATED_CODES),
  codeRule("credits-exhausted", "openai-oauth:account_deactivated", CODEX_DEACTIVATED_CODES),
  // A spent balance on a 429; scope and the differences from the Codex CLI: CODEX_QUOTA_CODES.
  onStatus([429], typeRule("credits-exhausted", "openai-oauth:insufficient_quota", QUOTA_TYPES)),
  onStatus(
    [429],
    codeRule("credits-exhausted", "openai-oauth:insufficient_quota", CODEX_QUOTA_CODES),
  ),
  onStatus([503], codeRule("overloaded", "openai-oauth:overloaded", CODEX_OVERLOAD_CODES)),
  messageRule("overloaded", "openai-oauth:overloaded", CODEX_OVERLOADED_WORDING, {
    statuses: [503],
  }),
  // "The '<model>' model is not supported when using Codex with a ChatGPT account." (prod
  // 2026-10-04): the model is wrong, not the request, so fail over instead of `invalid-request`.
  messageRule("model-unsupported", "openai-oauth:model-unsupported", CODEX_MODEL_REFUSED, {
    statuses: [400, 404],
  }),
]
