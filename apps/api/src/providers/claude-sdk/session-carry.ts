import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { UpstreamAdmissionRefused } from "../upstream-admission"
import {
  isMissing,
  nodeTranscriptFs,
  PROJECT_SLUG,
  PROJECTS_DIR,
  TRANSCRIPT_SUFFIX,
  type TranscriptFs,
  UUID,
} from "./transcripts"

/**
 * Moves one SDK session's transcript from the Account that ran it to the Account that runs it next,
 * so a conversation survives a failover instead of restarting on the new subscription.
 *
 * **Why this is legal, and why it works.** A local `claude` user who runs `/login` mid-session keeps
 * the conversation: the transcript is a file under `projects/<cwd-slug>/`, and logging in swaps
 * only `.credentials.json` beside it. The router keeps one `CLAUDE_CONFIG_DIR` per Account, so the
 * same session on another Account is the same file in another directory — copy it there and
 * `resume` reads it exactly as the original Account would have. Nothing about a credential is read,
 * moved, or written: the transcript holds the conversation, never the login (non-negotiable 1).
 *
 * **What is rewritten.** The CLI stamps its working directory — the Account's config directory —
 * into every transcript line (`"cwd"`) and into the environment block of the system prompt. That
 * absolute path is replaced with the target Account's; nothing else is touched.
 *
 * **What is not copied.** The `<session-uuid>/` directory beside the transcript (tool-results,
 * subagent transcripts). The router never executes a tool on this host (non-negotiable 2), so
 * nothing in a resumed turn reads those files back; copying them would be a recursive walk through
 * a credential directory for no gain.
 *
 * **The same closed-by-construction rules as the transcript sweep** (`transcripts.ts`): only a
 * `<uuid>.jsonl` directly under `projects/<slug>/` is ever read, a symlink is never followed on
 * either side, every path is rebuilt from validated ids, and each side runs under that Account's
 * owner hold so a deleted Account's directory is never written into. The target is written beside
 * itself and renamed into place, so a crash leaves either the old file or the whole new one.
 *
 * **Never throws.** A carry that cannot happen is an outcome; the caller starts the turn fresh, which
 * is exactly what it did before this module existed.
 */

export interface SessionCarryInput {
  readonly fromAccountId: string
  readonly toAccountId: string
  readonly sdkSessionId: string
}

export type SessionCarryFailure =
  /** An id is not a uuid, or both Accounts are the same one. A caller bug, never a disk state. */
  | "invalid-input"
  /** The source Account has no such transcript — swept, never written, or the Account is gone. */
  | "not-found"
  /** The transcript exceeds `CLAUDE_SDK_SESSION_CARRY_MAX_BYTES`. */
  | "too-large"
  /** The target Account has no config directory to carry into. */
  | "target-missing"
  /** Either Account's owner hold was refused — it is being deleted, or admission is closed. */
  | "owner-unavailable"
  /** The filesystem refused — a symlink where a file was expected, a permission, a full volume. */
  | "io-error"

export type SessionCarryOutcome =
  | { readonly carried: true; readonly bytes: number }
  | { readonly carried: false; readonly reason: SessionCarryFailure; readonly error?: unknown }

export interface SessionCarrier {
  carry(input: SessionCarryInput): Promise<SessionCarryOutcome>
}

/** The filesystem as the calls this module makes. Every implementation must refuse symlinks. */
export interface CarryFs extends Pick<TranscriptFs, "list" | "stat"> {
  /** A regular file's contents as UTF-8, refusing a symlink at the last component. */
  read(path: string): Promise<string>
  /** `mkdir` at `0700`, not recursive. An existing directory is fine; anything else there throws. */
  ensureDir(path: string): Promise<void>
  /** Writes a sibling temporary file and renames it over `path`. */
  replace(path: string, text: string): Promise<void>
}

export interface SessionCarrierOptions {
  /** `CLAUDE_CONFIG_ROOT`, already validated by `createAccountConfigDirs`. */
  readonly root: string
  readonly maxBytes: number
  readonly fs?: CarryFs
  readonly withAccountOwner?: <T>(accountId: string, task: () => Promise<T>) => Promise<T>
}

type Located = { readonly slug: string; readonly text: string } | SessionCarryFailure

export function createSessionCarrier(options: SessionCarrierOptions): SessionCarrier {
  const root = resolve(options.root)
  const fs = options.fs ?? nodeCarryFs
  const owned = <T>(id: string, task: () => Promise<T>): Promise<T> =>
    options.withAccountOwner?.(id, task) ?? task()

  const locate = async (accountId: string, sessionId: string): Promise<Located> => {
    const projects = join(root, accountId, PROJECTS_DIR)
    for (const project of await fs.list(projects)) {
      // The config directory's own slug names the Account; a `-tmp` or other cwd's project is a
      // different conversation space and never a source.
      if (project.kind !== "dir" || !PROJECT_SLUG.test(project.name)) continue
      if (!project.name.includes(accountId)) continue
      const path = join(projects, project.name, `${sessionId}${TRANSCRIPT_SUFFIX}`)
      const stat = await fs.stat(path)
      if (stat?.kind !== "file") continue
      if (stat.bytes > options.maxBytes) return "too-large"
      return { slug: project.name, text: await fs.read(path) }
    }
    return "not-found"
  }

  const place = async (input: SessionCarryInput, slug: string, text: string) => {
    const account = join(root, input.toAccountId)
    if ((await fs.stat(account))?.kind !== "dir") return "target-missing" as const
    const projects = join(account, PROJECTS_DIR)
    await fs.ensureDir(projects)
    const project = join(projects, slug)
    await fs.ensureDir(project)
    await fs.replace(join(project, `${input.sdkSessionId}${TRANSCRIPT_SUFFIX}`), text)
    return null
  }

  return {
    async carry(input) {
      const { fromAccountId, toAccountId, sdkSessionId } = input
      if (
        !UUID.test(fromAccountId) ||
        !UUID.test(toAccountId) ||
        !UUID.test(sdkSessionId) ||
        fromAccountId === toAccountId
      ) {
        return { carried: false, reason: "invalid-input" }
      }

      try {
        const found = await owned(fromAccountId, () => locate(fromAccountId, sdkSessionId))
        if (typeof found === "string") return { carried: false, reason: found }

        const text = found.text.replaceAll(join(root, fromAccountId), join(root, toAccountId))
        const slug = found.slug.replaceAll(fromAccountId, toAccountId)
        const refused = await owned(toAccountId, () => place(input, slug, text))
        if (refused !== null) return { carried: false, reason: refused }
        return { carried: true, bytes: Buffer.byteLength(text) }
      } catch (error) {
        if (error instanceof UpstreamAdmissionRefused) {
          return { carried: false, reason: "owner-unavailable" }
        }
        return { carried: false, reason: "io-error", error }
      }
    },
  }
}

const nodeCarryFs: CarryFs = {
  list: nodeTranscriptFs.list,
  stat: nodeTranscriptFs.stat,

  read: async (path) => {
    // `O_NOFOLLOW` closes the window between the `lstat` above and this open: a link swapped in
    // since is refused here with `ELOOP` rather than read through.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if (!(await handle.stat()).isFile()) throw new Error("carry source is not a regular file")
      return await handle.readFile({ encoding: "utf8" })
    } finally {
      await handle.close()
    }
  },

  ensureDir: async (path) => {
    try {
      await mkdir(path, { mode: 0o700 })
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
      // Exists: a directory is what we wanted, and a link to one is exactly what we refuse.
      if (!(await lstat(path)).isDirectory()) throw new Error("carry target is not a directory")
    }
  },

  replace: async (path, text) => {
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.carry`)
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await handle.writeFile(text, { encoding: "utf8" })
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      // `rename` replaces a link at `path` rather than writing through it.
      await rename(temporary, path)
    } catch (error) {
      await unlink(temporary).catch((cleanup: unknown) => {
        if (!isMissing(cleanup)) throw cleanup
      })
      throw error
    }
  },
}
