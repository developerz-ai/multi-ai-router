// The wire shapes the fixture speaks — mirrors of the SPA's own
// `lib/api/types.ts` (AccountView, ApiKeyView, the usage wire), restated here so
// the fixture is one self-contained folder. Strings where the SPA narrows a
// union: the gate renders, it does not typecheck the API's vocabulary.
/** The counts are arbitrary; only their width on screen is load-bearing. */
export interface WireTotals {
  readonly requests: number
  readonly attempts: number
  readonly errors: number
  readonly tokensIn: number
  readonly tokensOut: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly costMetered: string
  readonly costNotional: string
}

/** The shape `AccountView` has — the fields every fixture account shares. */
export interface FixtureAccount {
  readonly id: string
  readonly label: string
  readonly provider: string
  readonly status: string
  readonly hasCredential: boolean
  readonly configDir: string | null
  readonly baseUrl: string | null
  readonly dialect: string | null
  readonly modelAliases: null
  readonly supportedModels: null
  readonly windowTokenLimits: null
  readonly weight: number
  readonly priority: number
  readonly billing: string
  readonly tokenExpiresAt: null
  readonly lastUsedAt: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly credential?: {
    readonly expiresAt: string
    readonly subscriptionType: string
    readonly rateLimitTier: string
    readonly present: boolean
    readonly accessTokenExpiresAt: string
    readonly lastLoginAt: string
    readonly renewsAt: string
    readonly renewsAtSource: string
    readonly daysUntilRenewal: number
    readonly renewalRequiredSoon: boolean
    readonly renewalWarnDays: number
  }
}

/** The shape `ApiKeyView` has; see `FixtureAccount` for the convention. */
export interface FixtureKey {
  readonly id: string
  readonly name: string
  readonly prefix: string
  readonly owner: string | null
  readonly ownerKind: string | null
  readonly tool: string | null
  readonly purpose: string | null
  readonly scope: {
    readonly kind: string
    readonly poolIds: readonly string[]
    readonly accountIds: readonly string[]
  }
  readonly rateLimit: null
  readonly expiresAt: null
  readonly revoked: boolean
  readonly revokedAt: string | null
  readonly lastUsedAt: string
  readonly createdAt: string
  readonly updatedAt: string
}
