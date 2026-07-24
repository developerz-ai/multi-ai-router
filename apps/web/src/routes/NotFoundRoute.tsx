import { A } from "@solidjs/router"
import { PageHeader } from "../components/PageHeader"

export default function NotFoundRoute() {
  return (
    <>
      <PageHeader title="Not found" subtitle="No console surface is registered at this path." />
      <p>
        <A href="/">Back to the overview</A>
      </p>
    </>
  )
}
