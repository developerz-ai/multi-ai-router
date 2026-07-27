/**
 * An account's model configuration as an operator types it into a form: the
 * comma-separated list of models it serves, and the alias map that renames one.
 *
 * Both sit here because both are read by the add form and the edit form, and a
 * second copy of either is how the two dialogs start disagreeing about what a
 * trailing comma or a blank line means.
 *
 * The alias map is written one `requested = upstream` per line.
 *
 * **The two sides are not interchangeable.** A key is what a *client* sends and
 * a value is the name that goes *upstream* (`services/routing/model.ts`), so a
 * map written the wrong way round is a router that answers 503 for the model it
 * was meant to serve. The line format states the direction with an arrow the
 * operator reads left to right, and the hint on the field says it again.
 *
 * Renaming is the one thing the router is allowed to do to a model name
 * (CLAUDE.md non-negotiable 4), and only because an operator wrote the rename
 * down here. Nothing in this module invents, normalises or reorders a name.
 */

/**
 * A comma-separated list as the operator typed it. Deduplicated but **not sorted
 * or renamed**: these are the upstream's own ids, and the router's job is to
 * carry a name through unchanged.
 */
export function parseModelList(raw: string): readonly string[] {
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  return [...new Set(names)]
}

/** A stored list back into the box. Order preserved — the operator's, not ours. */
export function formatModelList(models: readonly string[] | null): string {
  return (models ?? []).join(", ")
}

export type ModelAliasParse =
  | { readonly ok: true; readonly aliases: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly error: string }

/**
 * Lines to a map. Blank lines are ignored; anything else must be a pair.
 *
 * A duplicate requested-side name is refused rather than resolved last-wins: the
 * operator wrote two rules for one model, and quietly keeping one of them is how
 * a map ends up not doing what the box on screen plainly says.
 */
export function parseModelAliases(raw: string): ModelAliasParse {
  const aliases: Record<string, string> = {}

  for (const [index, line] of raw.split("\n").entries()) {
    const text = line.trim()
    if (text.length === 0) continue

    const at = text.indexOf("=")
    if (at === -1) {
      return { ok: false, error: `line ${index + 1} is not a pair — write "requested = upstream"` }
    }

    const requested = text.slice(0, at).trim()
    const upstream = text.slice(at + 1).trim()
    if (requested.length === 0 || upstream.length === 0) {
      return { ok: false, error: `line ${index + 1} has an empty side — both names are required` }
    }
    if (requested in aliases) {
      return { ok: false, error: `"${requested}" is mapped twice — one rule per requested name` }
    }

    aliases[requested] = upstream
  }

  return { ok: true, aliases }
}

/** A stored map back to lines, in the order the map holds them. Never sorted or renamed. */
export function formatModelAliases(aliases: Readonly<Record<string, string>> | null): string {
  if (aliases === null) return ""
  return Object.entries(aliases)
    .map(([requested, upstream]) => `${requested} = ${upstream}`)
    .join("\n")
}
