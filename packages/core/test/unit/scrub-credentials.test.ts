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

  test("a base64 slash password with `=` padding is scrubbed (#207 review)", () => {
    expect(scrubCredentials("connect failed: postgres://router:Zk3/q+Vb9xQ==@db:5432/app")).toBe(
      "connect failed: postgres://[REDACTED]@db:5432/app",
    )
  })

  test("userinfo needs a real scheme in front, as before the scheme left the match (#207 round 3)", () => {
    for (const [input, secret] of [
      ["x_y://a:password=@SECRET1", "SECRET1"],
      ["1db://pwd=@SECRET2", "SECRET2"],
      ["://token=@SECRET3", "SECRET3"],
    ] as const) {
      expect(scrubCredentials(input)).not.toContain(secret)
    }
  })

  test("padding never swallows a key=value key before an `@` (#207 round 3)", () => {
    for (const [input, secret] of [
      ["jdbc:postgresql://host:5432/db;password=@Hunter2Secret", "Hunter2Secret"],
      ["pg://a:/password=@xSECRET", "xSECRET"],
      ["redis://cache:6379/0,token=@SSECRET", "SSECRET"],
    ] as const) {
      expect(scrubCredentials(input)).not.toContain(secret)
    }
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

describe("scrubCredentials — a credential in a query string", () => {
  /**
   * The same rule the server redactor follows: the query-string rule runs BEFORE the URL-userinfo
   * rule, and the userinfo rule does not cross `?` at all — so a query value is read as a query
   * value and never as a URL password. With the userinfo rule crossing `?` it read
   * `?user=app&password=p@ssw0rd` as the password of `db.internal:5432` — and the secret after
   * the `@` reached the boot log in the clear.
   *
   * Each case asserts the tail marker is GONE, not that a marker appears somewhere: the old
   * output was `postgresql://[REDACTED]@ssw0rd`, which is redacted and still carrying the secret.
   */
  const cases = [
    {
      name: "original no-port colon password",
      input: "postgres://db?password=Ab:cd@ef",
      tail: "ef",
      expected: "postgres://db?password=[REDACTED]",
    },
    {
      name: "original boot-only no-port password",
      input: "postgres://db?password=x@y",
      tail: "y",
      expected: "postgres://db?password=[REDACTED]",
    },
    {
      name: "numeric ambiguous userinfo",
      input: "postgres://user:1234?key=1@host",
      tail: "1234",
      expected: "postgres://[REDACTED]",
    },
    {
      name: "non-credential ambiguous userinfo tail",
      input: "postgres://user:pw?TAIL@host",
      tail: "TAIL",
      expected: "postgres://[REDACTED]",
    },
    {
      name: "a DSN with a port and a query string",
      input: "postgresql://db.internal:5432?user=app&password=p@ssw0rd",
      tail: "ssw0rd",
      expected: "postgresql://[REDACTED]",
    },
    {
      name: "a Redis URL with a query string",
      input: "redis://cache:6379?password=hunter@2secret",
      tail: "2secret",
      expected: "redis://[REDACTED]",
    },
    {
      name: "an error text quoting a callback URL",
      input: "connect https://h:8443?token=tok@en_SECRET_TAIL failed",
      tail: "en_SECRET_TAIL",
      expected: "connect https://[REDACTED] failed",
    },
    {
      // The ambiguous userinfo's tail is a URL of its own, with a password of its own. The guard
      // used to swallow that URL whole — scheme and `://` included — and the userinfo rule then
      // had no anchor to end on, so the nested password reached the boot log in the clear.
      name: "an ambiguous userinfo whose tail is a URL of its own",
      input: 'postgres://u:p?x=@postgres://v:a"SECRET_TAIL@db',
      tail: "SECRET_TAIL",
      expected: "postgres://[REDACTED]postgres://[REDACTED]@db",
    },
  ] as const

  for (const { name, input, tail, expected } of cases) {
    test(`${name} keeps no tail after the @`, () => {
      const scrubbed = scrubCredentials(input)

      expect(scrubbed).not.toContain(tail)
      expect(scrubbed).toBe(expected)
    })
  }

  test("a userinfo password in front of a credential-named query value is gone", () => {
    // The ambiguous shape is scrubbed before the query rule can erase its @ evidence.
    const scrubbed = scrubCredentials("postgres://user:pw?key=1@host")

    expect(scrubbed).not.toContain("pw")
    expect(scrubbed).toBe("postgres://[REDACTED]")
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
      `${"ab-".repeat(2000)}://`.repeat(40),
    ]) {
      const started = performance.now()
      scrubCredentials(text)
      expect(performance.now() - started).toBeLessThan(500)
    }
  })
})
