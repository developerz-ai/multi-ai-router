/**
 * `bun.lock` → the resolved third-party packages, and nothing else.
 *
 * The lockfile is the router's supply chain in one file: every package in it runs inside the API
 * process, with `ENCRYPTION_KEY` and the Postgres credentials in reach. So the advisory assessment
 * asks about *the resolved set* — the exact versions that ship — and not about the ranges the
 * manifests declare.
 *
 * `bun.lock` is JSONC: trailing commas and comments are legal, so it cannot be handed to
 * `JSON.parse` as it stands. The scanner below is string-aware, because the naive version of this
 * (strip everything between `//` and the newline, drop every trailing comma) corrupts any string
 * that contains `//` or a comma — and a package name, a version range or a `sha512-…` integrity
 * hash is exactly the kind of text that contains them.
 *
 * Workspace entries are excluded: `…@workspace:packages/core` is this repository, not a published
 * dependency, and asking OSV about ourselves would be asking about a package that does not exist.
 *
 * Pure: text in, packages out. No clock, no network, no filesystem — which is what makes the
 * parser's failure modes testable, and they matter: a lockfile that cannot be read must throw
 * rather than return an empty list, because an empty list assessed as "clean" is a green build
 * that proved nothing.
 */

/** A resolved dependency: the published name and the exact version the lockfile pins. */
export interface ResolvedPackage {
  readonly name: string
  readonly version: string
}

/**
 * The lockfile could not be read as a lockfile.
 *
 * Named rather than generic so the caller can tell "the tree is broken" from "the assessment
 * could not complete" — the two produce the same red outcome, but only one of them is a fact
 * about the repository.
 */
export class LockfileParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LockfileParseError"
  }
}

/** The version prefix bun writes for a workspace resolution. */
const WORKSPACE_VERSION = "workspace:"

/**
 * The resolved third-party packages in a `bun.lock`.
 *
 * @throws {LockfileParseError} when the text is not a lockfile this build understands, or when it
 * resolves nothing at all — both mean "nothing was assessed", which must never read as "clean".
 */
export function parseLockfile(text: string): readonly ResolvedPackage[] {
  const packages = packagesOf(parseJsonc(text))
  const resolved = new Map<string, ResolvedPackage>()

  for (const [key, entry] of Object.entries(packages)) {
    const descriptor = descriptorOf(key, entry)
    if (descriptor.version.startsWith(WORKSPACE_VERSION)) continue
    // The same package can be resolved twice at different versions (a hoisted tree keeps both
    // when the ranges disagree), so the set is keyed by name *and* version: an advisory against
    // one version says nothing about the other.
    resolved.set(`${descriptor.name}@${descriptor.version}`, descriptor)
  }

  if (resolved.size === 0) {
    throw new LockfileParseError("bun.lock resolved no packages — there is nothing to assess")
  }

  return [...resolved.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
  )
}

function packagesOf(parsed: unknown): Record<string, unknown> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new LockfileParseError("bun.lock is not a JSON object")
  }
  const packages = (parsed as { packages?: unknown }).packages
  if (typeof packages !== "object" || packages === null || Array.isArray(packages)) {
    throw new LockfileParseError("bun.lock has no `packages` section")
  }
  return packages as Record<string, unknown>
}

/**
 * The resolution descriptor of one lockfile entry: `name@version`.
 *
 * The key bun writes is a *path* through the tree (`@babel/core/@babel/types`), not a package
 * name, so the descriptor is the only place the real name and version live. A scoped name carries
 * its own `@`, so the separator is the second one.
 */
function descriptorOf(key: string, entry: unknown): ResolvedPackage {
  if (!Array.isArray(entry)) {
    throw new LockfileParseError(`bun.lock entry ${key} is not an array`)
  }
  const descriptor = entry[0]
  if (typeof descriptor !== "string") {
    throw new LockfileParseError(`bun.lock entry ${key} carries no resolution descriptor`)
  }
  const separator = descriptor.indexOf("@", descriptor.startsWith("@") ? 1 : 0)
  if (separator <= 0) {
    throw new LockfileParseError(`bun.lock entry ${key} has an unreadable descriptor`)
  }
  return { name: descriptor.slice(0, separator), version: descriptor.slice(separator + 1) }
}

function parseJsonc(text: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripTrailingCommas(stripComments(text)))
  } catch (error) {
    throw new LockfileParseError(
      `bun.lock is not parsable JSONC: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return parsed
}

/**
 * Drops `//` and `/* *\/` comments, keeping the strings intact.
 *
 * The scanner tracks whether it is inside a string, because inside one a `/` is data: an integrity
 * hash or a URL must survive untouched, and a `//` inside a string is not a comment.
 */
function stripComments(text: string): string {
  let out = ""
  let index = 0
  let inString = false

  while (index < text.length) {
    const char = text[index] ?? ""
    const next = text[index + 1] ?? ""

    if (inString) {
      out += char
      if (char === "\\") {
        out += next
        index += 2
        continue
      }
      if (char === '"') inString = false
      index += 1
      continue
    }

    if (char === '"') {
      inString = true
      out += char
      index += 1
      continue
    }

    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1
      continue
    }

    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2)
      if (end === -1) throw new LockfileParseError("bun.lock ends inside a block comment")
      index = end + 2
      // One newline stands in for the comment, so a JSON.parse error still points near the line
      // that broke it.
      out += "\n"
      continue
    }

    out += char
    index += 1
  }

  return out
}

/**
 * Drops the commas that sit directly before a `}` or a `]`.
 *
 * A comma inside a string is data and is left alone — the same reason the comment scanner
 * tracks strings.
 */
function stripTrailingCommas(text: string): string {
  let out = ""
  let index = 0
  let inString = false

  while (index < text.length) {
    const char = text[index] ?? ""

    if (inString) {
      out += char
      if (char === "\\") {
        out += text[index + 1] ?? ""
        index += 2
        continue
      }
      if (char === '"') inString = false
      index += 1
      continue
    }

    if (char === '"') {
      inString = true
      out += char
      index += 1
      continue
    }

    if (char === ",") {
      let lookahead = index + 1
      while (lookahead < text.length && /\s/.test(text[lookahead] ?? "")) lookahead += 1
      const following = text[lookahead]
      if (following === "}" || following === "]") {
        index += 1
        continue
      }
    }

    out += char
    index += 1
  }

  return out
}
