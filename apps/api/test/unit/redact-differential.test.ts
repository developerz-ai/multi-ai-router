import { describe, expect, test } from "bun:test"
import { ROUTER_KEY_PREFIX, scrubCredentials } from "@multi-ai-router/core"
import { redactValue } from "../../src/logging/redact"

/**
 * The differential guard for the query-string fix.
 *
 * Both redactors changed shape: the server one moved its query-string pattern ahead of the
 * URL-userinfo pattern, and the boot one gained a query-anchored rule ahead of its own. A rule
 * change that quietly drops coverage is invisible in a fixture list — a fixture list only says
 * what somebody thought to write down. So the pre-fix pattern sets of BOTH redactors are frozen
 * here, verbatim, as the previous-release reference, and compared against the live ones over a
 * deterministic seeded corpus: the same corpus on every run, on every machine, no clock and no
 * network.
 *
 * What this fails on:
 *   - a planted secret that survives the new implementation;
 *   - a secret the old implementation scrubbed and the new one does not — "new scrubs less" with
 *     a secret in it;
 *   - a shape that was supposed to stay put and did not.
 *
 * The counts of both directions — "new scrubs more" and "new scrubs less" — ride in the assertion
 * message, so a rule change that quietly shifts the balance shows up in the failure output.
 *
 * The shape where the query rule wins the `@` is in the corpus, not beside it: a URL whose only
 * `@` sits inside a query value (`postgres://user:pw?key=1@host`) has no `@` left for the userinfo
 * rule once the query rule has consumed the value, so the authority rule has to read the authority
 * itself as the password. The old implementation covered that password by accident — by eating the
 * query text as one password — and the new one has to cover it on purpose, or the corpus entry
 * fails as "new scrubs less" and the guard never fires.
 */

const REDACTED = "[REDACTED]"

type FrozenPattern = { readonly pattern: RegExp; readonly replacement: string }

/**
 * The server redactor as it behaved before the fix: the URL-userinfo pattern ahead of the
 * query-string pattern, and a query pattern that knew `key`/`token`/`secret`/`password` endings
 * and `code`/`code_verifier`/`state` but not `passwd`/`pwd`. Copied verbatim from
 * `apps/api/src/logging/redact.ts` as it was — the previous release, not a memory of it.
 */
const PRE_FIX_SERVER_PATTERNS: readonly FrozenPattern[] = [
  {
    pattern:
      /\bhttps?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_-]+(?:[/?#][^\s"'<>]*)?/gi,
    replacement: REDACTED,
  },
  { pattern: new RegExp(`${ROUTER_KEY_PREFIX}[A-Za-z0-9_-]+`, "g"), replacement: REDACTED },
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/g, replacement: REDACTED },
  { pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, replacement: REDACTED },
  { pattern: /\beyJ[A-Za-z0-9_-]{5,512}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, replacement: REDACTED },
  {
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{513,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
    replacement: REDACTED,
  },
  {
    pattern: /:\/\/(?:[^\s/:@?#&=\"]*:[^\s@\"?#:&=]{1,256}={0,2}|[^\s/:@]*:[^\s/@]+)@/g,
    replacement: `://${REDACTED}@`,
  },
  {
    pattern:
      /([?&](?:[a-z0-9_-]*(?:key|token|secret|password)|code(?:[-_]?verifier)?|state)=)[^&\s#"']+/gi,
    replacement: `$1${REDACTED}`,
  },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}/g, replacement: REDACTED },
  {
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
    replacement: REDACTED,
  },
  { pattern: /\bxai-[A-Za-z0-9_-]{16,}/g, replacement: REDACTED },
  { pattern: /\bgsk_[A-Za-z0-9]{20,}/g, replacement: REDACTED },
  { pattern: /\bcsk-[A-Za-z0-9-]{16,}/g, replacement: REDACTED },
]

/**
 * The boot scrubber as it behaved before the fix: no query-string rule at all, so a credential in
 * a query string was only ever caught by the unanchored key=value rule — and only when the
 * userinfo rule had not already eaten the text. Copied verbatim from
 * `packages/core/src/scrub-credentials.ts` as it was.
 */
const PRE_FIX_BOOT_PATTERNS: readonly FrozenPattern[] = [
  {
    pattern:
      /(?<=\b[a-z][a-z0-9+.-]*):\/\/(?:[^\s/:@?#&=\"]*:[^\s@\"?#:&=]{1,256}(?:(?<!\b(?:password|passwd|pwd|secret|token|api[-_]?key|encryption[-_]?key))={1,2})?|[^\s/@]+)@/gi,
    replacement: `://${REDACTED}@`,
  },
  {
    pattern:
      /\b((?:password|passwd|pwd|secret|token|api[-_]?key|encryption[-_]?key)\s*=\s*)[^\s&"']+/gi,
    replacement: `$1${REDACTED}`,
  },
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/g, replacement: REDACTED },
  { pattern: /\beyJ[A-Za-z0-9_-]{5,512}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, replacement: REDACTED },
  {
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{513,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
    replacement: REDACTED,
  },
  { pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, replacement: REDACTED },
]

function applyPatterns(patterns: readonly FrozenPattern[]): (text: string) => string {
  return (text) => {
    let scrubbed = text
    for (const { pattern, replacement } of patterns) {
      scrubbed = scrubbed.replace(pattern, replacement)
    }
    return scrubbed
  }
}

/** The previous release, as it behaved: the server redactor before the move. */
const OLD_SERVER = applyPatterns(PRE_FIX_SERVER_PATTERNS)
/** The previous release, as it behaved: the boot scrubber before it gained the query rule. */
const OLD_BOOT = applyPatterns(PRE_FIX_BOOT_PATTERNS)

type CorpusEntry = { readonly text: string; readonly secret?: string }

/** The three reported cases: the secret after the `@` used to reach the log line in the clear. */
const REPORTED_CASES = [
  {
    text: "postgresql://db.internal:5432?user=app&password=p@ssw0rd",
    secret: "ssw0rd",
    expected: "postgresql://db.internal:5432?user=app&password=[REDACTED]",
  },
  {
    text: "redis://cache:6379?password=hunter@2secret",
    secret: "2secret",
    expected: "redis://cache:6379?password=[REDACTED]",
  },
  {
    text: "connect https://h:8443?token=tok@en_SECRET_TAIL failed",
    secret: "en_SECRET_TAIL",
    expected: "connect https://h:8443?token=[REDACTED] failed",
  },
] as const

/**
 * The shapes that must not move. A userinfo password holding an unencoded `/` or base64 `=`
 * padding is still scrubbed whole and still keeps its host; a query string with no credential in
 * it is still left exactly as it was; a URL with a port and an `@` in its path still pays the
 * documented price of losing its host.
 */
const MUST_NOT_CHANGE = [
  { text: "postgres://u:p/ss@h:5432/app", expected: "postgres://[REDACTED]@h:5432/app" },
  {
    text: "postgres://router:Zk3/q+Vb9xQ==@db:5432/app",
    expected: "postgres://[REDACTED]@db:5432/app",
  },
  {
    text: "https://api.example.test/v1/models?limit=20&after=acct-1",
    expected: "https://api.example.test/v1/models?limit=20&after=acct-1",
  },
  { text: "https://host:8080/a@b", expected: "https://[REDACTED]@b" },
] as const

/**
 * A fixed-seed PRNG (mulberry32). The corpus has to be the same corpus on every run: one that
 * reshuffles itself proves nothing twice, and a failure nobody can reproduce is a failure nobody
 * chases.
 */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(list: readonly T[], random: () => number): T {
  const value = list[Math.floor(random() * list.length)]
  if (value === undefined) throw new Error("pick from an empty list")
  return value
}

const SCHEMES = ["postgres", "postgresql", "redis", "https", "http"] as const
const HOSTS = ["db.internal", "cache", "h", "api.example.test", "registry.npmjs.org"] as const
const PATHS = ["", "/app", "/v1", "/cb"] as const
/** The parameter names the two redactors take, and the ones they must leave alone. */
const CREDENTIAL_NAMES = [
  "key",
  "api_key",
  "api-key",
  "access_token",
  "refresh_token",
  "client_secret",
  "password",
  "passwd",
  "pwd",
  "code",
  "code_verifier",
  "state",
  "job_key",
] as const
const BENIGN_NAMES = ["limit", "after", "page", "offset", "sslmode", "user", "format"] as const
const PROSE = [
  "connect {url} failed",
  "see {url} for details",
  "{url}",
  "upstream rejected {url}",
] as const

/**
 * The generated corpus: a credential carried in a query string (the reported defect class), a
 * connection string whose password is a credential, the ambiguous shape — a userinfo password in
 * front of a credential-named query value — and a query string with nothing secret in it. Every
 * entry carries at most one planted secret, so each comparison is about a named secret rather
 * than about how much text happened to change.
 */
function buildCorpus(): CorpusEntry[] {
  const random = seeded(0x5eed)
  const entries: CorpusEntry[] = []
  for (let index = 0; index < 240; index += 1) {
    const scheme = pick(SCHEMES, random)
    const host = pick(HOSTS, random)
    const port = random() < 0.5 ? `:${8000 + Math.floor(random() * 900)}` : ""
    const path = pick(PATHS, random)
    const secret = `PLANTED_QUERY_${index}_SECRET`
    const credential = pick(CREDENTIAL_NAMES, random)
    const benign = pick(BENIGN_NAMES, random)
    const query =
      random() < 0.5
        ? `?${credential}=${secret}&${benign}=${index}`
        : `?${benign}=${index}&${credential}=${secret}`
    const url = `${scheme}://${host}${port}${path}${query}`
    entries.push({ text: pick(PROSE, random).replace("{url}", url), secret })
  }
  for (let index = 0; index < 80; index += 1) {
    const scheme = pick(SCHEMES, random)
    const host = pick(HOSTS, random)
    const secret = `PLANTED_USERINFO_${index}_SECRET`
    entries.push({ text: `${scheme}://router:${secret}@${host}:5432/app`, secret })
  }
  // The ambiguous shape: a userinfo password in front of a credential-named query value that
  // holds the `@`. The query rule wins that `@`, so the userinfo rule has nothing left to end on
  // and the authority rule is the only thing that can still scrub the password.
  for (let index = 0; index < 60; index += 1) {
    const scheme = pick(SCHEMES, random)
    const host = pick(HOSTS, random)
    const credential = pick(CREDENTIAL_NAMES, random)
    const secret = `PLANTED_AUTHORITY_${index}_SECRET`
    entries.push({ text: `${scheme}://router:${secret}?${credential}=q@${host}`, secret })
  }
  for (let index = 0; index < 60; index += 1) {
    const scheme = pick(SCHEMES, random)
    const host = pick(HOSTS, random)
    const first = pick(BENIGN_NAMES, random)
    const second = pick(BENIGN_NAMES, random)
    entries.push({ text: `${scheme}://${host}/v1?${first}=${index}&${second}=acct-${index}` })
  }
  return entries
}

type Comparison = {
  readonly failures: string[]
  readonly more: number
  readonly less: number
  readonly changed: number
}

/**
 * Old against new over the corpus. The direction is decided by the planted secret when there is
 * one — "new scrubs more" is the old implementation leaking a secret the new one does not — and
 * by the number of redaction marks when there is none, so a benign entry that moved is counted
 * rather than silently ignored.
 */
function compare(
  label: string,
  oldScrub: (text: string) => string,
  newScrub: (text: string) => string,
  entries: readonly CorpusEntry[],
): Comparison {
  const failures: string[] = []
  let more = 0
  let less = 0
  let changed = 0
  for (const entry of entries) {
    const before = oldScrub(entry.text)
    const after = newScrub(entry.text)
    if (before === after) continue
    changed += 1
    const secret = entry.secret
    if (secret === undefined) {
      const beforeMarks = before.split(REDACTED).length
      const afterMarks = after.split(REDACTED).length
      if (afterMarks > beforeMarks) more += 1
      else if (afterMarks < beforeMarks) less += 1
      continue
    }
    const beforeHas = before.includes(secret)
    const afterHas = after.includes(secret)
    if (afterHas && !beforeHas) {
      less += 1
      failures.push(
        `${label}: new scrubs less — "${secret}" survives in "${after}" (the old output was "${before}")`,
      )
      continue
    }
    if (afterHas) {
      failures.push(
        `${label}: planted secret "${secret}" survives in "${after}" (the old output was "${before}")`,
      )
      continue
    }
    if (beforeHas) {
      more += 1
      continue
    }
    // Neither carries the secret: the two outputs differ somewhere else in the text. Not a
    // direction, and not a failure.
  }
  return { failures, more, less, changed }
}

describe("redact — differential against the previous release", () => {
  test("the three reported cases go from leaking to scrubbed, in both redactors", () => {
    for (const reported of REPORTED_CASES) {
      for (const [label, oldScrub, newScrub] of [
        ["server", OLD_SERVER, redactValue],
        ["boot", OLD_BOOT, scrubCredentials],
      ] as const) {
        const before = oldScrub(reported.text)
        const after = newScrub(reported.text)
        expect(before, `${label}: leaked ${reported.secret}`).toContain(reported.secret)
        expect(after, `${label}: leaked ${reported.secret}`).not.toContain(reported.secret)
        expect(after).toBe(reported.expected)
      }
    }
  })

  test("the corpus: no planted secret survives, and nothing the old scrubbed comes back", () => {
    const corpus = buildCorpus()
    const server = compare("server", OLD_SERVER, redactValue, corpus)
    const boot = compare("boot", OLD_BOOT, scrubCredentials, corpus)
    const summary = [
      `server: new scrubs more ${server.more}, new scrubs less ${server.less}, changed ${server.changed}`,
      `boot: new scrubs more ${boot.more}, new scrubs less ${boot.less}, changed ${boot.changed}`,
      `corpus entries ${corpus.length}`,
    ].join(" | ")

    expect([...server.failures, ...boot.failures], summary).toEqual([])
    // The corpus has to reach the new behaviour, or "no failures" would say nothing at all.
    expect(server.more, "the corpus never reached the server's new behaviour").toBeGreaterThan(0)
    expect(boot.more, "the corpus never reached the boot scrubber's behaviour").toBeGreaterThan(0)
  })

  test("the shapes that must not change did not change", () => {
    for (const shape of MUST_NOT_CHANGE) {
      for (const [label, oldScrub, newScrub] of [
        ["server", OLD_SERVER, redactValue],
        ["boot", OLD_BOOT, scrubCredentials],
      ] as const) {
        const text = shape.text
        expect(newScrub(text), `${label}: ${text} must not change`).toBe(shape.expected)
        expect(oldScrub(text), `${label}: ${text} must not change`).toBe(shape.expected)
      }
    }
  })
})

describe("redact — the corpus rules stay linear", () => {
  test("64 KB adversarial runs finish inside the same 500 ms bound", () => {
    // The same bound the existing timing blocks carry, over the shapes the query rule adds: a long
    // value under a credential name, many of them, and a run of separators with nothing behind
    // them. The pattern count and shape stayed linear, so a scan must not go quadratic on any of
    // these.
    for (const text of [
      "a://b:".repeat(10 * 1024),
      "://u:p/".repeat(10 * 1024),
      `?api_key=${"x".repeat(64 * 1024)}`,
      `?key=${"y".repeat(1024)}`.repeat(64),
      `https://h:8443?token=${"z".repeat(64 * 1024)}`,
      "&".repeat(64 * 1024),
    ]) {
      const started = performance.now()
      redactValue(text)
      scrubCredentials(text)
      expect(performance.now() - started).toBeLessThan(500)
    }
  })
})
