import { describe, expect, test } from "bun:test"
import { createDecodoVendor } from "../../../src/services/accounts/egress/decodo"
import { createIproyalVendor } from "../../../src/services/accounts/egress/iproyal"
import { vendorFailure } from "../../../src/services/accounts/egress/vendor"

// A vendor that talks to a scripted endpoint and records the request it made. The generic keeps the
// vendor-specific secret (token / apiKey + username + password) typed through to the vendor under test.
function scripted<Secrets extends Record<string, string | null>>(
  secrets: Secrets,
  answer: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  const calls: { url: string; auth: string | null }[] = []
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({
      url,
      auth: (init.headers as Record<string, string>)?.authorization ?? null,
    })
    return answer(url, init)
  }
  const deps = { ...secrets, fetch, timeoutMs: 200, maxBytes: 8_192 }
  return { deps, calls }
}

describe("the ITRoyal listing", () => {
  test("builds one country-targeted backconnect URL per country, gateway first", async () => {
    const { deps, calls } = scripted({ token: "tok" }, () =>
      Response.json({
        data: [{ username: "sub_user", password: "sub_pass", traffic_available: 50 }],
      }),
    )
    const listing = await createIproyalVendor(deps).list()
    expect(listing.ok).toBe(true)
    if (!listing.ok) return
    expect(listing.proxies).toHaveLength(15)
    const us = listing.proxies.find((p) => p.country === "us")
    expect(us, "us proxy present").toBeTruthy()
    if (!us) throw new Error("missing us proxy")
    expect(us.vendor).toBe("iproyal")
    expect(us.address).toBe("geo.iproyal.com:12321:us")
    expect(us.url).toMatch(
      /^http:\/\/sub_user:sub_pass_country-us_session-[0-9a-z]{8}_lifetime-60m@geo\.iproyal\.com:12321\/?$/,
    )
    // The bearer token goes on the request.
    expect(calls[0]?.auth).toBe("Bearer tok")
  })

  test("a null token is off, and never calls the API", async () => {
    const { deps, calls } = scripted({ token: null }, () => Response.json({ data: [] }))
    expect(await createIproyalVendor(deps).list()).toEqual({ ok: false, code: "off" })
    expect(calls).toHaveLength(0)
  })

  test("a rejected key is unauthorized; a bad shape is unreadable; a hang is a timeout", async () => {
    const unauthorized = scripted({ token: "tok" }, () => new Response(`bad tok`, { status: 401 }))
    expect(await createIproyalVendor(unauthorized.deps).list()).toMatchObject({
      ok: false,
      code: "unauthorized",
    })

    const unreadable = scripted({ token: "tok" }, () => Response.json({ not: "data" }))
    expect(await createIproyalVendor(unreadable.deps).list()).toMatchObject({
      ok: false,
      code: "unreadable",
    })

    const timeout = scripted(
      { token: "tok" },
      (_u, init) =>
        new Promise((_, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        ),
    )
    expect(await createIproyalVendor(timeout.deps).list()).toEqual({ ok: false, code: "timeout" })
  })

  test("an unauthorized listing quotes the status but nothing it answered", async () => {
    const { deps } = scripted(
      { token: "super-secret-tok" },
      () => new Response("bad super-secret-tok", { status: 401 }),
    )
    const listing = await createIproyalVendor(deps).list()
    expect(listing).toMatchObject({ ok: false, code: "unauthorized" })
    if (listing.ok) return
    const shown = JSON.stringify([listing, vendorFailure("iproyal", listing)])
    expect(shown).not.toMatch(/super-secret-tok/)
  })
})

describe("the Decodo listing", () => {
  test("builds one country-targeted backconnect URL per country, gateway first", async () => {
    const { deps, calls } = scripted({ apiKey: "key", username: "sp1", password: "sp_pass" }, () =>
      Response.json([{ username: "sp1", status: "active", service_type: "residential_proxies" }]),
    )
    const listing = await createDecodoVendor(deps).list()
    expect(listing.ok).toBe(true)
    if (!listing.ok) return
    expect(listing.proxies).toHaveLength(15)
    const de = listing.proxies.find((p) => p.country === "de")
    expect(de, "de proxy present").toBeTruthy()
    if (!de) throw new Error("missing de proxy")
    expect(de.vendor).toBe("decodo")
    expect(de.address).toBe("gate.decodo.com:7000:de")
    expect(de.url).toMatch(
      /^http:\/\/user-sp1-country-de-session-[0-9a-z]{16}-sessionduration-60:sp_pass@gate\.decodo\.com:7000\/?$/,
    )
    expect(calls[0]?.auth).toBe("key")
  })

  test("needs all three secrets; any missing is off and never calls the API", async () => {
    for (const creds of [
      { apiKey: null, username: "sp1", password: "p" },
      { apiKey: "key", username: null, password: "p" },
      { apiKey: "key", username: "sp1", password: null },
    ]) {
      const { deps, calls } = scripted(creds, () => Response.json([]))
      expect(await createDecodoVendor(deps).list()).toEqual({ ok: false, code: "off" })
      expect(calls).toHaveLength(0)
    }
  })

  test("a sub-user that is no longer active yields an empty (but ok) listing", async () => {
    const { deps } = scripted({ apiKey: "key", username: "sp1", password: "p" }, () =>
      Response.json([{ username: "other", status: "active", service_type: "residential_proxies" }]),
    )
    expect(await createDecodoVendor(deps).list()).toEqual({ ok: true, proxies: [], complete: true })
  })

  test("an API failure degrades: the URLs still surface so the probe can validate them", async () => {
    const { deps } = scripted({ apiKey: "key", username: "sp1", password: "p" }, () =>
      Promise.reject(new Error("boom key")),
    )
    const listing = await createDecodoVendor(deps).list()
    expect(listing.ok).toBe(true)
    if (listing.ok) expect(listing.proxies).toHaveLength(15)
  })

  test("a 401 is unauthorized; a bad body still surfaces the URLs", async () => {
    const unauthorized = scripted(
      { apiKey: "key", username: "sp1", password: "p" },
      () => new Response("bad key", { status: 401 }),
    )
    expect(await createDecodoVendor(unauthorized.deps).list()).toMatchObject({
      ok: false,
      code: "unauthorized",
    })

    const badBody = scripted({ apiKey: "key", username: "sp1", password: "p" }, () =>
      Response.json("nope"),
    )
    const listing = await createDecodoVendor(badBody.deps).list()
    expect(listing.ok).toBe(true)
    if (listing.ok) expect(listing.proxies).toHaveLength(15)
  })

  test("an unauthorized listing quotes the status but nothing it answered", async () => {
    const { deps } = scripted(
      { apiKey: "super-secret-key", username: "sp1", password: "p" },
      () => new Response("bad super-secret-key", { status: 401 }),
    )
    const listing = await createDecodoVendor(deps).list()
    expect(listing).toMatchObject({ ok: false, code: "unauthorized" })
    if (listing.ok) return
    const shown = JSON.stringify([listing, vendorFailure("decodo", listing)])
    expect(shown).not.toMatch(/super-secret-key/)
  })
})
