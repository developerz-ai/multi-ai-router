/**
 * Rewrites the committed per-file test timings from the scratch files a sharded run measured.
 *
 *   bun bin/lib/merge-test-timings.ts <target.json> <shard.timings.json>…
 *
 * Only files a shard actually ran are kept, so a deleted test file leaves the table the next time
 * it is refreshed. Keys are sorted to keep the diff of a refresh readable.
 */

interface Timings {
  readonly version: 1
  readonly files: Record<string, number>
}

function parse(text: string, path: string): Timings {
  const value: unknown = JSON.parse(text)
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { version?: unknown }).version !== 1 ||
    typeof (value as { files?: unknown }).files !== "object" ||
    (value as { files?: unknown }).files === null
  ) {
    throw new Error(`${path} is not a bun test timings file`)
  }
  return value as Timings
}

const [target, ...sources] = process.argv.slice(2)
if (target === undefined || sources.length === 0) {
  process.stderr.write("usage: merge-test-timings.ts <target.json> <shard.timings.json>…\n")
  process.exit(64)
}

const merged = new Map<string, number>()
for (const source of sources) {
  const timings = parse(await Bun.file(source).text(), source)
  for (const [file, milliseconds] of Object.entries(timings.files)) merged.set(file, milliseconds)
}
if (merged.size === 0) throw new Error("no shard measured a file; the timings were left alone")

const files = Object.fromEntries([...merged].sort(([a], [b]) => a.localeCompare(b)))
await Bun.write(target, `${JSON.stringify({ version: 1, files }, null, 2)}\n`)
process.stdout.write(`${target}: ${merged.size} files\n`)
