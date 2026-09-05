import {
  createSdkTranscripts,
  type SdkTranscripts,
  type TranscriptDirent,
  type TranscriptFs,
  type TranscriptStat,
} from "../../src/providers/claude-sdk/transcripts"

/**
 * A config-directory volume in memory, for the transcript sweep.
 *
 * The layout is real — `<root>/<accountId>/projects/<slug>/<session>.jsonl` and `<session>/` —
 * and every other file a `CLAUDE_CONFIG_DIR` holds can be placed beside them (`.credentials.json`,
 * `settings.json`, `memory/`), which is the point: the test that matters is the one proving those
 * are never candidates. Symlinks are placed as `link` entries so a survey can be shown to skip
 * them and a removal to refuse them.
 */

type Kind = "file" | "dir" | "link"

interface Placed {
  readonly kind: Kind
  readonly changedAtMs: number
  readonly bytes: number
}

export interface MemoryTranscripts {
  readonly transcripts: SdkTranscripts
  /** Every path on the fake volume, in insertion order. */
  paths(): string[]
  /** Every removal, in order, as `"<verb> <path>"`. */
  readonly removals: string[]
  place(path: string, entry: Partial<Placed> & { readonly kind: Kind }): void
  has(path: string): boolean
}

export function createMemoryTranscripts(root = "/data/claude"): MemoryTranscripts {
  const volume = new Map<string, Placed>()
  const removals: string[] = []

  const childrenOf = (path: string): TranscriptDirent[] => {
    const prefix = `${path}/`
    const out: TranscriptDirent[] = []
    for (const [candidate, placed] of volume) {
      if (!candidate.startsWith(prefix)) continue
      const rest = candidate.slice(prefix.length)
      if (rest.includes("/")) continue
      out.push({ name: rest, kind: placed.kind === "link" ? "other" : placed.kind })
    }
    return out
  }

  const fs: TranscriptFs = {
    list: async (path) => (volume.has(path) || path === root ? childrenOf(path) : []),
    stat: async (path): Promise<TranscriptStat | null> => {
      const placed = volume.get(path)
      if (placed === undefined || placed.kind === "link") return null
      return { kind: placed.kind, changedAtMs: placed.changedAtMs, bytes: placed.bytes }
    },
    removeFile: async (path) => {
      removals.push(`unlink ${path}`)
      volume.delete(path)
    },
    removeDir: async (path) => {
      removals.push(`rm -r ${path}`)
      for (const candidate of [...volume.keys()]) {
        if (candidate === path || candidate.startsWith(`${path}/`)) volume.delete(candidate)
      }
    },
  }

  return {
    transcripts: createSdkTranscripts({ root, fs }),
    removals,
    paths: () => [...volume.keys()],
    has: (path) => volume.has(path),
    place: (path, entry) => {
      // Every ancestor exists as a directory, the way a real volume would have it.
      const parts = path.slice(root.length + 1).split("/")
      for (let depth = 1; depth < parts.length; depth++) {
        const ancestor = `${root}/${parts.slice(0, depth).join("/")}`
        if (!volume.has(ancestor)) volume.set(ancestor, { kind: "dir", changedAtMs: 0, bytes: 0 })
      }
      volume.set(path, { changedAtMs: 0, bytes: 0, ...entry })
    },
  }
}
