import { createAdminCredentialRepository, createDatabase, runMigrations } from "@multi-ai-router/db"
import {
  createLocalAdminCredentials,
  LOCAL_PASSWORD_MAX_LENGTH,
  LOCAL_PASSWORD_MIN_LENGTH,
  type LocalAdminCredentials,
  LocalPasswordPolicyError,
} from "../services/admin-auth"

/**
 * `bin/admin` — the local admin password's only write path.
 *
 *   bun apps/api/src/bin/admin.ts set-password     (two hidden prompts; or two lines on stdin)
 *   bun apps/api/src/bin/admin.ts delete-password  (removes the hash row — the door closes)
 *
 * The credential is typed, never passed as an argument: a password on argv
 * lands in the process list and the shell history. When stdin is a TTY it is
 * prompted for twice with echo off; when stdin is piped it is read as exactly
 * two lines (password, repeat), which is how the live test and other tooling
 * drive it non-interactively.
 *
 * The plaintext never persists anywhere: it is hashed with argon2id and only
 * the hash reaches Postgres. Nothing in this script logs the password, its
 * length, or the hash.
 */

const USAGE = `usage:
  bin/admin set-password      set or replace the local admin password (typed twice, hidden)
  bin/admin delete-password   remove it — password sign-in is off again

With no ADMIN_OIDC_* variables set, the local password is the router's only
admin sign-in; removing it makes boot refuse until one method is configured.
See docs/idea/13-admin-oidc.md.`

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? ""
  if (url === "") {
    fail(
      "DATABASE_URL is not set — point it at the router's Postgres.\n" +
        "  bin/setup writes the dev one into .env; this script reads .env from the repo root.",
    )
  }
  return url
}

/**
 * One hidden line. Raw mode is required: without it there is no way to stop
 * the terminal from echoing, and a visible password is worse than a refusal —
 * so the fallback is "pipe two lines instead", never an echoed prompt.
 */
async function readHiddenLines(prompts: readonly [string, string]): Promise<[string, string]> {
  const stdin = process.stdin
  if (typeof stdin.setRawMode !== "function") {
    fail(
      "cannot prompt without echo on this terminal — pipe the password twice instead:\n" +
        "  printf 'password\\npassword\\n' | bin/admin set-password",
    )
  }

  // Bun.stdin (a Blob) for the byte stream; process.stdin for raw mode — the
  // two are the same fd, and only the Blob half is typed for `.stream()`.
  const reader = Bun.stdin.stream().getReader()
  const decoder = new TextDecoder()
  stdin.setRawMode(true)
  try {
    const lines: string[] = []
    for (const prompt of prompts) {
      process.stderr.write(prompt)
      let line = ""
      let done = false
      while (!done) {
        const chunk = await reader.read()
        if (chunk.done) fail("stdin closed before the password was entered", 2)
        for (const char of decoder.decode(chunk.value, { stream: true })) {
          if (char === "\r" || char === "\n") {
            done = true
            break
          }
          if (char === "\u0003") fail("aborted — nothing was written", 2)
          if (char === "\u007f" || char === "\b") {
            line = line.slice(0, -1)
          } else {
            line += char
          }
        }
      }
      process.stderr.write("\n")
      lines.push(line)
    }
    return [lines[0] ?? "", lines[1] ?? ""]
  } finally {
    stdin.setRawMode(false)
    reader.releaseLock()
  }
}

/** Piped input: exactly two non-empty lines — password, repeat. */
async function readPipedLines(): Promise<[string, string]> {
  const text = await Bun.stdin.text()
  const lines = text.split(/\r?\n/u)
  const first = lines[0] ?? ""
  const second = lines[1] ?? ""
  if (first === "" || second === "") {
    fail("expected two lines on stdin — the password, then the same password again", 2)
  }
  return [first, second]
}

async function setPassword(credentials: LocalAdminCredentials): Promise<void> {
  const [first, second] = process.stdin.isTTY
    ? await readHiddenLines(["New admin password: ", "Repeat admin password: "])
    : await readPipedLines()

  if (first !== second) {
    fail("passwords did not match — nothing was written", 2)
  }

  try {
    await credentials.set(first)
  } catch (error) {
    if (error instanceof LocalPasswordPolicyError) {
      fail(
        `password rejected: ${error.message} ` +
          `(${LOCAL_PASSWORD_MIN_LENGTH}–${LOCAL_PASSWORD_MAX_LENGTH} characters)`,
        2,
      )
    }
    throw error
  }

  process.stdout.write(
    "local admin password set — the argon2id hash is in Postgres; the password itself is nowhere.\n" +
      "  The login page now offers password sign-in, alongside SSO if OIDC is configured.\n" +
      "  Close the door again with: bin/admin delete-password\n" +
      "  Boot refuses while this credential exists and PUBLIC_URL is not loopback, unless\n" +
      "  ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC=true — see docs/idea/13-admin-oidc.md.\n",
  )
}

async function deletePassword(credentials: LocalAdminCredentials): Promise<void> {
  const removed = await credentials.remove()
  if (!removed) {
    process.stdout.write("no local admin password was set — nothing to remove.\n")
    return
  }
  process.stdout.write(
    "local admin password removed — password sign-in is off.\n" +
      "  If no ADMIN_OIDC_* variables are set either, boot now refuses until one\n" +
      "  sign-in method is configured — see docs/idea/13-admin-oidc.md.\n",
  )
}

const verb = process.argv[2]
if (verb !== "set-password" && verb !== "delete-password") {
  process.stderr.write(`${USAGE}\n`)
  process.exit(2)
}

// Migrations first, exactly like boot: the table the verb writes to is one of
// them, and both are idempotent, so a fresh database and a pending one converge.
const url = databaseUrl()
await runMigrations({ url, connectTimeoutSeconds: 10 })
const handle = createDatabase({ url, maxConnections: 1 })

try {
  const credentials = createLocalAdminCredentials({
    repository: createAdminCredentialRepository(handle.db),
  })
  if (verb === "set-password") await setPassword(credentials)
  else await deletePassword(credentials)
} finally {
  await handle.close()
}
