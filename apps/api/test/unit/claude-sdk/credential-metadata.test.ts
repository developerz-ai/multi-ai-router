import { describe, expect, test } from "bun:test"
import {
  createCredentialMetadataReader,
  UNKNOWN_CREDENTIAL_METADATA,
} from "../../../src/providers/claude-sdk/credential-metadata"
import { CREDENTIALS_FILE, type CredentialFs } from "../../../src/providers/claude-sdk/login"

/**
 * The metadata reader: the one module that parses `.credentials.json`, and the assertions that
 * matter most are the ones about what it does *not* hand back.
 *
 * Every token here is a fabricated string in the CLI's shape with obviously fake contents. Nothing
 * in this file is, or was ever, a real credential.
 */

const DIR = "/data/claude/8e0d3f4a-0000-4000-8000-00000000abcd"
const PATH = `${DIR}/${CREDENTIALS_FILE}`

const FAKE_ACCESS = "sk-ant-oat01-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE-not-a-real-token"
const FAKE_REFRESH = "sk-ant-ort01-FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE-not-a-real-token"
const REFRESH_EXPIRES_MS = 1_790_000_000_000

/** The file as the CLI writes it after a login — every field, epoch milliseconds. */
const LIVE = {
  claudeAiOauth: {
    accessToken: FAKE_ACCESS,
    refreshToken: FAKE_REFRESH,
    expiresAt: 1_788_000_000_000,
    refreshTokenExpiresAt: REFRESH_EXPIRES_MS,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
  },
}

/** The same file after the refresh token expired: the CLI blanks the tokens and keeps the rest. */
const BLANKED = {
  claudeAiOauth: {
    ...LIVE.claudeAiOauth,
    accessToken: "",
    refreshToken: "",
  },
}

function fsOf(contents: string | null): Pick<CredentialFs, "read"> & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    read: async (path) => {
      reads.push(path)
      return path === PATH ? contents : null
    },
  }
}

describe("reading credential metadata", () => {
  test("returns the expiry, plan and tier, and reports the tokens as present", async () => {
    const fs = fsOf(JSON.stringify(LIVE))
    const metadata = await createCredentialMetadataReader(fs).read(DIR)

    expect(metadata).toEqual({
      refreshTokenExpiresAt: new Date(REFRESH_EXPIRES_MS),
      accessTokenExpiresAt: new Date(1_788_000_000_000),
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
      hasTokens: true,
    })
    expect(fs.reads).toEqual([PATH])
  })

  test("never lets a token out: not as a value, not as a key", async () => {
    const metadata = await createCredentialMetadataReader(fsOf(JSON.stringify(LIVE))).read(DIR)
    const serialized = JSON.stringify(metadata)

    // Quoted, so `refreshTokenExpiresAt` — a key that is allowed — does not mask the check.
    expect(serialized).not.toContain('"accessToken"')
    expect(serialized).not.toContain('"refreshToken"')
    expect(serialized).not.toContain('"scopes"')
    for (const token of [FAKE_ACCESS, FAKE_REFRESH]) {
      // Not the whole token and not any recognisable piece of it.
      expect(serialized).not.toContain(token)
      expect(serialized).not.toContain(token.slice(0, 20))
      expect(serialized).not.toContain(token.slice(-20))
    }
    // The exhaustive key list is the guard: a field added to the reader has to be added here too,
    // which is where someone would notice they had just widened it to something token-shaped.
    expect(Object.keys(metadata).sort()).toEqual([
      "accessTokenExpiresAt",
      "hasTokens",
      "rateLimitTier",
      "refreshTokenExpiresAt",
      "subscriptionType",
    ])
  })

  test("blank tokens read as absent while the metadata beside them is kept", async () => {
    const metadata = await createCredentialMetadataReader(fsOf(JSON.stringify(BLANKED))).read(DIR)

    expect(metadata.hasTokens).toBe(false)
    expect(metadata.refreshTokenExpiresAt).toEqual(new Date(REFRESH_EXPIRES_MS))
    expect(metadata.subscriptionType).toBe("max")
    expect(metadata.rateLimitTier).toBe("default_claude_max_20x")
  })

  test("one blank token is as absent as two", async () => {
    const half = { claudeAiOauth: { ...LIVE.claudeAiOauth, refreshToken: "" } }
    const metadata = await createCredentialMetadataReader(fsOf(JSON.stringify(half))).read(DIR)
    expect(metadata.hasTokens).toBe(false)
  })

  test("a missing file is unknown metadata with no tokens", async () => {
    const metadata = await createCredentialMetadataReader(fsOf(null)).read(DIR)
    expect(metadata).toEqual(UNKNOWN_CREDENTIAL_METADATA)
  })

  test("an empty file is the same as a missing one", async () => {
    const metadata = await createCredentialMetadataReader(fsOf("  \n")).read(DIR)
    expect(metadata).toEqual(UNKNOWN_CREDENTIAL_METADATA)
  })

  test("malformed JSON is unknown, not a throw", async () => {
    const metadata = await createCredentialMetadataReader(fsOf("{ not json")).read(DIR)
    expect(metadata).toEqual(UNKNOWN_CREDENTIAL_METADATA)
  })

  test("a file without claudeAiOauth is unknown", async () => {
    const metadata = await createCredentialMetadataReader(
      fsOf(JSON.stringify({ somethingElse: { accessToken: FAKE_ACCESS } })),
    ).read(DIR)
    expect(metadata).toEqual(UNKNOWN_CREDENTIAL_METADATA)
  })

  test("a claudeAiOauth of the wrong shape is unknown", async () => {
    const metadata = await createCredentialMetadataReader(
      fsOf(JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: "tomorrow" } })),
    ).read(DIR)
    expect(metadata).toEqual(UNKNOWN_CREDENTIAL_METADATA)
  })

  test("fields the CLI did not write are null, not undefined", async () => {
    const sparse = { claudeAiOauth: { accessToken: FAKE_ACCESS, refreshToken: FAKE_REFRESH } }
    const metadata = await createCredentialMetadataReader(fsOf(JSON.stringify(sparse))).read(DIR)

    expect(metadata).toEqual({
      refreshTokenExpiresAt: null,
      accessTokenExpiresAt: null,
      subscriptionType: null,
      rateLimitTier: null,
      hasTokens: true,
    })
  })

  test("an expiry written in epoch seconds is read as the same instant", async () => {
    const seconds = {
      claudeAiOauth: { ...LIVE.claudeAiOauth, refreshTokenExpiresAt: REFRESH_EXPIRES_MS / 1000 },
    }
    const metadata = await createCredentialMetadataReader(fsOf(JSON.stringify(seconds))).read(DIR)
    expect(metadata.refreshTokenExpiresAt).toEqual(new Date(REFRESH_EXPIRES_MS))
  })

  test("a zero or negative expiry is unknown, never 1970", async () => {
    for (const bogus of [0, -5]) {
      const file = { claudeAiOauth: { ...LIVE.claudeAiOauth, refreshTokenExpiresAt: bogus } }
      const metadata = await createCredentialMetadataReader(fsOf(JSON.stringify(file))).read(DIR)
      expect(metadata.refreshTokenExpiresAt).toBeNull()
    }
  })

  test("a filesystem failure propagates: could-not-read is not no-credential", async () => {
    const failing: Pick<CredentialFs, "read"> = {
      read: async () => {
        throw new Error("EACCES: permission denied")
      },
    }
    await expect(createCredentialMetadataReader(failing).read(DIR)).rejects.toThrow("EACCES")
  })
})
