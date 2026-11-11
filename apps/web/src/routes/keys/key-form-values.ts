import type {
  CreateKeyInput,
  KeyScopeInput,
  RateLimitInput,
  UpdateKeyInput,
} from "../../lib/api/router-keys"
import type { ApiKeyView, KeyOwnerKind } from "../../lib/api/types"
import { fromDateTimeInput, toDateTimeInput } from "../../lib/datetime-input"
import { readNumberInput } from "../../lib/number-input"

// The mint/edit form's answer, and its mapping onto the mint body — split out
// of `KeyFormDialog` so the dialog is fields and this is the contract.

/**
 * The form's whole answer, with every optional field **stated** rather than
 * omitted.
 *
 * On a mint an absent ceiling and an absent expiry are the same thing as `null`,
 * so the route drops them. On an edit they are not: `null` is what *clears* a
 * ceiling or makes a key non-expiring, and a form that omitted them could only
 * ever add one. Saying both explicitly here is what makes the edit path able to
 * express a removal at all. The same rule carries to the attribution labels.
 */
export interface KeyFormValues {
  readonly name: string
  /** Attribution as the form states it: trimmed, `null` for absent. See `KeyAttributionFields`. */
  readonly owner: string | null
  readonly ownerKind: KeyOwnerKind | null
  readonly tool: string | null
  readonly purpose: string | null
  readonly scope: KeyScopeInput
  readonly rateLimit: RateLimitInput | null
  readonly expiresAt: string | null
}

/**
 * The mint's body: the same values with the `null`s dropped.
 *
 * `createKeyBody` is `.strict()` and its optional fields are not nullable, so an
 * explicit `rateLimit: null` is a `400` rather than "no ceiling". On the mint,
 * absent *is* the way to say it — the removal spelling only exists on `PATCH`.
 */
export function toCreateKeyInput(values: KeyFormValues): CreateKeyInput {
  return {
    name: values.name,
    scope: values.scope,
    ...(values.rateLimit === null ? {} : { rateLimit: values.rateLimit }),
    ...(values.expiresAt === null ? {} : { expiresAt: values.expiresAt }),
    ...(values.owner === null ? {} : { owner: values.owner }),
    ...(values.ownerKind === null ? {} : { ownerKind: values.ownerKind }),
    ...(values.tool === null ? {} : { tool: values.tool }),
    ...(values.purpose === null ? {} : { purpose: values.purpose }),
  }
}

/**
 * The edit's body: every field stated, except an expiry the operator did not touch.
 *
 * The API refuses an `expiresAt` in the past, so re-sending an already-expired key's own expiry
 * made the key impossible to rename or re-scope. An untouched box is the stored instant read back
 * through the same minute-precision control, so that is what "untouched" is compared against.
 */
export function toUpdateKeyInput(values: KeyFormValues, stored: ApiKeyView): UpdateKeyInput {
  const untouched = values.expiresAt === fromDateTimeInput(toDateTimeInput(stored.expiresAt))
  if (!untouched) return values
  const { expiresAt: _unchanged, ...rest } = values
  return rest
}

/**
 * Both halves or neither: a count with no window is not a rate limit, and the API refuses one. An
 * empty pair is `null` — no ceiling — which on an edit is how an existing one is removed. One half
 * alone is `undefined`: the form blocks the submit and says why, rather than reading it as "no
 * ceiling" and minting an unlimited key (or, on an edit, removing the one it had).
 */
export function parseRateLimit(
  requests: string,
  windowSeconds: string,
): RateLimitInput | null | undefined {
  const count = readNumberInput(requests)
  const seconds = readNumberInput(windowSeconds)
  if (count === null && seconds === null) return null
  if (count === null || seconds === null) return undefined
  return { requests: count, windowSeconds: seconds }
}

/**
 * An absent label is `null`, never a blank string: the API stores null, and on a
 * PATCH an empty trim is the one spelling that *clears* the label.
 */
export function labelOrNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}
