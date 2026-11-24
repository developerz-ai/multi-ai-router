import type {
  createAdminLoginThrottleRepository,
  LoginThrottleNamespace,
} from "@multi-ai-router/db"
import type { AdminAuthConfig } from "./config"
import { AdminAuthUnavailableError } from "./login-outcomes"
import { createLoginThrottle, type ThrottleDecision } from "./throttle"

export interface SharedThrottle {
  consume(namespace: LoginThrottleNamespace, key: string): Promise<ThrottleDecision>
  reset(namespace: LoginThrottleNamespace, key: string): Promise<void>
}

export function createSharedThrottle(
  repository: ReturnType<typeof createAdminLoginThrottleRepository>,
  config: AdminAuthConfig,
): SharedThrottle {
  return {
    async consume(namespace, key) {
      try {
        return await repository.consume(namespace, key, config)
      } catch (cause) {
        throw new AdminAuthUnavailableError({ cause })
      }
    },
    async reset(namespace, key) {
      try {
        await repository.reset(namespace, key)
      } catch (cause) {
        throw new AdminAuthUnavailableError({ cause })
      }
    },
  }
}

/** Isolated service tests only. Production always injects Postgres. */
export function createMemorySharedThrottle(
  config: AdminAuthConfig,
  now: () => number,
  evictionIntervalMs?: number,
): SharedThrottle {
  const budgets = {
    local: createLoginThrottle(config, { evictionIntervalMs }),
    "oidc-start": createLoginThrottle(config, { evictionIntervalMs }),
    "oidc-callback": createLoginThrottle(config, { evictionIntervalMs }),
  }
  return {
    async consume(namespace, key) {
      const at = now()
      const decision = budgets[namespace].check([key], at)
      if (decision.allowed) budgets[namespace].recordFailure([key], at)
      return decision
    },
    async reset(namespace, key) {
      budgets[namespace].reset([key])
    },
  }
}
