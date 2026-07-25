import { createCliProbe } from "./cli-probe"
import { resolveClaudeCli } from "./resolve-cli"

/**
 * Prints the path of the `claude` binary the Agent SDK would spawn, or exits non-zero listing every
 * rung it tried and why each was refused.
 *
 * One caller: the image build, which stages that binary onto `PATH` as `claude` so the CLI an
 * operator runs and the CLI the SDK spawns are the same file (docs/idea/11-anthropic-agent-sdk.md
 * §9). It reuses the router's own ladder rather than re-deriving the node_modules layout in shell —
 * a Dockerfile that guessed the layout would drift from the resolver silently, which is the exact
 * failure this module exists to prevent. A miss fails the build instead of the first request.
 *
 * Run as *source*, from the builder stage, never bundled: module resolution is anchored to this
 * file, and only from inside `apps/api/` does the SDK's install tree resolve at all.
 */

const resolution = resolveClaudeCli(
  createCliProbe({ override: process.env.CLAUDE_CLI_PATH ?? null }),
)

if (resolution.ok) {
  process.stdout.write(`${resolution.path}\n`)
} else {
  const tried = resolution.attempts
    .map((a) => `  ${a.source}: ${a.rejection}${a.path === null ? "" : ` (${a.path})`}`)
    .join("\n")
  process.stderr.write(`no claude binary resolved; tried:\n${tried}\n`)
  process.exit(1)
}
