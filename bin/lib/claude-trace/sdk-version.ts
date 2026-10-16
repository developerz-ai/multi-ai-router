import { z } from "../../../apps/api/node_modules/zod"

const metadata = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/) })

export async function sdkVersion(update: boolean): Promise<void> {
  const installed = metadata.parse(
    await Bun.file("apps/api/node_modules/@anthropic-ai/claude-agent-sdk/package.json").json(),
  ).version
  const response = await fetch("https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest")
  if (!response.ok) throw new Error(`SDK registry returned ${response.status}`)
  const latest = metadata.parse(await response.json()).version
  process.stdout.write(`${JSON.stringify({ installed, latest })}\n`)
  if (!update || installed === latest) return
  const command = Bun.spawn(
    ["bun", "add", "--cwd", "apps/api", `@anthropic-ai/claude-agent-sdk@^${latest}`],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  )
  if ((await command.exited) !== 0) throw new Error("SDK update failed")
  process.stderr.write(
    "SDK manifest and lockfile updated. Rerun bin/claude-trace scenarios and bin/check.\n",
  )
}
