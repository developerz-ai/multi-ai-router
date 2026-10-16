import { readFile } from "node:fs/promises"
import { z } from "../../../apps/api/node_modules/zod"
import { inspectIntegrity } from "../../../apps/api/src/providers/claude-fast/integrity"

export {
  inspectIntegrity,
  versionSuffix,
} from "../../../apps/api/src/providers/claude-fast/integrity"

export async function verifyBodies(path: string): Promise<void> {
  let checked = 0
  let mismatched = 0
  for (const line of (await readFile(path, "utf8")).split("\n").filter(Boolean)) {
    let result: ReturnType<typeof inspectIntegrity>
    try {
      const input = z.object({ body_base64: z.string() }).parse(JSON.parse(line))
      result = inspectIntegrity(Buffer.from(input.body_base64, "base64").toString("utf8"))
    } catch {
      // Never print parser errors containing raw private artifact text.
      throw new Error(
        `cannot verify body ${checked + 1}: malformed body or uncalibrated CLI version`,
      )
    }
    checked++
    if (!result.matches) mismatched++
    process.stdout.write(`${JSON.stringify({ index: checked - 1, ...result })}\n`)
  }
  if (checked === 0) throw new Error("no captured bodies to verify")
  if (mismatched > 0) throw new Error(`${mismatched}/${checked} body checksums did not match`)
}
