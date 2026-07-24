import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { AdminAuthEnv } from "../../middleware/adminAuth"
import { type AdminResult, failureBody } from "../../services/admin"

/**
 * The one place an admin service outcome becomes a response.
 *
 * Every route group in this directory renders the same way — the success value
 * as JSON, a failure through `failureBody`, which puts the status on the wire
 * that the service chose. Four copies of this function is four chances for one
 * of them to answer 200 with an error body.
 */
export function render(
  c: Context<AdminAuthEnv>,
  result: AdminResult<unknown>,
  status: ContentfulStatusCode = 200,
): Response {
  if (!result.ok) return c.json(failureBody(result.failure), result.failure.status)
  return c.json(result.value, status)
}
