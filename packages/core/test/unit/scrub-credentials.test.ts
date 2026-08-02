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
})
