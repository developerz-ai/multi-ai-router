import type { Logger } from "./logging/logger"

/**
 * The Hono environment every route and middleware in the transport layer shares. Transport is
 * the only layer that knows Hono exists (docs/idea/01-architecture.md, dependency rule 5), so
 * this type never leaves it.
 */
export interface AppEnv {
  Variables: {
    /** Correlation id assigned at ingress and propagated end to end. */
    requestId: string
    /** Request-scoped logger, pre-bound with `requestId` and `component`. */
    log: Logger
  }
}
