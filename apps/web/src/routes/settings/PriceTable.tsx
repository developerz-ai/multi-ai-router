import { Show } from "solid-js"
import { Badge } from "../../components/Badge"
import { Button } from "../../components/Button"
import { type Column, Table } from "../../components/Table"
import type { PriceRow, RateField } from "../../lib/api/settings"
import { RATE_FIELDS } from "../../lib/api/settings"
import { cx } from "../../lib/cx"
import styles from "./PriceTable.module.scss"
import { ORIGIN_TONE, RATE_HEADERS, rateSummary } from "./price-editing"

export interface PriceTableProps {
  readonly rows: readonly PriceRow[]
  /** The text in a cell, which is the operator's keystrokes and not a re-formatted number. */
  readonly value: (row: PriceRow, field: RateField) => string
  readonly invalid: (row: PriceRow, field: RateField) => boolean
  readonly onEdit: (row: PriceRow, field: RateField, value: string) => void
  /** Back to the shipped price, or — for a model the image does not price — gone. */
  readonly onRevert: (row: PriceRow) => void
}

/**
 * Every priced `(provider, model)` pair, with its four rates editable in place.
 *
 * The unit is stated once, in the caption and the section heading above, rather
 * than repeated in forty cells: a table that prints "$/Mtok" beside every figure
 * is unreadable at the density this screen needs.
 *
 * Each row says where its price comes from — shipped, overridden, or an
 * extension of a model the image never priced — because "which of these did I
 * change" is the question an operator opens this table with. When a row is
 * overridden, the shipped number stays beside it: an override is only readable
 * against what it replaced.
 */
export function PriceTable(props: PriceTableProps) {
  const columns = (): readonly Column<PriceRow>[] => [
    {
      id: "model",
      header: "Model",
      cell: (row) => (
        <div class={styles.identity}>
          <span class={styles.model}>{row.model}</span>
          <span class={styles.provider}>{row.provider}</span>
          <Badge tone={ORIGIN_TONE[row.origin]}>{row.origin}</Badge>
          <Show when={row.origin === "overridden" ? row.shipped : null}>
            {(shipped) => <span class={styles.shipped}>shipped {rateSummary(shipped())}</span>}
          </Show>
        </div>
      ),
    },
    ...RATE_FIELDS.map((field) => ({
      id: field,
      header: RATE_HEADERS[field],
      numeric: true,
      cell: (row: PriceRow) => (
        <input
          // The column header names the measure, but a header does not name a
          // control — so each input carries its own label.
          aria-invalid={props.invalid(row, field) ? "true" : undefined}
          aria-label={`${RATE_HEADERS[field]} rate for ${row.provider} ${row.model}`}
          class={cx(styles.rate, props.invalid(row, field) && styles.invalid)}
          inputmode="decimal"
          min="0"
          onInput={(event) => props.onEdit(row, field, event.currentTarget.value)}
          step="any"
          type="number"
          value={props.value(row, field)}
        />
      ),
    })),
    {
      id: "actions",
      header: "Actions",
      cell: (row) => (
        <Show fallback={<span class={styles.provider}>—</span>} when={row.origin !== "shipped"}>
          <Button onClick={() => props.onRevert(row)} size="sm" tone="neutral">
            {row.shipped === null ? "Remove" : "Reset to shipped"}
          </Button>
        </Show>
      ),
    },
  ]

  return (
    <Table
      caption="Rates in USD per million tokens. Edits are local until you save; saving replaces the whole override table with what is listed here."
      columns={columns()}
      emptyMessage="This image ships no prices and none are overridden."
      rowId={(row) => row.id}
      rows={props.rows}
    />
  )
}
