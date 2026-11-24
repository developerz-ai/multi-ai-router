import { readFileSync } from "node:fs"
import { z } from "zod"
import { EnvValidationError } from "./env-error"

const label = z.string().refine((value) => value.trim().length > 0, "must be nonblank")

const poolSchema = z
  .strictObject({
    name: label,
    members: z.array(label).min(1),
    overflow: label,
    quotaSoftLimit: z.number().min(0).max(1).default(0.8),
  })
  .superRefine((pool, ctx) => {
    if (new Set(pool.members).size !== pool.members.length) {
      ctx.addIssue({ code: "custom", path: ["members"], message: "duplicate members" })
    }
    if (!pool.members.includes(pool.overflow)) {
      ctx.addIssue({ code: "custom", path: ["overflow"], message: "overflow must be a member" })
    } else if (pool.members.length === 1) {
      ctx.addIssue({
        code: "custom",
        path: ["overflow"],
        message: "overflow must not be sole member",
      })
    }
  })

export const poolRosterSchema = z
  .strictObject({ version: z.literal(1), pools: z.array(poolSchema) })
  .superRefine((roster, ctx) => {
    const names = new Set<string>()
    for (const [index, pool] of roster.pools.entries()) {
      if (names.has(pool.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["pools", index, "name"],
          message: "duplicate pool name",
        })
      }
      names.add(pool.name)
    }
  })

export type PoolRoster = z.output<typeof poolRosterSchema>

// Never render Zod's default messages: unknown keys and literal/type errors can quote input.
function firstIssue(issue: z.core.$ZodIssue | undefined): string {
  if (!issue) return "roster: invalid schema"
  const path = issue.path.filter(
    (part) =>
      typeof part === "number" ||
      ["version", "pools", "name", "members", "overflow"].includes(String(part)),
  )
  const location = path.join(".") || "roster"
  const messages: Record<string, string> = {
    invalid_type: "invalid type or missing field",
    invalid_value: "version must be 1",
    unrecognized_keys: "unknown fields are not allowed",
    too_small: "members must not be empty",
  }
  const fallback = messages[issue.code] ?? "invalid schema"
  const message = issue.code === "custom" ? issue.message : fallback
  return `${location}: ${message}`
}

/** Boot-only I/O. A disabled roster does not touch the filesystem. */
export function loadPoolRoster(path: string | null): PoolRoster | null {
  if (path === null) return null
  const refusal = (issue: string) =>
    new EnvValidationError(
      `Invalid environment configuration:\n  POOL_ROSTER_PATH (${path}): ${issue}`,
      ["POOL_ROSTER_PATH"],
    )
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    throw refusal("cannot read roster file")
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw refusal("invalid JSON")
  }
  const result = poolRosterSchema.safeParse(value)
  if (!result.success) throw refusal(firstIssue(result.error.issues[0]))
  return result.data
}
