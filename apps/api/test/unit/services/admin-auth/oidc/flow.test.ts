import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { AdminAuthError } from "@multi-ai-router/core"
import { createOIDCFlow } from "../../../../../src/services/admin-auth/oidc/flow"
import { createCredentialCipher } from "../../../../../src/services/crypto/cipher"
import { createMemoryStore } from "../../../../support/memory-store"

/**
 * The flow end-to-end: a real `id_token` signed with a fixture key, a real
 * JWKS endpoint, a real token endpoint, and a real `oauth_states` table
 * substitute. The only stub is the network — `fetch` is replaced with a
 * router that answers the URLs the IdP would have answered.
 */

const ISSUER = "https://sso.test"
const CLIENT_ID = "multi-ai-router"
const ADMIN_EMAIL = "admin@test"

type KeyPair = { privateKey: CryptoKey; publicJwk: JsonWebKey }

async function newKeyPair(kid: string): Promise<KeyPair> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
  return { privateKey: pair.privateKey, publicJwk: { ...jwk, kid, alg: "RS256" } }
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

function b64urlJson(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)))
}

async function signId(payload: Record<string, unknown>, keyPair: KeyPair): Promise<string> {
  const header = b64urlJson({ alg: "RS256", kid: keyPair.publicJwk.kid, typ: "JWT" })
  const body = b64urlJson(payload)
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    keyPair.privateKey,
    new TextEncoder().encode(`${header}.${body}`),
  )
  return `${header}.${body}.${b64url(new Uint8Array(signature))}`
}

function buildDiscovery(): unknown {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth2/v2/authorize`,
    token_endpoint: `${ISSUER}/oauth2/v2/token`,
    jwks_uri: `${ISSUER}/oauth2/v2/keys`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["openid", "profile", "email"],
    id_token_signing_alg_values_supported: ["RS256"],
  }
}

interface Harness {
  store: ReturnType<typeof createMemoryStore>
  cipher: ReturnType<typeof createCredentialCipher>
  now: { ms: number }
  keyPair: KeyPair
  /**
   * Patch the email/sub claims that the token endpoint will mint. Tests
   * exercise the principal-matching rule by setting one of these to a value
   * the configured admin would not satisfy.
   */
  emailOverride: string | null
  subOverride: string | null
  verifiedOverride: boolean | null
  /** Provider-specific claims (`kind`, `groups`, …) signed into the id_token. */
  extraClaims: Record<string, unknown>
}

interface TestHarness {
  h: Harness
  fetch: typeof fetch
}

async function buildHarness(
  overrides: Partial<{
    email: string
    sub: string | null
    verified: boolean | null
    extraClaims: Record<string, unknown>
  }> = {},
): Promise<TestHarness> {
  const store = createMemoryStore()
  const cipher = createCredentialCipher({ key: new Uint8Array(32).fill(7) })
  const now = { ms: 1_700_000_000_000 }
  const keyPair = await newKeyPair("kid-1")
  const h: Harness = {
    store,
    cipher,
    now,
    keyPair,
    emailOverride: overrides.email ?? null,
    subOverride: overrides.sub ?? null,
    verifiedOverride: overrides.verified ?? null,
    extraClaims: overrides.extraClaims ?? {},
  }

  const discovery = buildDiscovery()
  const jwksUri = `${ISSUER}/oauth2/v2/keys`

  const fetchImpl: typeof fetch = async (url, init) => {
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return new Response(JSON.stringify(discovery), { status: 200 })
    }
    if (url === jwksUri) {
      return new Response(JSON.stringify({ keys: [keyPair.publicJwk] }), { status: 200 })
    }
    if (url === `${ISSUER}/oauth2/v2/token`) {
      const rawBody = (init?.body as string) ?? ""
      const params = new URLSearchParams(rawBody)
      const code = params.get("code") ?? ""
      const codeVerifier = params.get("code_verifier") ?? ""
      const expectedChallenge = createHash("sha256").update(codeVerifier).digest("base64url")
      const [state, challenge] = code.split(":", 2)
      if (state === undefined || challenge === undefined) {
        return new Response("invalid code", { status: 400 })
      }
      if (challenge !== expectedChallenge) {
        return new Response("verifier mismatch", { status: 400 })
      }
      const row = h.store.rows.oauthStates.find((r) => r.state === state)
      if (row === undefined) {
        return new Response("no state", { status: 400 })
      }
      const nonce = h.cipher.decrypt(row.nonce ?? "")
      const iat = Math.floor(h.now.ms / 1000)
      const exp = iat + 600
      const email = h.emailOverride ?? ADMIN_EMAIL
      const sub = h.subOverride ?? "subject-1"
      const verified = h.verifiedOverride ?? true
      const idToken = await signId(
        {
          iss: ISSUER,
          aud: CLIENT_ID,
          sub,
          iat,
          exp,
          email,
          email_verified: verified,
          nonce,
          ...h.extraClaims,
        },
        keyPair,
      )
      return new Response(JSON.stringify({ id_token: idToken }))
    }
    return new Response("not found", { status: 404 })
  }
  return { h, fetch: fetchImpl }
}

function buildFlow(
  h: Harness,
  fetch: typeof fetch,
  config: Parameters<typeof createOIDCFlow>[0]["config"],
) {
  return createOIDCFlow({
    config,
    stateStore: {
      states: h.store.oauthStates,
      cipher: h.cipher,
      stateMinutes: 10,
      now: () => new Date(h.now.ms),
    },
    fetch,
    now: () => new Date(h.now.ms),
  })
}

function baseConfig(): Parameters<typeof createOIDCFlow>[0]["config"] {
  return {
    issuerUrl: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: "shh",
    redirectUri: "https://router.test/api/admin/auth/oidc/callback",
    adminEmails: [ADMIN_EMAIL],
    scopes: ["openid", "profile", "email"],
  }
}

async function startAndMintCode(
  h: Harness,
  _flow: ReturnType<typeof createOIDCFlow>,
  state: string,
) {
  const row = h.store.rows.oauthStates.find((r) => r.state === state)
  if (row === undefined) throw new Error("state row missing")
  const codeVerifier = h.cipher.decrypt(row.codeVerifier)
  const challenge = createHash("sha256").update(codeVerifier).digest("base64url")
  return { state, code: `${state}:${challenge}` }
}

describe("createOIDCFlow", () => {
  test("happy path: start() returns an authorize URL, complete() returns the principal", async () => {
    const { h, fetch } = await buildHarness()
    const flow = buildFlow(h, fetch, baseConfig())

    const { authorizeUrl, state } = await flow.start()
    expect(authorizeUrl).toContain("/oauth2/v2/authorize")
    expect(authorizeUrl).toContain(`client_id=${CLIENT_ID}`)
    expect(authorizeUrl).toContain("code_challenge_method=S256")
    expect(authorizeUrl).toContain("scope=openid+profile+email")

    const { code } = await startAndMintCode(h, flow, state)
    const principal = await flow.complete({ code, state })
    expect(principal.email).toBe(ADMIN_EMAIL)
    expect(principal.subject).toBe("subject-1")
  })

  test("state mismatch: a state the IdP never saw is rejected", async () => {
    const { h, fetch } = await buildHarness()
    const flow = buildFlow(h, fetch, baseConfig())
    await flow.start()

    expect(
      flow.complete({ code: "anything:anywhere", state: "never-issued" }),
    ).rejects.toBeInstanceOf(AdminAuthError)
  })

  test("code reuse: a redeemed state cannot be used again", async () => {
    const { h, fetch } = await buildHarness()
    const flow = buildFlow(h, fetch, baseConfig())
    const { state } = await flow.start()
    const { code } = await startAndMintCode(h, flow, state)

    const first = await flow.complete({ code, state })
    expect(first.email).toBe(ADMIN_EMAIL)

    expect(flow.complete({ code, state })).rejects.toBeInstanceOf(AdminAuthError)
  })

  test("email mismatch: an id_token whose email is in no allowlist entry is rejected", async () => {
    const { h, fetch } = await buildHarness({ email: "someone-else@test" })
    const flow = buildFlow(h, fetch, { ...baseConfig(), adminEmails: ["a@test", "b@test"] })
    const { state } = await flow.start()
    const { code } = await startAndMintCode(h, flow, state)

    expect(flow.complete({ code, state })).rejects.toBeInstanceOf(AdminAuthError)
  })

  test("the rejection carries the operator-only reason and never the wording's detail", async () => {
    const { h, fetch } = await buildHarness({ email: "someone-else@test" })
    const flow = buildFlow(h, fetch, baseConfig())
    const { state } = await flow.start()
    const { code } = await startAndMintCode(h, flow, state)

    const err = await flow.complete({ code, state }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(AdminAuthError)
    // The kind is what `docs/idea/13-admin-oidc.md`'s troubleshooting table tells the operator to
    // grep for, and it reaches the log only through this field.
    expect((err as AdminAuthError).reason).toContain("principal")
    // The browser-facing half stays the one uninformative sentence — a `reason` that leaked into
    // `message` would make the callback a probe oracle for which emails are configured.
    expect((err as AdminAuthError).message).not.toContain("someone-else@test")
  })

  test("a second allowlist entry signs in, and case does not matter", async () => {
    const { h, fetch } = await buildHarness({ email: "Second.Operator@Test" })
    const flow = buildFlow(h, fetch, {
      ...baseConfig(),
      // As the env layer produces them: lowercased and deduplicated.
      adminEmails: [ADMIN_EMAIL, "second.operator@test"],
    })
    const { state } = await flow.start()
    const { code } = await startAndMintCode(h, flow, state)

    const principal = await flow.complete({ code, state })
    // The asserted spelling is preserved — it is what the session and the audit row show.
    expect(principal.email).toBe("Second.Operator@Test")
  })

  test("subject mismatch: an id_token whose sub does not match the configured admin is rejected", async () => {
    const { h, fetch } = await buildHarness({ sub: "different-subject" })
    const flow = buildFlow(h, fetch, {
      ...baseConfig(),
      adminSubject: "the-expected-sub",
    })
    const { state } = await flow.start()
    const { code } = await startAndMintCode(h, flow, state)

    expect(flow.complete({ code, state })).rejects.toBeInstanceOf(AdminAuthError)
  })

  test("email_verified=false is rejected", async () => {
    const { h, fetch } = await buildHarness({ verified: false })
    const flow = buildFlow(h, fetch, baseConfig())
    const { state } = await flow.start()
    const { code } = await startAndMintCode(h, flow, state)

    expect(flow.complete({ code, state })).rejects.toBeInstanceOf(AdminAuthError)
  })
})

/**
 * `ADMIN_OIDC_REQUIRED_CLAIMS`: claim-based admission for an IdP that marks who may sign in (equipo
 * signs `kind: "dev_user"` into the id_token for staff). Failure cases first.
 */
describe("createOIDCFlow required claims", () => {
  const STAFF = [{ name: "kind", value: "dev_user" }] as const

  function claimsOnly(): Parameters<typeof createOIDCFlow>[0]["config"] {
    return { ...baseConfig(), adminEmails: null, requiredClaims: STAFF }
  }

  async function signIn(
    config: Parameters<typeof createOIDCFlow>[0]["config"],
    overrides: Parameters<typeof buildHarness>[0],
  ): Promise<{ readonly email: string } | AdminAuthError> {
    const { h, fetch } = await buildHarness(overrides)
    const flow = buildFlow(h, fetch, config)
    const { state } = await flow.start()
    const { code } = await startAndMintCode(h, flow, state)
    return flow.complete({ code, state }).then(
      (principal) => principal,
      (err: unknown) => {
        if (err instanceof AdminAuthError) return err
        throw err
      },
    )
  }

  function expectPrincipalRejection(result: unknown, ...mustNotContain: string[]): string {
    expect(result).toBeInstanceOf(AdminAuthError)
    const err = result as AdminAuthError
    const reason = err.reason ?? ""
    expect(reason.startsWith("principal: ")).toBe(true)
    expect(reason).toContain('"kind"')
    expect(err.message).toBe("Single sign-on verification failed. Try again.")
    for (const leaked of mustNotContain) expect(reason).not.toContain(leaked)
    return reason
  }

  test("claim missing: rejected as a principal mismatch", async () => {
    const reason = expectPrincipalRejection(await signIn(claimsOnly(), {}))
    expect(reason).toContain('no "kind" claim')
  })

  test("wrong value: rejected, and the token's value is never echoed", async () => {
    expectPrincipalRejection(
      await signIn(claimsOnly(), { extraClaims: { kind: "user" } }),
      '"user"',
      "=user",
    )
  })

  test("comparison is case-sensitive: DEV_USER is not dev_user", async () => {
    expectPrincipalRejection(await signIn(claimsOnly(), { extraClaims: { kind: "DEV_USER" } }))
  })

  for (const shape of [true, 1, null, { value: "dev_user" }]) {
    test(`a non-string, non-array claim (${JSON.stringify(shape)}) is rejected`, async () => {
      expectPrincipalRejection(await signIn(claimsOnly(), { extraClaims: { kind: shape } }))
    })
  }

  test("an array that does not contain the value is rejected", async () => {
    expectPrincipalRejection(
      await signIn(claimsOnly(), { extraClaims: { kind: ["user", "dev_user_x"] } }),
    )
  })

  test("every pair must match: one of two failing rejects", async () => {
    const config = {
      ...claimsOnly(),
      requiredClaims: [...STAFF, { name: "wid", value: "ws-1" }],
    }
    const result = await signIn(config, { extraClaims: { kind: "dev_user", wid: "ws-2" } })
    expect(result).toBeInstanceOf(AdminAuthError)
    expect((result as AdminAuthError).reason).toContain('"wid"')
  })

  test("both gates set and the email fails: rejected even though the claims match", async () => {
    const result = await signIn(
      { ...baseConfig(), requiredClaims: STAFF },
      { email: "outsider@test", extraClaims: { kind: "dev_user" } },
    )
    expect(result).toBeInstanceOf(AdminAuthError)
    // The email message it always had — the claim gate runs second and never widens the list.
    expect((result as AdminAuthError).reason).toContain("is not in ADMIN_OIDC_ADMIN_EMAIL")
  })

  test("both gates set and the claim fails: rejected even though the email is allowlisted", async () => {
    expectPrincipalRejection(
      await signIn({ ...baseConfig(), requiredClaims: STAFF }, { extraClaims: { kind: "user" } }),
    )
  })

  test("email_verified=false still rejects when the claims match", async () => {
    const result = await signIn(claimsOnly(), {
      verified: false,
      extraClaims: { kind: "dev_user" },
    })
    expect(result).toBeInstanceOf(AdminAuthError)
    expect((result as AdminAuthError).reason).toContain("idtoken:")
  })

  test("string claim matches: any verified email is admitted, as itself", async () => {
    const result = await signIn(claimsOnly(), {
      email: "new.staff@test",
      extraClaims: { kind: "dev_user" },
    })
    expect(result).not.toBeInstanceOf(AdminAuthError)
    expect((result as { email: string }).email).toBe("new.staff@test")
  })

  test("array claim containing the value is admitted", async () => {
    const result = await signIn(claimsOnly(), { extraClaims: { kind: ["user", "dev_user"] } })
    expect(result).not.toBeInstanceOf(AdminAuthError)
  })

  test("both gates set and both pass: admitted", async () => {
    const result = await signIn(
      { ...baseConfig(), requiredClaims: STAFF },
      { extraClaims: { kind: "dev_user" } },
    )
    expect(result).not.toBeInstanceOf(AdminAuthError)
  })

  test("email-only config ignores provider claims entirely (regression)", async () => {
    // No `requiredClaims` key at all — the shape every pre-existing caller builds.
    const result = await signIn(baseConfig(), { extraClaims: { kind: "user" } })
    expect(result).not.toBeInstanceOf(AdminAuthError)
  })

  test("a flow with neither gate cannot be built", async () => {
    const { h, fetch } = await buildHarness()
    expect(() => buildFlow(h, fetch, { ...baseConfig(), adminEmails: null })).toThrow(
      "createOIDCFlow needs adminEmails, requiredClaims, or both",
    )
  })
})

for (const delayedBody of [false, true]) {
  test(`discovery deadline reaches the request and response body (body=${delayedBody})`, async () => {
    const { h } = await buildHarness()
    let observedSignal: AbortSignal | null | undefined
    const flow = createOIDCFlow({
      config: baseConfig(),
      requestTimeoutMs: 10,
      stateStore: { states: h.store.oauthStates, cipher: h.cipher, stateMinutes: 10 },
      fetch: async (_url, init) => {
        observedSignal = init?.signal
        if (!observedSignal) throw new Error("deadline missing")
        const signal = observedSignal
        if (delayedBody)
          return new Response(
            new ReadableStream({
              start(controller) {
                signal.addEventListener("abort", () => controller.error(signal.reason), {
                  once: true,
                })
              },
            }),
          )
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      },
    })
    await expect(flow.start()).rejects.toBeDefined()
    expect(observedSignal?.aborted).toBe(true)
    expect(h.store.rows.oauthStates).toHaveLength(0)
  })
}
