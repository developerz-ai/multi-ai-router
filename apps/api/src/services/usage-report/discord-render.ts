import {
  EMBED_DESCRIPTION_MAX_CHARS,
  EMBED_FIELD_NAME_MAX_CHARS,
  EMBED_FIELD_VALUE_MAX_CHARS,
  EMBED_FIELDS_MAX,
  EMBED_TITLE_MAX_CHARS,
  EMBED_TOTAL_MAX_CHARS,
} from "./discord-limits"
import { renderReportCsv, reportCsvFilename } from "./report-csv"
import type { ReportMeasures, ReportSection, WeeklyReport } from "./types"

/**
 * The Discord webhook payload for one stored weekly report (issue #229). Pure: a `WeeklyReport`
 * and the operator's `PUBLIC_URL` in, `payload_json` plus the CSV attachment out. Every list is
 * truncated with a `+N more` line inside Discord's embed limits (`discord-limits.ts`), so an
 * oversized week cannot turn delivery into a permanent 400. No account label exists in the
 * payload, and nothing here reads live state to add one.
 */

export interface DiscordEmbedField {
  readonly name: string
  readonly value: string
}

export interface DiscordEmbed {
  readonly title: string
  readonly description: string
  readonly fields: readonly DiscordEmbedField[]
}

export interface DiscordWebhookPayload {
  readonly embeds: readonly DiscordEmbed[]
  /**
   * Attachments the multipart body carries, paired with `files[i]` by position: Discord joins an
   * embed's `attachment://` reference or the message's attachment list to the uploaded file with
   * the same numeric `id` (developer docs, "Sending attachments" on the webhook execute endpoint).
   */
  readonly attachments: readonly { readonly id: number; readonly filename: string }[]
}

export interface DiscordDelivery {
  readonly payloadJson: string
  readonly csvFilename: string
  readonly csvBody: string
}

/** Top models shown in the embed; the CSV carries all ten. */
const EMBED_TOP_MODELS = 5

/**
 * The filtered Usage view for exactly this week, or `null` when `PUBLIC_URL` is unset — the link
 * is then omitted, never rendered against a guessed address. `from`/`to` are the usage route's
 * ISO-8601 window parameters; `to` is the exclusive period end, which is what the route expects.
 */
export function usageWindowUrl(
  publicUrl: string | null,
  period: WeeklyReport["period"],
): string | null {
  if (publicUrl === null) return null
  const query = new URLSearchParams({
    from: `${period.start}T00:00:00.000Z`,
    to: `${period.end}T00:00:00.000Z`,
  })
  return `${publicUrl.replace(/\/+$/, "")}/usage?${query.toString()}`
}

/** Exact fixed-point display: keeps every nonzero decimal, pads to two, never parses a float. */
function money(value: string): string {
  const [whole, fraction = ""] = value.split(".")
  const trimmed = `${fraction}00`.replace(/0+$/, "")
  return `${whole}.${trimmed.length < 2 ? trimmed.padEnd(2, "0") : trimmed}`
}

function measuresPhrase(m: ReportMeasures): string {
  const parts = [`${m.requests} req`, `METERED $${money(m.costMetered)}`]
  if (m.costNotional !== "0.000000" && m.costNotional !== "0")
    parts.push(`NOTIONAL $${money(m.costNotional)}`)
  if (m.unpricedAttempts === null) parts.push("unpriced: not measured")
  else if (m.unpricedAttempts > 0) parts.push(`unpriced: ${m.unpricedAttempts}`)
  return parts.join(" · ")
}

/**
 * The largest prefix of `lines` that fits `budget` together with a `+N more` line naming the rest,
 * newline-joined. A single line longer than the budget is cut with an ellipsis rather than dropped:
 * losing an owner's name silently is worse than showing half of it.
 */
function fitLines(lines: readonly string[], budget: number): string {
  if (lines.length === 0) return ""
  const capped = lines.map((l) => (l.length > budget ? `${l.slice(0, budget - 1)}…` : l))
  const whole = capped.join("\n")
  if (whole.length <= budget) return whole
  let kept = 0
  let used = 0
  for (const [i, l] of capped.entries()) {
    const cost = used + (kept === 0 ? l.length : l.length + 1)
    const suffix = `+${capped.length - i - 1} more`
    if (cost + 1 + suffix.length > budget) break
    used = cost
    kept = i + 1
  }
  const overflowNote = `+${capped.length - kept} more`
  if (kept === 0) return overflowNote.slice(0, budget)
  return `${capped.slice(0, kept).join("\n")}\n${overflowNote}`
}

interface FieldLines {
  readonly name: string
  readonly lines: readonly string[]
}

function sectionField(name: string, section: ReportSection): FieldLines | null {
  if (section.lines.length === 0) return null
  return {
    name,
    lines: section.lines.map(
      (l) => `${l.owner}${l.tool === null ? "" : ` · ${l.tool}`} — ${measuresPhrase(l)}`,
    ),
  }
}

/** Field contents before fitting, ordered by importance: truncation lands on the tail fields. */
function buildFieldLines(report: WeeklyReport): readonly FieldLines[] {
  const fields: FieldLines[] = []
  for (const field of [
    sectionField("People", report.sections.people),
    sectionField("Services", report.sections.services),
    sectionField("Owner kind unknown", report.sections.unknownKind),
  ]) {
    if (field !== null) fields.push(field)
  }
  fields.push({
    name: "Outside owner sections",
    lines: [
      `unassigned — ${measuresPhrase(report.buckets.unassigned)}`,
      `deleted — ${measuresPhrase(report.buckets.deleted)}`,
      `none — ${measuresPhrase(report.buckets.none)}`,
    ],
  })
  if (report.topModels.length > 0) {
    const shown = report.topModels.slice(0, EMBED_TOP_MODELS)
    const hidden = report.topModels.length - shown.length
    const lines = shown.map((m) => `${m.model ?? "(none)"} — ${m.requests} req`)
    if (hidden > 0) lines.push(`+${hidden} more in the CSV`)
    fields.push({ name: "Top models", lines })
  }
  if (report.overflow.length > 0) {
    fields.push({
      name: "Pool overflow",
      lines: report.overflow.map(
        (o) =>
          `${o.keyName} → ${o.poolName}${o.provider === null ? "" : ` (${o.provider})`} — ` +
          `${o.overflowAttempts}/${o.attempts} attempts (${Math.round(o.share * 100)}%)`,
      ),
    })
  }
  if (report.caveats.length > 0) {
    fields.push({ name: "Caveats", lines: report.caveats.map((c) => c.text) })
  }
  return fields.slice(0, EMBED_FIELDS_MAX)
}

function buildEmbed(report: WeeklyReport, publicUrl: string | null): DiscordEmbed {
  const title = `Weekly usage — ${report.period.start} to ${report.period.end}`.slice(
    0,
    EMBED_TITLE_MAX_CHARS,
  )
  const link = usageWindowUrl(publicUrl, report.period)
  const description = [
    measuresPhrase(report.totals),
    link === null ? null : `[Open this week in the Usage view](${link})`,
    "Per owner, key and pool: the attached CSV.",
  ]
    .filter((l): l is string => l !== null)
    .join("\n")
    .slice(0, EMBED_DESCRIPTION_MAX_CHARS)
  const fieldLines = buildFieldLines(report)
  // The 6000-character ceiling is on the whole embed, so with many fields the per-field budget
  // shrinks below 1024: split what is left after title, description and field names evenly. Each
  // field is fitted exactly once, against its final budget, so its `+N more` names every line it
  // dropped. The floor keeps the value non-empty (Discord rejects an empty field value) even for
  // a pathological description; with the fixed description here it is never reached.
  const nameChars = fieldLines.reduce((n, f) => n + f.name.length, 0)
  const remaining =
    EMBED_TOTAL_MAX_CHARS - title.length - description.length - nameChars - fieldLines.length
  const budget = Math.max(
    32,
    Math.min(EMBED_FIELD_VALUE_MAX_CHARS, Math.floor(remaining / Math.max(1, fieldLines.length))),
  )
  return {
    title,
    description,
    fields: fieldLines.map((f) => ({
      name: f.name.slice(0, EMBED_FIELD_NAME_MAX_CHARS),
      value: fitLines(f.lines, budget),
    })),
  }
}

export function renderDiscordDelivery(
  report: WeeklyReport,
  opts: { readonly publicUrl: string | null },
): DiscordDelivery {
  const csvFilename = reportCsvFilename(report.period.start)
  const payload: DiscordWebhookPayload = {
    embeds: [buildEmbed(report, opts.publicUrl)],
    attachments: [{ id: 0, filename: csvFilename }],
  }
  return { payloadJson: JSON.stringify(payload), csvFilename, csvBody: renderReportCsv(report) }
}
