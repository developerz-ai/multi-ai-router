import { z } from "zod"
import { type AdminResult, invalid, ok } from "./result"

/**
 * The two things every admin route does before it calls a service, in one place
 * so a handler stays three lines and no route invents its own rejection wording.
 *
 * Both are Hono-free: they take a `Request` and an `unknown`, so the transport
 * layer is the only thing that knows about `Context`.
 */

/** A body that is not JSON is a validation failure, never a 500. */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

export function validate<T>(schema: z.ZodType<T>, input: unknown): AdminResult<T> {
  const parsed = schema.safeParse(input)
  return parsed.success ? ok(parsed.data) : invalid(describe(parsed.error))
}

/** Every id in the admin API is a database uuid; anything else cannot name a row. */
const identifier = z.uuid()

export function validateId(value: string | undefined): AdminResult<string> {
  const parsed = identifier.safeParse(value)
  return parsed.success ? ok(parsed.data) : invalid(`"${value ?? ""}" is not a valid id`)
}

/**
 * The first issue, named by its field. Enough for an operator to fix the
 * request, and deliberately not a dump of the whole schema — a validation error
 * that echoes the input back is how a credential ends up in a log line.
 */
function describe(error: z.ZodError): string {
  const issue = error.issues[0]
  if (issue === undefined) return "the request body is invalid"
  const field = issue.path.map(String).join(".")
  return field === "" ? issue.message : `${field}: ${issue.message}`
}
