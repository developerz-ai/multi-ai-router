import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFastCredential } from "../../../src/providers/claude-fast/credential"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
test("credentials require both files inside the selected account and normalize seconds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "router-fast-"))
  directories.push(dir)
  await writeFile(
    join(dir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "private-selected",
        expiresAt: 2000000000,
        refreshToken: "never-used",
      },
    }),
    { mode: 0o600 },
  )
  expect(await readFastCredential(dir)).toBeNull()
  await writeFile(
    join(dir, ".claude.json"),
    JSON.stringify({
      userID: "b".repeat(64),
      oauthAccount: { accountUuid: "22222222-2222-4222-8222-222222222222" },
    }),
    { mode: 0o600 },
  )
  expect(await readFastCredential(dir)).toEqual({
    accessToken: "private-selected",
    expiresAt: 2000000000000,
    deviceId: "b".repeat(64),
    accountUuid: "22222222-2222-4222-8222-222222222222",
  })
  await writeFile(join(dir, ".credentials.json"), "{private malformed")
  expect(await readFastCredential(dir)).toBeNull()
})
