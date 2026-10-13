import { describe, expect, test } from "bun:test"
import { scrubCredentials } from "../../src"

/**
 * The boot-path backstop. The failure it exists for: a connect error at migration time echoes
 * `DATABASE_URL` — userinfo included — into a stderr line written before the server's redactor
 * exists. The failure case leads: the credential must go, the host must stay.
 */

describe("scrubCredentials", () => {
  test("connection-string userinfo is scrubbed; scheme and host survive", () => {
    const scrubbed = scrubCredentials(
      "connect failed: postgres://router:s3cret-pw@db.internal:5432/router",
    )

    expect(scrubbed).toBe("connect failed: postgres://[REDACTED]@db.internal:5432/router")
    expect(scrubbed).not.toContain("s3cret-pw")
    expect(scrubbed).not.toContain("router:")
  })

  test("username-only userinfo is scrubbed too — cheap, and never wrong", () => {
    expect(scrubCredentials("postgresql://admin@db:5432/x")).toBe(
      "postgresql://[REDACTED]@db:5432/x",
    )
  })

  test("DSN key=value passwords and env echoes are scrubbed", () => {
    expect(scrubCredentials("host=db password=hunter2 dbname=router")).toBe(
      "host=db password=[REDACTED] dbname=router",
    )
    expect(scrubCredentials("ENCRYPTION_KEY=abc123def456==")).toBe("ENCRYPTION_KEY=[REDACTED]")
  })

  test("self-identifying key material is scrubbed under any wording", () => {
    expect(scrubCredentials("rejected sk-ant-api03-abcdef12345")).toBe("rejected [REDACTED]")
    expect(scrubCredentials("header was Bearer abcdefgh1234567890")).toBe("header was [REDACTED]")
    expect(scrubCredentials("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig")).toBe("jwt [REDACTED]")
  })

  test("innocent text passes through untouched", () => {
    const line = 'migration failed: relation "accounts" already exists (migrations/0007.sql)'
    expect(scrubCredentials(line)).toBe(line)
  })

  test("a password holding an unencoded slash is scrubbed whole (#206)", () => {
    expect(scrubCredentials("connect failed: postgres://u:p/ss@db:5432/x")).toBe(
      "connect failed: postgres://[REDACTED]@db:5432/x",
    )
  })

  test("a query-string secret holding an `@` behind a host:port stays scrubbed (#207 review)", () => {
    for (const [input, secret] of [
      ["postgresql://db.internal:5432/app?user=app&password=p@ssw0rd", "ssw0rd"],
      ["redis://cache:6379/0?password=hunter@2secret", "2secret"],
      ["connect https://h:8443/cb?token=tok@en_SECRET_TAIL failed", "SECRET_TAIL"],
      ["postgres://db?sslmode=require&password=Ab:c/d@ef9", "ef9"],
      ["GET https://host:8080/v1&api_key=ab@cdSECRET", "cdSECRET"],
    ] as const) {
      expect(scrubCredentials(input)).not.toContain(secret)
    }
  })

  test("a JWT whose header is over 512 characters is still scrubbed whole", () => {
    const segment = (bytes: number) => Buffer.from("k".repeat(bytes)).toString("base64url")
    const jwt = `eyJ${segment(420)}.${segment(200)}.${segment(256)}`
    expect(jwt.indexOf(".")).toBeGreaterThan(512)
    expect(scrubCredentials(`proof ${jwt} end`)).toBe("proof [REDACTED] end")
  })
})

describe("scrubCredentials cost (#206)", () => {
  test("long scheme-like and JWT-like runs are scanned in linear time", () => {
    // The scheme quantifier and the unbounded JWT header made these quadratic: 16 KB of `a-` took
    // about 4 s. The bound is loose, the regression is not.
    for (const text of [
      "a-".repeat(32 * 1024),
      "eyJaaaaa-".repeat(8 * 1024),
      "eyJ-".repeat(16 * 1024),
      "a://b:".repeat(10 * 1024),
      "://u:p/".repeat(10 * 1024),
      "://".repeat(64 * 1024),
      "://:".repeat(48 * 1024),
    ]) {
      const started = performance.now()
      scrubCredentials(text)
      expect(performance.now() - started).toBeLessThan(500)
    }
  })
})
