import { join } from "node:path"
import { z } from "zod"
import { CREDENTIALS_FILE, type CredentialFs } from "./login/credentials"
import { SDK_EPOCH_MILLIS_FLOOR } from "./quota"

/**
 * What the router is allowed to know about a Claude subscription's credential: when its login dies,
 * what plan it is on, and whether there is a token there at all. **Never the token.**
 *
 * The `claude` CLI writes `.credentials.json` with `claudeAiOauth: { accessToken, refreshToken,
 * expiresAt, refreshTokenExpiresAt, scopes, subscriptionType, rateLimitTier }`. The refresh token
 * hard-expires ~30 days after login however much the Account is used; past that the CLI blanks both
 * tokens to empty strings and keeps the metadata (docs/idea/11-anthropic-agent-sdk.md §3). Until
 * this reader existed the operator had no way to see the expiry coming — only the day after, when
 * every request to the Account failed.
 *
 * **This is metadata, not the credential** (CLAUDE.md non-negotiables 1 and 13). The router does
 * not touch, refresh, forward, or use the tokens; the Agent SDK owns them inside the Account's
 * `CLAUDE_CONFIG_DIR` and refreshes them itself. What is read here is *when the login expires*, so
 * the console can warn before it does. The schema below picks exactly the fields it names; the two
 * token fields are consulted for **presence only** and are dropped before the parsed value leaves
 * this function. Nothing returned, thrown, or logged from this module can carry a token — there is
 * no field in {@link CredentialMetadata} that could hold one.
 *
 * Reuses the same read seam as `login/credentials.ts` (`CredentialFs.read`) so a test runs against
 * no disk and the production path opens the file exactly the way the compactness guard does.
 */

export interface CredentialMetadata {
  /** When the refresh token — and so the login — dies. Null when the file does not say. */
  readonly refreshTokenExpiresAt: Date | null
  /**
   * When the *access* token goes stale and the CLI will refresh on its next spawn — roughly every
   * eight hours, and a different fact from {@link refreshTokenExpiresAt}. Null when the file does
   * not say, which callers must read as "unknown", never as "fresh".
   *
   * This is the instant `credential-freshness.ts` serializes around: the refresh token rotates on
   * use, so two subprocesses crossing this moment together double-spend it and the loser's CLI
   * blanks the file. Knowing *when* is what makes that window narrow enough to guard cheaply.
   */
  readonly accessTokenExpiresAt: Date | null
  /** `"max"`, `"pro"`, `"team"`, … as the CLI recorded it. */
  readonly subscriptionType: string | null
  readonly rateLimitTier: string | null
  /**
   * True only when **both** tokens are non-empty strings. False for a missing file, an unparseable
   * one, a missing `claudeAiOauth`, and — the case this exists for — a file the CLI has blanked
   * after the refresh token expired. Those cases are deliberately not told apart here: none of them
   * is a login the SDK can use.
   */
  readonly hasTokens: boolean
}

export interface CredentialMetadataReader {
  /**
   * Reads the metadata under `configDir`. Missing, malformed, or shapeless files are answered with
   * {@link UNKNOWN_CREDENTIAL_METADATA} rather than thrown; an I/O failure from the filesystem seam
   * propagates, because "could not read" is a different fact from "read, and nothing there".
   */
  read(configDir: string): Promise<CredentialMetadata>
}

/** No credential to speak of: nulls and `hasTokens: false`. */
export const UNKNOWN_CREDENTIAL_METADATA: CredentialMetadata = Object.freeze({
  refreshTokenExpiresAt: null,
  accessTokenExpiresAt: null,
  subscriptionType: null,
  rateLimitTier: null,
  hasTokens: false,
})

/**
 * Only what this module needs, and nothing more is retained: `looseObject` lets the CLI add fields
 * without breaking the parse, while the parsed object handed downstream is rebuilt from the named
 * fields alone — see {@link toMetadata}. The tokens are typed as `unknown` on purpose: their
 * *value* is never inspected past "is this a non-empty string".
 */
const credentialFileSchema = z.looseObject({
  claudeAiOauth: z
    .looseObject({
      accessToken: z.unknown().optional(),
      refreshToken: z.unknown().optional(),
      expiresAt: z.number().nullable().optional(),
      refreshTokenExpiresAt: z.number().nullable().optional(),
      subscriptionType: z.string().nullable().optional(),
      rateLimitTier: z.string().nullable().optional(),
    })
    .optional(),
})

export function createCredentialMetadataReader(
  fs: Pick<CredentialFs, "read"> = nodeCredentialRead,
): CredentialMetadataReader {
  return {
    read: async (configDir) => {
      const contents = await fs.read(join(configDir, CREDENTIALS_FILE))
      if (contents === null || contents.trim().length === 0) return UNKNOWN_CREDENTIAL_METADATA

      const parsed = credentialFileSchema.safeParse(parseJson(contents))
      if (!parsed.success || parsed.data.claudeAiOauth === undefined) {
        return UNKNOWN_CREDENTIAL_METADATA
      }
      return toMetadata(parsed.data.claudeAiOauth)
    },
  }
}

type ParsedOauth = NonNullable<z.infer<typeof credentialFileSchema>["claudeAiOauth"]>

/**
 * The one place the token fields are looked at, and only for presence. The returned object is built
 * field by field so nothing the parser kept — the tokens, `scopes`, whatever the CLI adds next —
 * can ride along.
 */
function toMetadata(oauth: ParsedOauth): CredentialMetadata {
  const hasTokens = isNonEmptyString(oauth.accessToken) && isNonEmptyString(oauth.refreshToken)
  return {
    refreshTokenExpiresAt: toInstant(oauth.refreshTokenExpiresAt),
    accessTokenExpiresAt: toInstant(oauth.expiresAt),
    subscriptionType: oauth.subscriptionType ?? null,
    rateLimitTier: oauth.rateLimitTier ?? null,
    hasTokens,
  }
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0
}

/**
 * The CLI writes epoch **milliseconds** (`login/credentials.ts` relies on the same fact for
 * `expiresAt`). Seconds are accepted too, on the same floor `quota.ts` uses for the SDK's reset
 * instants: anything below it cannot be a plausible millisecond instant and is therefore seconds.
 * A non-finite or non-positive value is *unknown*, never 1970.
 */
function toInstant(epoch: number | null | undefined): Date | null {
  if (epoch === null || epoch === undefined) return null
  if (!Number.isFinite(epoch) || epoch <= 0) return null
  return new Date(epoch < SDK_EPOCH_MILLIS_FLOOR ? epoch * 1000 : epoch)
}

/** Never `${contents}` and never a field name in the failure path: malformed is simply `undefined`. */
function parseJson(contents: string): unknown {
  try {
    return JSON.parse(contents)
  } catch {
    return undefined
  }
}

const nodeCredentialRead: Pick<CredentialFs, "read"> = {
  read: async (path) => {
    const file = Bun.file(path)
    return (await file.exists()) ? file.text() : null
  },
}
