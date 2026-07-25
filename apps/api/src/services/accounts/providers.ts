import { type AuthKind, Dialect, type ProviderId } from "@multi-ai-router/core"
import type { ProviderDriver } from "../../providers"
import { PROVIDER_REGISTRY } from "../../providers"

/**
 * The provider registry, described for the console.
 *
 * Everything here is *derived* from `providers/registry.ts` and the driver
 * interface — nothing restates a provider list, an endpoint, or a dialect. That
 * is the point: the SPA's "add account" form must not hard-code a provider set
 * (CLAUDE.md non-negotiable 12 — adding a provider touches one file under
 * `providers/`), and neither must the validation that guards account writes.
 *
 * `requiresBaseUrl` and `supportedDialects` are probed through the driver
 * rather than read from a second table, because the driver already owns both
 * answers: `resolveBaseUrl` throws when a provider has no pinned default, and
 * `resolveDialect` echoes back only the surfaces that provider actually serves.
 */

/**
 * Stands in for an account that does not exist yet. Only ever reaches a driver's
 * pure resolvers, and only their return value is used — never a message.
 */
const PROBE_ID = "00000000-0000-0000-0000-000000000000"

export type ProviderTransport = "http" | "agent-sdk" | "unimplemented"

export interface ProviderDescriptor {
  readonly id: ProviderId
  /** How this provider is served: an HTTP driver, the Claude Agent SDK, or not at all yet. */
  readonly transport: ProviderTransport
  /** `null` where the provider has no implementation to have an auth style. */
  readonly authKind: AuthKind | null
  /** The wire protocol the provider speaks when the account states no preference. */
  readonly nativeDialect: Dialect | null
  /** Surfaces an account may pin. More than one only where the provider exposes more than one. */
  readonly supportedDialects: readonly Dialect[]
  /** True for the `*-compatible` escape hatches: no pinned endpoint, the operator supplies one. */
  readonly requiresBaseUrl: boolean
  /** Claude subscriptions carry a `CLAUDE_CONFIG_DIR` instead of a router-held credential. */
  readonly requiresConfigDir: boolean
  /** False means an account cannot be created for it — the console greys the option out. */
  readonly creatable: boolean
  /** Why an unimplemented or SDK-served provider is what it is. Verbatim from the registry. */
  readonly reason: string | null
}

export function describeProviders(): readonly ProviderDescriptor[] {
  return Object.keys(PROVIDER_REGISTRY)
    .map((id) => describeProvider(id as ProviderId))
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function describeProvider(id: ProviderId): ProviderDescriptor {
  const support = PROVIDER_REGISTRY[id]

  if (support.transport === "http") {
    const driver = support.driver
    return {
      id,
      transport: "http",
      authKind: driver.authKind,
      nativeDialect: driver.dialect,
      supportedDialects: supportedDialects(driver),
      requiresBaseUrl: !hasPinnedBaseUrl(driver, id),
      requiresConfigDir: false,
      creatable: true,
      reason: null,
    }
  }

  if (support.transport === "agent-sdk") {
    // One surface, and it is the driver's, not the account's: the SDK's output is re-synthesized
    // into exactly one dialect and every other ingress is served by translating from it
    // (docs/idea/11-anthropic-agent-sdk.md §6). So the form offers no dialect choice here.
    const driver = support.driver
    return {
      id,
      transport: "agent-sdk",
      authKind: driver.authKind,
      nativeDialect: driver.dialect,
      supportedDialects: [driver.dialect],
      requiresBaseUrl: false,
      requiresConfigDir: true,
      creatable: true,
      reason: support.reason,
    }
  }

  return {
    id,
    transport: "unimplemented",
    authKind: null,
    nativeDialect: null,
    supportedDialects: [],
    requiresBaseUrl: false,
    requiresConfigDir: false,
    creatable: false,
    reason: support.reason,
  }
}

/** The surfaces the driver echoes back — anything else falls through to its default. */
function supportedDialects(driver: ProviderDriver): readonly Dialect[] {
  return Dialect.options.filter(
    (dialect) => driver.resolveDialect({ id: PROBE_ID, provider: driver.id, dialect }) === dialect,
  )
}

/**
 * Asked of the driver rather than of a second endpoint table. `resolveBaseUrl`
 * throws for an account with no override on a provider with no pinned default,
 * which is exactly the question — see `providers/base-url.ts`.
 */
function hasPinnedBaseUrl(driver: ProviderDriver, id: ProviderId): boolean {
  try {
    driver.resolveBaseUrl({ id: PROBE_ID, provider: id })
    return true
  } catch {
    return false
  }
}
