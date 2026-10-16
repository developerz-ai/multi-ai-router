import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { SDK_EPOCH_MILLIS_FLOOR } from "../claude-sdk/quota"

const credentialSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    expiresAt: z.number().finite().positive(),
  }),
})
const identitySchema = z.object({
  userID: z.string().regex(/^[0-9a-f]{64}$/),
  oauthAccount: z.object({ accountUuid: z.string().uuid() }),
})
export interface FastCredential {
  readonly accessToken: string
  readonly expiresAt: number
  readonly deviceId: string
  readonly accountUuid: string
}

/** No default HOME lookup, no refresh-token reads/writes, no caching stale rotated credentials. */
export async function readFastCredential(configDir: string): Promise<FastCredential | null> {
  try {
    const [secret, identity] = await Promise.all([
      readFile(join(configDir, ".credentials.json"), "utf8"),
      readFile(join(configDir, ".claude.json"), "utf8"),
    ])
    const oauth = credentialSchema.safeParse(JSON.parse(secret))
    const config = identitySchema.safeParse(JSON.parse(identity))
    if (!oauth.success || !config.success) return null
    const expiry = oauth.data.claudeAiOauth.expiresAt
    return {
      accessToken: oauth.data.claudeAiOauth.accessToken,
      expiresAt: expiry < SDK_EPOCH_MILLIS_FLOOR ? expiry * 1000 : expiry,
      deviceId: config.data.userID,
      accountUuid: config.data.oauthAccount.accountUuid,
    }
  } catch {
    // Parser and filesystem errors must never retain private file contents or paths.
    return null
  }
}
