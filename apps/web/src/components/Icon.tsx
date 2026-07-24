import styles from "./Icon.module.scss"

// Hand-drawn on a 16px grid, single stroke, `currentColor`. Inline rather than
// a library: six glyphs do not justify a dependency, and a self-contained SPA
// has no icon-font request to make.

export type IconName =
  | "overview"
  | "accounts"
  | "pools"
  | "keys"
  | "usage"
  | "settings"
  | "menu"
  | "close"

const PATHS: Readonly<Record<IconName, string>> = {
  // Four panes — a dashboard.
  overview: "M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h4v4h-4z",
  // Stacked units with status lights — upstream accounts.
  accounts: "M2.5 3.5h11v3.5h-11zM2.5 9h11v3.5h-11zM4.75 5.25h.01M4.75 10.75h.01",
  // Layers — a pool is members stacked into one addressable thing.
  pools: "M8 1.75 2 5l6 3.25L14 5 8 1.75ZM2 8l6 3.25L14 8M2 11l6 3.25L14 11",
  keys: "M13.5 2.5 8 8M11.5 4.5l1.75 1.75M8 8a3.25 3.25 0 1 1-4.6 4.6A3.25 3.25 0 0 1 8 8Z",
  usage: "M2 13.5h12M4.5 13.5V8M8 13.5V4M11.5 13.5v-3",
  settings:
    "M2 5h5M10 5h4M2 11h3M8 11h6M8.5 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM6.5 9.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z",
  menu: "M2.5 4.5h11M2.5 8h11M2.5 11.5h11",
  close: "M4 4l8 8M12 4l-8 8",
}

export interface IconProps {
  readonly name: IconName
}

/**
 * Always decorative: every icon in this console sits beside its own text label,
 * so it is hidden from assistive tech rather than given a redundant name.
 */
export function Icon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      class={styles.icon}
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.5"
      viewBox="0 0 16 16"
    >
      <path d={PATHS[props.name]} />
    </svg>
  )
}
