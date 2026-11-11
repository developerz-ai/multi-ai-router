/** A JSON object: not null, not an array. The one guard every module here reads a body with. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
