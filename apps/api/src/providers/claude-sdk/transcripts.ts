import { lstat, readdir, rm, unlink } from "node:fs/promises"
import { join, resolve } from "node:path"

/**
 * The session transcripts the `claude` CLI leaves under every Account's `CLAUDE_CONFIG_DIR`, and
 * the one bounded way this router is allowed to remove them.
 *
 * **What the CLI writes per session, and where.** Every `query()` runs the subprocess with the
 * Account's config directory as its cwd (`options.ts`), and the CLI names its projects directory
 * after that (`claude auth status --json` reports it as `projectsDirectory`, 2.1.261). So one
 * SDK session leaves, under `<CLAUDE_CONFIG_DIR>/projects/<cwd-slug>/`:
 *
 * - `<session-uuid>.jsonl` — the transcript itself, appended to on every turn, and the file
 *   `--resume` reads back;
 * - `<session-uuid>/` — tool results and subagent transcripts for that session (`tool-results/`,
 *   `subagents/`), present only when the session produced any.
 *
 * Nothing removes them. Production measured a quarter of a gigabyte per Account, essentially all
 * of it older than any `sessions` row that could still resume it (docs/idea/11-anthropic-agent-sdk.md
 * §3, "They grow (transcripts)").
 *
 * **This is a sweep over live credential material, so it is closed by construction.** The same
 * directories hold `.credentials.json`, `.claude.json`, `settings.json`, `policy-limits.json`,
 * and whatever the CLI adds next release. Three rules keep the sweep from ever reaching one:
 *
 * 1. **Only names that are session artifacts.** A file is a candidate only as `<uuid>.jsonl`, a
 *    directory only as `<uuid>`, and only directly under `projects/<slug>/`. `memory/` beside them
 *    (the CLI's auto-memory), anything at the config-dir root, and anything this build cannot
 *    positively attribute to one session is not a candidate — it is not counted as foreign
 *    either, because it is simply never looked at.
 * 2. **Symlinks are never followed, in either direction.** Listing uses `Dirent` kinds, which are
 *    `false` for a link; stat is `lstat`; removal re-checks the kind first. A link planted under
 *    `projects/` names something outside the root, and this sweep must never be the thing that
 *    reaches it.
 * 3. **Paths are rebuilt from validated parts at removal time.** `remove` never trusts a path
 *    string it was handed — it re-derives `<root>/<accountId>/projects/<slug>/<sessionId>` from
 *    the entry's own fields, each already matched against the pattern that admitted it.
 *
 * The filesystem is behind an interface for the same reason `config-dir.ts`'s is: the policy is
 * testable against no disk, and the test that proves a credential file is never a candidate runs
 * on every build.
 */

/** Session ids and account ids are both uuids; the CLI names transcripts after the former. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TRANSCRIPT_SUFFIX = ".jsonl"
/** The CLI's own name for the directory. Provenance: `projectsDirectory` in `claude auth status`. */
const PROJECTS_DIR = "projects"
/** A project slug is the cwd with separators replaced; the CLI never puts a separator in one. */
const PROJECT_SLUG = /^[\w.@%+-]+$/

/** One SDK session's artifacts on the volume, as the survey found them. */
export interface TranscriptEntry {
  readonly accountId: string
  /** The CLI's project slug, verbatim — the encoded cwd the subprocess ran in. */
  readonly project: string
  readonly sessionId: string
  /** The `<sessionId>.jsonl` transcript, when present. */
  readonly transcript: { readonly bytes: number } | null
  /** The `<sessionId>/` directory of tool results and subagent transcripts, when present. */
  readonly sessionDir: boolean
  /** Newest mtime among the session's artifacts, epoch ms — the last turn it served. */
  readonly changedAtMs: number
}

export interface SdkTranscripts {
  /** The root every account directory hangs off. Same value `AccountConfigDirs.root` carries. */
  readonly root: string
  /** Every session's artifacts under every account directory. Reads no file's contents. */
  survey(): Promise<readonly TranscriptEntry[]>
  /** Removes one session's transcript and directory. Idempotent; a vanished artifact is fine. */
  remove(entry: TranscriptEntry): Promise<void>
}

export interface TranscriptDirent {
  readonly name: string
  /** `other` covers symlinks, sockets, devices — anything the sweep must not touch. */
  readonly kind: "file" | "dir" | "other"
}

export interface TranscriptStat {
  readonly kind: "file" | "dir"
  readonly changedAtMs: number
  readonly bytes: number
}

/** The filesystem as the four calls this module makes. Every implementation must refuse symlinks. */
export interface TranscriptFs {
  /** Direct children of `path`, with their kinds. A missing `path` is `[]`, never a throw. */
  list(path: string): Promise<readonly TranscriptDirent[]>
  /** `lstat`: the entry's own timestamps. Null when missing, or when it is neither file nor dir. */
  stat(path: string): Promise<TranscriptStat | null>
  removeFile(path: string): Promise<void>
  removeDir(path: string): Promise<void>
}

export interface SdkTranscriptsOptions {
  /** `CLAUDE_CONFIG_ROOT`, already validated by `createAccountConfigDirs`. */
  readonly root: string
  readonly fs?: TranscriptFs
}

export function createSdkTranscripts(options: SdkTranscriptsOptions): SdkTranscripts {
  const root = resolve(options.root)
  const fs = options.fs ?? nodeTranscriptFs

  const projectPath = (accountId: string, project: string): string =>
    join(root, accountId, PROJECTS_DIR, project)

  return {
    root,

    survey: async () => {
      const entries: TranscriptEntry[] = []
      for (const account of await fs.list(root)) {
        if (account.kind !== "dir" || !UUID.test(account.name)) continue
        for (const project of await fs.list(join(root, account.name, PROJECTS_DIR))) {
          if (project.kind !== "dir" || !PROJECT_SLUG.test(project.name)) continue
          const dir = projectPath(account.name, project.name)
          for (const session of await surveyProject(fs, dir, await fs.list(dir))) {
            entries.push({ accountId: account.name, project: project.name, ...session })
          }
        }
      }
      return entries
    },

    remove: async (entry) => {
      // Rule 3: rebuilt from parts that were admitted by pattern, never from a carried path.
      if (!UUID.test(entry.accountId) || !UUID.test(entry.sessionId)) {
        throw new Error("transcript removal refused: entry does not name an account and a session")
      }
      if (!PROJECT_SLUG.test(entry.project)) {
        throw new Error("transcript removal refused: entry does not name a project slug")
      }
      const dir = projectPath(entry.accountId, entry.project)
      const transcript = join(dir, `${entry.sessionId}${TRANSCRIPT_SUFFIX}`)
      const sessionDir = join(dir, entry.sessionId)

      // Rule 2, at the moment it matters: whatever was surveyed, only a plain file and a plain
      // directory are removed now. A link that appeared since is left exactly where it is.
      if ((await fs.stat(transcript))?.kind === "file") await fs.removeFile(transcript)
      if ((await fs.stat(sessionDir))?.kind === "dir") await fs.removeDir(sessionDir)
    },
  }
}

type SessionArtifacts = Omit<TranscriptEntry, "accountId" | "project">

/** Pairs `<uuid>.jsonl` with `<uuid>/` and dates each session by its newest artifact. */
async function surveyProject(
  fs: TranscriptFs,
  dir: string,
  children: readonly TranscriptDirent[],
): Promise<readonly SessionArtifacts[]> {
  const sessions = new Map<
    string,
    { transcript: TranscriptStat | null; dir: TranscriptStat | null }
  >()
  const slot = (id: string) => {
    const existing = sessions.get(id)
    if (existing !== undefined) return existing
    const created = { transcript: null, dir: null }
    sessions.set(id, created)
    return created
  }

  for (const child of children) {
    if (child.kind === "file" && child.name.endsWith(TRANSCRIPT_SUFFIX)) {
      const id = child.name.slice(0, -TRANSCRIPT_SUFFIX.length)
      if (!UUID.test(id)) continue
      const stat = await fs.stat(join(dir, child.name))
      if (stat?.kind === "file") slot(id).transcript = stat
    } else if (child.kind === "dir" && UUID.test(child.name)) {
      const stat = await fs.stat(join(dir, child.name))
      if (stat?.kind === "dir") slot(child.name).dir = stat
    }
  }

  const out: SessionArtifacts[] = []
  for (const [sessionId, found] of sessions) {
    if (found.transcript === null && found.dir === null) continue
    out.push({
      sessionId,
      transcript: found.transcript === null ? null : { bytes: found.transcript.bytes },
      sessionDir: found.dir !== null,
      changedAtMs: Math.max(found.transcript?.changedAtMs ?? 0, found.dir?.changedAtMs ?? 0),
    })
  }
  return out
}

const nodeTranscriptFs: TranscriptFs = {
  list: async (path) => {
    try {
      const entries = await readdir(path, { withFileTypes: true })
      // `isFile()`/`isDirectory()` are false for a symlink even when its target is one — a link
      // is `other`, and `other` is never surveyed.
      return entries.map((entry) => ({
        name: entry.name,
        kind: entry.isFile() ? "file" : entry.isDirectory() ? "dir" : "other",
      }))
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  },

  stat: async (path) => {
    try {
      const stats = await lstat(path)
      if (stats.isFile()) return { kind: "file", changedAtMs: stats.mtimeMs, bytes: stats.size }
      if (stats.isDirectory()) return { kind: "dir", changedAtMs: stats.mtimeMs, bytes: 0 }
      return null
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  },

  removeFile: async (path) => {
    try {
      await unlink(path)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  },

  // `force` covers a directory that vanished between the survey and now; `recursive` is bounded
  // to the one `<uuid>/` directory `remove` rebuilt the path of.
  removeDir: (path) => rm(path, { recursive: true, force: true }),
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  )
}
