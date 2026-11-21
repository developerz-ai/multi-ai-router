import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Duplex } from "node:stream"
import { ownerMonotonicMilliseconds } from "../../../src/providers/claude-sdk/owner-clock"

export async function nativeGuardian(mode = "run-fenced", ttl = 600, previous?: string) {
  const root = await mkdtemp(join(tmpdir(), "guardian-fence-"))
  const id = crypto.randomUUID()
  const marker = crypto.randomUUID()
  const owner = crypto.randomUUID()
  const state = join(root, ".ownership", id)
  await mkdir(join(root, id), { mode: 0o700 })
  if (previous) {
    await mkdir(state, { recursive: true, mode: 0o700 })
    await writeFile(join(state, "generation"), `${owner} ${previous}\n`, { mode: 0o600 })
  }
  const deadline = ownerMonotonicMilliseconds() + BigInt(ttl)
  const child = spawn(
    resolve("native/config-owner"),
    [
      mode,
      root,
      id,
      marker,
      "4",
      "30",
      "5",
      "16",
      "3000",
      owner,
      "2",
      String(deadline),
      "/bin/sh",
      "-c",
      "sleep 30 & echo $!; wait",
    ],
    { stdio: ["ignore", "pipe", "ignore", "pipe", "pipe"] },
  )
  const status = child.stdio[3]
  const control = child.stdio[4]
  if (!(status instanceof Duplex) || !(control instanceof Duplex))
    throw new Error("missing guardian pipes")
  control.on("error", () => {})
  let output = ""
  let protocol = ""
  child.stdout?.on("data", (data) => {
    output += data.toString()
  })
  status.on("data", (data) => {
    protocol += data.toString()
  })
  const exited = new Promise<number | null>((done, fail) => {
    child.once("exit", done)
    child.once("error", fail)
  })
  async function waitFor(read: () => boolean) {
    const end = performance.now() + 2500
    while (!read()) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`guardian exited: ${protocol}`)
      if (performance.now() >= end) throw new Error(`guardian wait timed out: ${protocol}`)
      await new Promise((done) => setTimeout(done, 5))
    }
  }
  return {
    owner,
    deadline,
    control,
    exited,
    state,
    marker,
    markers: () => readdir(join(state, "owners")),
    registered: () => waitFor(() => protocol.includes("R")),
    async prepare() {
      control.write("P")
      await waitFor(() => protocol.includes("A"))
    },
    async activate() {
      control.write("S")
      await waitFor(() => protocol.includes("B"))
    },
    async descendant() {
      await waitFor(() => /\d+\n/.test(output))
      return Number(output.trim())
    },
    async dispose() {
      control.destroy()
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGUSR2")
      await exited
      status.destroy()
      await rm(root, { recursive: true, force: true })
    },
  }
}
