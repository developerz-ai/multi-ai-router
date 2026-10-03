import { spawn } from "node:child_process"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

if (process.platform !== "linux") throw new Error("config ownership supervisor requires Linux")
const directory = fileURLToPath(new URL(".", import.meta.url))
const child = spawn(
  process.env.CC ?? "cc",
  [
    "-static",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-fstack-protector-strong",
    join(directory, "config-owner.c"),
    "-o",
    join(directory, "config-owner"),
  ],
  { stdio: "inherit" },
)
const result = await new Promise<number>((resolve, reject) => {
  child.once("error", reject)
  child.once("exit", (code) => resolve(code ?? 1))
})
process.exitCode = result
