/**
 * Join class names, dropping anything falsy.
 *
 * CSS-module lookups are `string | undefined` under `noUncheckedIndexedAccess`,
 * so template-literal concatenation would happily emit the literal string
 * `"undefined"` into a `class` attribute. This is the one place that is
 * handled.
 */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(" ")
}
