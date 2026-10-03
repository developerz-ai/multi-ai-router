import { describe, expect, test } from "bun:test"
import { OPENAI_AUTH_CLAIM, openAiOAuthDriver } from "../../../src/providers/drivers/openai-oauth"
import { readStoredOAuth, writeStoredOAuth } from "../../../src/services/accounts"
import { accountCredential } from "../../../src/services/dataplane/egress/credential"
import { account } from "../dataplane/fixtures"
import { CIPHER } from "./refresh-fixtures"

function jwt(id: string): string {
  return `header.${Buffer.from(JSON.stringify({ [OPENAI_AUTH_CLAIM]: { chatgpt_account_id: id } })).toString("base64url")}.sig`
}
const flow = openAiOAuthDriver.oauth
if (flow === undefined) throw new Error("OpenAI driver needs OAuth flow")

describe("encrypted OAuth identity", () => {
  test("ID-token-only identity reaches actual warm egress headers with opaque access", () => {
    const tokens = flow.readTokens({ access_token: "opaque-access", id_token: jwt("id-only") })
    expect(tokens?.providerAccountId).toBe("id-only")
    const stored = writeStoredOAuth({
      accessToken: tokens?.accessToken as string,
      refreshToken: tokens?.refreshToken ?? null,
      providerAccountId: tokens?.providerAccountId ?? null,
    })
    expect(stored).not.toContain("id_token")
    expect(stored).not.toContain(jwt("id-only"))
    const row = {
      ...account("a", { provider: "openai-oauth" }),
      authMaterial: CIPHER.encrypt(stored),
    }
    const credential = accountCredential(row, CIPHER, "oauth")
    const headers = openAiOAuthDriver.buildHeaders(row.driver, credential)
    expect(headers.get("chatgpt-account-id")).toBe("id-only")
    expect(headers.get("authorization")).toBe("Bearer opaque-access")
    expect(JSON.stringify(credential)).not.toContain("refreshToken")
  })
  test("legacy held access JWT preserves identity after opaque refresh response", () => {
    const tokens = flow.readTokens(
      { access_token: "opaque-new" },
      { previousAccessToken: jwt("legacy-id") },
    )
    expect(tokens?.providerAccountId).toBe("legacy-id")
    expect(flow.readTokens({ access_token: "opaque-new" })).toBeNull()
  })
  test("fresh identity wins, previous stored identity wins over old claim", () => {
    expect(
      flow.readTokens(
        { access_token: jwt("fresh-access"), id_token: jwt("fresh-id") },
        { previousProviderAccountId: "held-id", previousAccessToken: jwt("legacy-id") },
      )?.providerAccountId,
    ).toBe("fresh-id")
    expect(
      flow.readTokens(
        { access_token: "opaque-new" },
        { previousProviderAccountId: " held-id ", previousAccessToken: jwt("legacy-id") },
      )?.providerAccountId,
    ).toBe("held-id")
  })
  test("initial authorization cannot inherit identity from earlier account", () => {
    expect(flow.readTokens({ access_token: "opaque", refresh_token: "R" })).toBeNull()
    expect(
      flow.readTokens({ access_token: "opaque" }, { previousAccessToken: "opaque-old" }),
    ).toBeNull()
  })
  test("camel/snake envelopes normalize identity and explicit stored identity wins on egress", () => {
    const held = readStoredOAuth(
      JSON.stringify({
        access_token: jwt("claim-id"),
        refresh_token: "R",
        provider_account_id: " stored-id ",
      }),
    )
    expect(held).toMatchObject({ providerAccountId: "stored-id", refreshToken: "R" })
    const row = {
      ...account("a", { provider: "openai-oauth" }),
      authMaterial: CIPHER.encrypt(writeStoredOAuth(held as NonNullable<typeof held>)),
    }
    expect(
      openAiOAuthDriver
        .buildHeaders(row.driver, accountCredential(row, CIPHER, "oauth"))
        .get("chatgpt-account-id"),
    ).toBe("stored-id")
    expect(readStoredOAuth('{"accessToken":"a"}')).toEqual({
      accessToken: "a",
      refreshToken: null,
      providerAccountId: null,
    })
  })
})
