import { DEFAULT_MAX_BODY_BYTES } from "../services/dataplane/body/read"
import { DEFAULT_ADMIN_JSON_MAX_BYTES } from "./admin-bodies"
import type { Env } from "./env"

/** What `Bun.serve` is handed besides the handler. */
export interface ListenOptions {
  readonly port: number
  readonly maxRequestBodySize: number
  /** Seconds of silence in both directions before the server closes a connection; `0` never. */
  readonly idleTimeout: number
}

/**
 * Pure, and the only place the listener's options are assembled, so a test can hold the server's
 * idle clock to the stream heartbeats without opening a port. `main.ts` spreads this into
 * `Bun.serve`; nothing else should reach for `env.port` or the idle timeout directly.
 */
export function listenOptions(
  env: Pick<Env, "port" | "serverIdleTimeoutSeconds"> &
    Partial<Pick<Env, "dataPlane" | "adminBodies">>,
): ListenOptions {
  return {
    port: env.port,
    idleTimeout: env.serverIdleTimeoutSeconds,
    maxRequestBodySize: Math.max(
      env.dataPlane?.maxRequestBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      env.adminBodies?.maximumJsonBytes ?? DEFAULT_ADMIN_JSON_MAX_BYTES,
      env.adminBodies?.maximumLoginJsonBytes ?? 8 * 1024,
    ),
  }
}
