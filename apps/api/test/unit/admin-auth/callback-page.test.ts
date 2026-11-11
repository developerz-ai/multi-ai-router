import { expect, test } from "bun:test"
import { callbackPage, callbackPageSignedIn } from "../../../src/routes/admin/auth-callback-page"

test("the shared callback page escapes its title and detail", () => {
  const html = callbackPage(`<b>"x"</b>`, `label <script>alert('1')</script> & co`)
  expect(html).not.toContain("<script>")
  expect(html).not.toContain("<b>")
  expect(html).toContain("&lt;script&gt;alert(&#39;1&#39;)&lt;/script&gt; &amp; co")
  expect(html).toContain("&lt;b&gt;&quot;x&quot;&lt;/b&gt;")
})

test("the signed-in page only ever navigates to the console root", () => {
  const html = callbackPageSignedIn()
  expect(html).toContain(`location.replace("/")`)
  expect(html.match(/href="([^"]*)"/g)).toEqual([`href="/"`])
})
