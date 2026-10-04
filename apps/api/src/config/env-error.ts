import type { z } from "zod"

/**
 * Boot configuration failure. Deliberately not a `RouterError` from
 * `@multi-ai-router/core`: those map to an HTTP status, and this one never
 * becomes a response — the process exits before the listener opens.
 */
export class EnvValidationError extends Error {
  readonly variables: readonly string[]

  constructor(message: string, variables: readonly string[]) {
    super(message)
    this.name = "EnvValidationError"
    this.variables = variables
  }
}

export function toEnvValidationError(error: z.ZodError): EnvValidationError {
  const variables: string[] = []
  const lines: string[] = []
  for (const issue of error.issues) {
    const name = issue.path.map(String).join(".") || "(environment)"
    if (!variables.includes(name)) variables.push(name)
    // Every raw value is a string, so the only `invalid_type` here is an absent variable.
    lines.push(`  ${name}: ${issue.code === "invalid_type" ? "is required" : issue.message}`)
  }
  const message = `Invalid environment configuration:\n${lines.join("\n")}`
  return new EnvValidationError(message, variables)
}
