import { describe, expect, test } from "bun:test"
import {
  ATTACHMENT_MAX_BYTES,
  EMBED_DESCRIPTION_MAX_CHARS,
  EMBED_FIELD_NAME_MAX_CHARS,
  EMBED_FIELD_VALUE_MAX_CHARS,
  EMBED_FIELDS_MAX,
  EMBED_TITLE_MAX_CHARS,
  EMBED_TOTAL_MAX_CHARS,
  MESSAGE_CONTENT_MAX_CHARS,
} from "../../../src/services/usage-report/discord-limits"
import type { DiscordWebhookPayload } from "../../../src/services/usage-report/discord-render"
import {
  renderDiscordDelivery,
  usageWindowUrl,
} from "../../../src/services/usage-report/discord-render"
import { weeklyReportPayload } from "../../../src/services/usage-report/payload-schema"
import { renderReportCsv } from "../../../src/services/usage-report/report-csv"
import {
  oversizedWeeklyReport,
  SEEDED_ACCOUNT_LABEL,
  storedPayloadWithAccountLabel,
  weeklyReportFixture,
} from "../../support/weekly-report"

/** The pure Discord renderer: embed limits, the Usage link, and the CSV attachment (issue #229). */

const PUBLIC_URL = "https://router.example.test"

function payloadOf(publicUrl: string | null = PUBLIC_URL): DiscordWebhookPayload {
  const delivery = renderDiscordDelivery(weeklyReportFixture(), { publicUrl })
  return JSON.parse(delivery.payloadJson) as DiscordWebhookPayload
}

/** Every character Discord counts toward the embed's 6000-character ceiling. */
function embedChars(payload: DiscordWebhookPayload): number {
  let total = 0
  for (const embed of payload.embeds) {
    total += (embed.title?.length ?? 0) + (embed.description?.length ?? 0)
    for (const field of embed.fields ?? []) total += field.name.length + field.value.length
  }
  return total
}

describe("discord-limits — the documented numbers, checked at build time", () => {
  // Provenance: Discord developer docs, "Embed Object — Embed limits" and the message limits,
  // read 2026-10-15. If Discord changes a limit, this fails and the constants are re-read — the
  // renderer must not drift silently past a 400.
  test("pin the documented embed, message and attachment limits", () => {
    expect(EMBED_TOTAL_MAX_CHARS).toBe(6000)
    expect(EMBED_TITLE_MAX_CHARS).toBe(256)
    expect(EMBED_DESCRIPTION_MAX_CHARS).toBe(4096)
    expect(EMBED_FIELDS_MAX).toBe(25)
    expect(EMBED_FIELD_NAME_MAX_CHARS).toBe(256)
    expect(EMBED_FIELD_VALUE_MAX_CHARS).toBe(1024)
    expect(MESSAGE_CONTENT_MAX_CHARS).toBe(2000)
    expect(ATTACHMENT_MAX_BYTES).toBe(25 * 1024 * 1024)
  })
})

describe("renderDiscordDelivery — the normal week", () => {
  test("one embed, titled with the week, totals in the description, the CSV attached", () => {
    const delivery = renderDiscordDelivery(weeklyReportFixture(), { publicUrl: PUBLIC_URL })
    const payload = JSON.parse(delivery.payloadJson) as DiscordWebhookPayload
    expect(payload.embeds).toHaveLength(1)
    const embed = payload.embeds[0]
    expect(embed?.title).toContain("2026-10-05")
    expect(embed?.title).toContain("2026-10-12")
    expect(embed?.description).toContain("30 req")
    expect(embed?.description).toContain("METERED $3.00")
    // NOTIONAL zero is not shown as a figure, and METERED and NOTIONAL are never added together.
    expect(embed?.description).not.toContain("NOTIONAL")
    expect(payload.attachments).toEqual([{ id: 0, filename: "usage-report-2026-10-05.csv" }])
    expect(delivery.csvFilename).toBe("usage-report-2026-10-05.csv")
    expect(delivery.csvBody).toContain("section,owner,owner_kind,tool,key_name,pool_name")
    expect(embedChars(payload)).toBeLessThanOrEqual(EMBED_TOTAL_MAX_CHARS)
  })

  test("owner lines carry owner and tool; overflow is the only place key and pool names appear", () => {
    const payload = payloadOf()
    const fields = payload.embeds[0]?.fields ?? []
    const people = fields.find((f) => f.name === "People")
    expect(people?.value).toContain("alice · editor")
    expect(people?.value).toContain("carol")
    const overflow = fields.find((f) => f.name === "Pool overflow")
    expect(overflow?.value).toContain("build-bot-key → main (openai-oauth)")
    expect(overflow?.value).toContain("3/8 attempts (38%)")
    const withoutOverflow = fields
      .filter((f) => f.name !== "Pool overflow")
      .map((f) => f.value)
      .join("\n")
    expect(withoutOverflow).not.toContain("build-bot-key")
    expect(withoutOverflow).not.toContain("main")
  })

  test("top models are capped in the embed, and the cap says where the rest are", () => {
    const report = weeklyReportFixture({
      topModels: Array.from({ length: 10 }, (_, i) => ({
        requests: 10 - i,
        tokensIn: 0,
        tokensOut: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costMetered: "0.000000",
        costNotional: "0.000000",
        unpricedAttempts: 0,
        model: `m${i}`,
      })),
    })
    const payload = JSON.parse(
      renderDiscordDelivery(report, { publicUrl: null }).payloadJson,
    ) as DiscordWebhookPayload
    const models = payload.embeds[0]?.fields.find((f) => f.name === "Top models")
    expect(models?.value).toContain("m4")
    expect(models?.value).not.toContain("m5 —")
    expect(models?.value).toContain("+5 more in the CSV")
  })

  test("the Usage link carries exactly the week window when PUBLIC_URL is set", () => {
    const url = usageWindowUrl(PUBLIC_URL, { start: "2026-10-05", end: "2026-10-12" })
    expect(url).toBe(
      "https://router.example.test/usage?from=2026-10-05T00%3A00%3A00.000Z&to=2026-10-12T00%3A00%3A00.000Z",
    )
    expect(
      usageWindowUrl("https://router.example.test/", { start: "2026-10-05", end: "2026-10-12" }),
    ).toBe(url)
    const payload = payloadOf()
    expect(payload.embeds[0]?.description).toContain(`[Open this week in the Usage view](${url})`)
  })

  test("the link is omitted entirely when PUBLIC_URL is unset", () => {
    expect(usageWindowUrl(null, { start: "2026-10-05", end: "2026-10-12" })).toBeNull()
    const payload = payloadOf(null)
    expect(payload.embeds[0]?.description).not.toContain("Usage view")
    expect(payload.embeds[0]?.description).not.toContain("http")
  })
})

describe("renderDiscordDelivery — the oversized week", () => {
  const delivery = renderDiscordDelivery(oversizedWeeklyReport(), { publicUrl: PUBLIC_URL })
  const payload = JSON.parse(delivery.payloadJson) as DiscordWebhookPayload
  const embed = payload.embeds[0]

  test("every Discord limit holds", () => {
    expect(payload.embeds).toHaveLength(1)
    expect(embed?.title.length).toBeLessThanOrEqual(EMBED_TITLE_MAX_CHARS)
    expect(embed?.description.length).toBeLessThanOrEqual(EMBED_DESCRIPTION_MAX_CHARS)
    expect(embed?.fields.length).toBeLessThanOrEqual(EMBED_FIELDS_MAX)
    for (const field of embed?.fields ?? []) {
      expect(field.name.length).toBeLessThanOrEqual(EMBED_FIELD_NAME_MAX_CHARS)
      expect(field.value.length).toBeLessThanOrEqual(EMBED_FIELD_VALUE_MAX_CHARS)
      expect(field.value.length).toBeGreaterThan(0)
    }
    expect(embedChars(payload)).toBeLessThanOrEqual(EMBED_TOTAL_MAX_CHARS)
  })

  test("truncated sections end in a '+N more' line naming what was dropped", () => {
    const people = embed?.fields.find((f) => f.name === "People")
    expect(people?.value).toMatch(/\+\d+ more$/)
    const dropped = Number(/\+(\d+) more$/.exec(people?.value ?? "")?.[1])
    const shown = (people?.value ?? "").split("\n").length - 1
    expect(dropped + shown).toBe(400)
  })

  test("the CSV attachment keeps every line the embed dropped", () => {
    const rows = delivery.csvBody.split("\r\n").filter((r) => r.length > 0)
    expect(rows.length).toBeGreaterThan(400)
    expect(delivery.csvBody).toContain("owner-399-")
    expect(Buffer.byteLength(delivery.csvBody)).toBeLessThan(ATTACHMENT_MAX_BYTES)
  })
})

describe("renderReportCsv", () => {
  test("carries owner, tool and key-name columns, buckets, models, overflow and caveats", () => {
    const csv = renderReportCsv(weeklyReportFixture())
    const [header, ...rows] = csv.split("\r\n")
    expect(header).toBe(
      "section,owner,owner_kind,tool,key_name,pool_name,provider,model,requests,tokens_in," +
        "tokens_out,cache_read_tokens,cache_write_tokens,cost_metered,cost_notional," +
        "unpriced_attempts,attempts,overflow_attempts,overflow_share,note",
    )
    const names = (header ?? "").split(",")
    const cells = rows
      .filter((r) => r.length > 0)
      .map((r) => Object.fromEntries(r.split(",").map((v, i) => [names[i] ?? "", v])))
    const one = (where: Record<string, string>) => {
      const found = cells.filter((row) => Object.entries(where).every(([k, v]) => row[k] === v))
      expect(found).toHaveLength(1)
      return found[0] as Record<string, string>
    }

    const alice = one({ section: "people", owner: "alice" })
    expect(alice.tool).toBe("editor")
    expect(alice.owner_kind).toBe("person")
    expect(alice.requests).toBe("10")
    expect(alice.cost_metered).toBe("1.000000")
    // The key-name column exists on every row and is only populated where the payload has one.
    expect(alice.key_name).toBe("")

    const total = one({ section: "total" })
    expect(total.requests).toBe("30")
    expect(total.cost_metered).toBe("3.000000")

    one({ section: "people_total" })
    one({ section: "bucket", owner: "none" })
    one({ section: "bucket", owner: "unassigned" })
    one({ section: "bucket", owner: "deleted" })
    expect(cells.filter((row) => row.section === "model")).toHaveLength(2)
    one({ section: "model", model: "big-model" })

    const overflowRow = one({ section: "overflow" })
    expect(overflowRow.owner).toBe("build-bot")
    expect(overflowRow.tool).toBe("")
    expect(overflowRow.key_name).toBe("build-bot-key")
    expect(overflowRow.pool_name).toBe("main")
    expect(overflowRow.provider).toBe("openai-oauth")
    expect(overflowRow.attempts).toBe("8")
    expect(overflowRow.overflow_attempts).toBe("3")
    expect(overflowRow.overflow_share).toBe("0.3750")

    const caveat = one({ section: "caveat" })
    expect(caveat.note).toBe("Requests are dated by settlement.")
  })

  test("the fixture's report renders no account label, and the CSV guards formulas", () => {
    const csv = renderReportCsv(
      weeklyReportFixture({
        sections: {
          ...weeklyReportFixture().sections,
          people: {
            lines: [
              {
                ...weeklyReportFixture().sections.people.lines[0],
                owner: '=HYPERLINK("http://evil.example")',
              },
            ],
            totals: weeklyReportFixture().sections.people.totals,
          },
        },
      }),
    )
    expect(csv).toContain("'=")
    expect(csv).not.toContain("@")
  })
})

describe("weeklyReportPayload — the delivery boundary parse", () => {
  test("accepts what the builder stores, including a JSON round trip", () => {
    const parsed = weeklyReportPayload.safeParse(JSON.parse(JSON.stringify(weeklyReportFixture())))
    expect(parsed.success).toBe(true)
  })

  test("refuses a foreign or corrupt payload", () => {
    for (const bad of [
      null,
      {},
      { version: 2 },
      { ...weeklyReportFixture(), version: 2 },
      { ...weeklyReportFixture(), sections: undefined },
      { ...weeklyReportFixture(), totals: { requests: "ten" } },
    ]) {
      expect(weeklyReportPayload.safeParse(bad).success).toBe(false)
    }
  })

  test("an account label seeded into the stored payload reaches neither the embed JSON nor the CSV", () => {
    // The seed travels the delivery's own path: repository `unknown` -> boundary parse -> render.
    // It sits where a builder bug could stash a label: on the overflow line, whose `provider` is
    // the account's provider id and never its label (the parse strips unknown keys there), and at
    // the top level, which the loose parse passes through and only the renderer's contract
    // adherence can drop. The old assertion on an unseeded fixture could never fail; this one is
    // proven to bite by temporarily leaking the label in each renderer.
    const parsed = weeklyReportPayload.safeParse(storedPayloadWithAccountLabel())
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const delivery = renderDiscordDelivery(parsed.data, { publicUrl: PUBLIC_URL })
    // The exact label, not just "@": this is the account label that must stay out.
    expect(delivery.payloadJson).not.toContain(SEEDED_ACCOUNT_LABEL)
    expect(delivery.csvBody).not.toContain(SEEDED_ACCOUNT_LABEL)
    // And nothing email-shaped at all: the seed is the only "@" in any input.
    expect(delivery.payloadJson).not.toContain("@")
    expect(delivery.csvBody).not.toContain("@")
  })
})
