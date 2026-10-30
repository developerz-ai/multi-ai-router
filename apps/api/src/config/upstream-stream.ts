import type { z } from "zod"
import { atLeastOne } from "./fields"

/**
 * A streamed HTTP attempt's three clocks (`services/dataplane/upstream-deadline.ts`). Why each
 * default is what it is: docs/idea/09-deployment.md#environment-reference.
 */
const timerMs = atLeastOne.refine((value) => value <= 2_147_483_647, "must fit a timer")

export const UPSTREAM_STREAM_ENV_FIELDS = {
  UPSTREAM_FIRST_BYTE_TIMEOUT_MS: timerMs.optional(),
  UPSTREAM_IDLE_TIMEOUT_MS: timerMs.optional(),
  UPSTREAM_STREAM_TIMEOUT_MS: timerMs.optional(),
}

type UpstreamStreamEnv = { readonly [K in keyof typeof UPSTREAM_STREAM_ENV_FIELDS]?: number }

export function readUpstreamStreamEnv(raw: UpstreamStreamEnv, ctx: z.RefinementCtx) {
  const upstreamStream = {
    firstByteMs: raw.UPSTREAM_FIRST_BYTE_TIMEOUT_MS ?? 300_000,
    idleMs: raw.UPSTREAM_IDLE_TIMEOUT_MS ?? 55_000,
    totalMs: raw.UPSTREAM_STREAM_TIMEOUT_MS ?? 3_600_000,
  }
  for (const [name, value] of [
    ["UPSTREAM_FIRST_BYTE_TIMEOUT_MS", upstreamStream.firstByteMs],
    ["UPSTREAM_IDLE_TIMEOUT_MS", upstreamStream.idleMs],
  ] as const) {
    if (value <= upstreamStream.totalMs) continue
    ctx.addIssue({
      code: "custom",
      path: [name],
      message: `must be at most UPSTREAM_STREAM_TIMEOUT_MS (${upstreamStream.totalMs}): a clock longer than the total deadline never fires`,
    })
  }
  return { upstreamStream }
}
