import { describe, expect, test } from "bun:test"
import {
  findAuthorizeUrl,
  parsePastedCode,
  readState,
} from "../../../src/providers/claude-sdk/login"

/**
 * Reading the `claude` CLI's login output.
 *
 * This is the part of the connect flow most likely to break on a CLI release, and it is pure: a
 * string in, a URL or a null out. Everything here is a fabricated line of CLI output — no binary is
 * started, and no value in this file is a real credential.
 */

const ESC = "\u001b"
const BEL = "\u0007"

/** The shape Claude Code 2.1.220 prints, host and path included. */
const URL_LINE =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&code_challenge_method=S256&state=s-9f2c1"

describe("finding the authorization URL", () => {
  test("takes the URL out of an ordinary line of output", () => {
    expect(findAuthorizeUrl(`Open this in your browser:\n${URL_LINE}\n`)).toBe(URL_LINE)
  })

  test("accepts the console host and the older claude.ai one", () => {
    for (const url of [
      "https://console.anthropic.com/oauth/authorize?state=s-1&client_id=abc",
      "https://claude.ai/oauth/authorize?state=s-1&client_id=abc",
    ]) {
      expect(findAuthorizeUrl(url)).toBe(url)
    }
  })

  /**
   * The line Claude Code 2.1.220 actually prints: an OSC 8 hyperlink whose target is the URL,
   * immediately followed by the same URL as visible text — even under `NO_COLOR`. Left unstripped,
   * the two copies run together into one string that parses as neither.
   */
  test("reads the real OSC 8 hyperlink the CLI prints", () => {
    const observed = [
      "Opening browser to sign in\u2026\n",
      "If the browser didn't open, visit: ",
      `${ESC}]8;;${URL_LINE}${BEL}${URL_LINE}${ESC}]8;;${BEL}`,
      "\nPaste code here if prompted > ",
    ].join("")

    expect(findAuthorizeUrl(observed)).toBe(URL_LINE)
  })

  test("refuses a host Anthropic does not control", () => {
    expect(findAuthorizeUrl("https://claude.com.evil.example/oauth/authorize?state=s-1")).toBeNull()
  })

  test("strips the colour escapes a CLI wraps its output in", () => {
    expect(findAuthorizeUrl(`${ESC}[4m${URL_LINE}${ESC}[0m`)).toBe(URL_LINE)
  })

  test("drops the punctuation a sentence puts after a URL", () => {
    expect(findAuthorizeUrl(`Visit ${URL_LINE}.`)).toBe(URL_LINE)
    expect(findAuthorizeUrl(`Visit (${URL_LINE})`)).toBe(URL_LINE)
  })

  test("says nothing yet while there is no URL", () => {
    expect(findAuthorizeUrl("")).toBeNull()
    expect(findAuthorizeUrl("Starting login…\n")).toBeNull()
  })

  test("ignores a URL that is not an authorize endpoint", () => {
    expect(findAuthorizeUrl("https://claude.com/settings?state=s-1")).toBeNull()
    expect(findAuthorizeUrl("https://evil.example/oauth/authorize?state=s-1")).toBeNull()
  })

  /** A chunk boundary can land mid-escape, leaving an unstripped control byte after the URL. */
  test("stops a URL at a control byte rather than swallowing it", () => {
    expect(findAuthorizeUrl(`${URL_LINE}${ESC}]8;;`)).toBe(URL_LINE)
  })

  /** A chunked stream delivers half a URL first; matching it would bind the flow to a partial state. */
  test("waits for the state parameter before calling a URL complete", () => {
    const half = "https://claude.com/cai/oauth/authorize?code=true&client_id="
    expect(findAuthorizeUrl(half)).toBeNull()
    expect(findAuthorizeUrl(URL_LINE)).toBe(URL_LINE)
  })

  test("takes the first URL when the CLI prints more than one", () => {
    const second = "https://claude.com/cai/oauth/authorize?state=s-second"
    expect(findAuthorizeUrl(`${URL_LINE}\nor ${second}`)).toBe(URL_LINE)
  })
})

describe("reading the state out of a URL", () => {
  test("returns the CLI's own state", () => {
    expect(readState(URL_LINE)).toBe("s-9f2c1")
  })

  test("refuses a URL with no state, so an unbound flow cannot start", () => {
    expect(readState("https://claude.com/cai/oauth/authorize?client_id=abc")).toBeNull()
    expect(readState("https://claude.com/cai/oauth/authorize?state=")).toBeNull()
  })

  test("refuses something that is not a URL at all", () => {
    expect(readState("not a url")).toBeNull()
  })
})

describe("the pasted code#state", () => {
  test("splits the two halves", () => {
    expect(parsePastedCode("ac_123#s-9f2c1")).toEqual({ code: "ac_123", state: "s-9f2c1" })
  })

  test("tolerates the whitespace a copy-paste brings with it", () => {
    expect(parsePastedCode("  ac_123#s-9f2c1\n")).toEqual({ code: "ac_123", state: "s-9f2c1" })
  })

  test("refuses anything that is not exactly two non-empty halves", () => {
    expect(parsePastedCode("ac_123")).toBeNull()
    expect(parsePastedCode("#s-9f2c1")).toBeNull()
    expect(parsePastedCode("ac_123#")).toBeNull()
    expect(parsePastedCode("ac_123#s-1#s-2")).toBeNull()
    expect(parsePastedCode("   ")).toBeNull()
  })
})
