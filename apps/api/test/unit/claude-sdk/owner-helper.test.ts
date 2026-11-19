import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ownerHelperBootProblem,
  ownerHelperUsable,
} from "../../../src/providers/claude-sdk/owner-helper"

/**
 * The boot rule for the credential-owner helper (#447): a deployment holding Accounts that need
 * it refuses to start when it is not an executable file, and names the path. `boot.ts` supplies
 * the filesystem answer and the account count; `main.ts` exits on a problem.
 */

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "router-owner-helper-"))
  roots.push(root)
  return root
}

describe("ownerHelperUsable", () => {
  test("a missing path, a directory and a non-executable file are all unusable", async () => {
    const root = await directory()
    const plain = join(root, "plain")
    await writeFile(plain, "#!/bin/sh\n", { mode: 0o644 })

    expect(ownerHelperUsable(join(root, "absent"))).toBe(false)
    expect(ownerHelperUsable(root)).toBe(false)
    expect(ownerHelperUsable(plain)).toBe(false)
  })

  test("an executable file is usable", async () => {
    const root = await directory()
    const helper = join(root, "helper")
    await writeFile(helper, "#!/bin/sh\n")
    await chmod(helper, 0o755)

    expect(ownerHelperUsable(helper)).toBe(true)
  })
})

describe("ownerHelperBootProblem", () => {
  const helperPath = "/opt/router/libexec/owner"

  test("an unusable helper with Accounts that need it refuses boot, naming the path", () => {
    const problem = ownerHelperBootProblem({ helperPath, usable: false, accountsNeedingHelper: 2 })

    expect(problem).toContain("CLAUDE_OWNERSHIP_HELPER_PATH")
    expect(problem).toContain(helperPath)
    expect(problem).toContain("2 Claude subscription account(s)")
  })

  test("no Account needs it: a deployment of API-key accounts boots without the helper", () => {
    expect(
      ownerHelperBootProblem({ helperPath, usable: false, accountsNeedingHelper: 0 }),
    ).toBeNull()
  })

  test("a usable helper boots", () => {
    expect(
      ownerHelperBootProblem({ helperPath, usable: true, accountsNeedingHelper: 5 }),
    ).toBeNull()
  })
})
