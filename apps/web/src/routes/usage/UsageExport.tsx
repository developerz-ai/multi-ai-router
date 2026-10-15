import type { UsageRange } from "../../lib/api/usage"
import { type UsageFilterParams, usageExportHref } from "../../lib/api/usage-params"
import styles from "./UsageExport.module.scss"

export interface UsageExportProps {
  readonly range: UsageRange
  /** Filter params present on the page; forwarded as-is. */
  readonly filters?: UsageFilterParams
}

/**
 * Downloads the usage the page is showing as CSV. A plain link: the browser sends the session
 * cookie and the server answers an attachment, so there is no client-side file building. Over the
 * server's row cap it answers a JSON 400 naming the cap, which the browser shows instead of a file.
 */
export function UsageExport(props: UsageExportProps) {
  return (
    <a class={styles.link} href={usageExportHref(props.range, props.filters)}>
      Export CSV
    </a>
  )
}
