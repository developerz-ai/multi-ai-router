import { z } from "zod"

/**
 * The one accepted shape for an instant that arrives in a URL or query string — the usage read's
 * custom `from`/`to`, for example. The API's window schema and the console's URL parser both gate
 * on this same schema: a range the page accepts never reaches the API as a `400`, and a range the
 * API would refuse falls back in the page instead. One definition, two gatekeepers — a hand-edited
 * link like `?from=2026/10/01` parses fine under `Date.parse` but is not this shape.
 */
export const isoDatetimeSchema = z.iso.datetime()

export function isIsoDateTime(value: string): boolean {
  return isoDatetimeSchema.safeParse(value).success
}
