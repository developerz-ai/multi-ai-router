import { expect, test } from "bun:test"
import { resolve } from "node:path"

test("OpenCode capture redacts tokens, excludes device secrets from private wire, and relays chunks unchanged", async () => {
  const child = Bun.spawn(["python3", "-I", resolve(import.meta.dir, "capture_test.py")], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [error, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
  expect(code, error).toBe(0)
})
