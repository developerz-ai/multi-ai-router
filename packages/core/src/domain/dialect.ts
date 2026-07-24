import { z } from "zod"

/** The wire protocols the router speaks, on ingress and on egress. */
export const Dialect = z.enum(["anthropic", "openai-chat", "openai-responses"])
export type Dialect = z.infer<typeof Dialect>

/**
 * How a request reaches its upstream, decided per request from the ingress dialect and the
 * selected Account:
 *
 * - `passthrough` — same dialect. Headers swapped, body opaque, stream forwarded byte for byte.
 * - `translate` — HTTP driver, dialects differ. An explicit, documented conversion pair.
 * - `agent-sdk` — Claude subscription accounts. SDK output re-synthesized into the ingress
 *   dialect. Nominally same-dialect against Anthropic ingress, but still a re-synthesis and
 *   never a passthrough.
 */
export const EgressMode = z.enum(["passthrough", "translate", "agent-sdk"])
export type EgressMode = z.infer<typeof EgressMode>
