import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCarrier } from "../../../src/providers/claude-sdk/session-carry"

/**
 * The real filesystem half of `session-carry.ts`: the guarantees the in-memory tests can only
 * assume — a link is refused by the kernel, the write is atomic, and the file lands private.
 */

const FROM = "11111111-1111-4111-8111-111111111111"
const TO = "22222222-2222-4222-8222-222222222222"
const SESSION = "33333333-3333-4333-8333-333333333333"
const input = { fromAccountId: FROM, toAccountId: TO, sdkSessionId: SESSION }

let root = ""

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "carry-"))
  await mkdir(join(root, FROM, "projects", `-x-${FROM}`), { recursive: true, mode: 0o700 })
  await mkdir(join(root, TO), { mode: 0o700 })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const source = () => join(root, FROM, "projects", `-x-${FROM}`, `${SESSION}.jsonl`)
const target = () => join(root, TO, "projects", `-x-${TO}`, `${SESSION}.jsonl`)

describe("carrying a transcript on a real disk", () => {
  test("writes a private file, replaces an older copy whole, and leaves no temporary behind", async () => {
    await writeFile(source(), `{"cwd":"${join(root, FROM)}"}\n`)
    const carrier = createSessionCarrier({ root, maxBytes: 1_000_000 })

    expect(await carrier.carry(input)).toMatchObject({ carried: true })
    await writeFile(source(), `{"cwd":"${join(root, FROM)}","turn":2}\n`)
    expect(await carrier.carry(input)).toMatchObject({ carried: true })

    expect(await readFile(target(), "utf8")).toBe(`{"cwd":"${join(root, TO)}","turn":2}\n`)
    expect((await lstat(target())).mode & 0o777).toBe(0o600)
    expect((await lstat(join(root, TO, "projects"))).mode & 0o777).toBe(0o700)
    expect(await readdir(join(root, TO, "projects", `-x-${TO}`))).toEqual([`${SESSION}.jsonl`])
  })

  test("a target projects directory that is a link is refused, and nothing lands behind it", async () => {
    await writeFile(source(), "{}\n")
    const elsewhere = join(root, "elsewhere")
    await mkdir(elsewhere)
    await symlink(elsewhere, join(root, TO, "projects"))
    const carrier = createSessionCarrier({ root, maxBytes: 1_000_000 })

    expect(await carrier.carry(input)).toMatchObject({ carried: false, reason: "io-error" })
    expect(await readdir(elsewhere)).toEqual([])
  })

  test("a source transcript that is a link is never read through", async () => {
    const secret = join(root, "secret.json")
    await writeFile(secret, "SECRET")
    await symlink(secret, source())
    const carrier = createSessionCarrier({ root, maxBytes: 1_000_000 })

    expect(await carrier.carry(input)).toEqual({ carried: false, reason: "not-found" })
    expect(await readdir(join(root, TO))).toEqual([])
  })
})
