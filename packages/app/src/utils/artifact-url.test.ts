import { describe, expect, test } from "bun:test"
import { artifactUrl } from "./artifact-url"

const path = "/session/ses_1/message/msg_1/part/prt_1/artifact"

describe("artifactUrl", () => {
  test("resolves the relative path against the server base url", () => {
    expect(artifactUrl({ url: "http://remote:4096" }, path)).toBe(`http://remote:4096${path}`)
  })

  test("omits auth_token when no password is configured", () => {
    expect(new URL(artifactUrl({ url: "http://remote:4096" }, path)).searchParams.has("auth_token")).toBe(false)
  })

  test("attaches auth_token when a password is configured", () => {
    const url = new URL(artifactUrl({ url: "http://remote:4096", password: "secret" }, path))
    expect(url.searchParams.get("auth_token")).toBe(btoa("opencode:secret"))
  })

  test("uses the configured username in the token", () => {
    const url = new URL(artifactUrl({ url: "http://remote:4096", username: "me", password: "secret" }, path))
    expect(url.searchParams.get("auth_token")).toBe(btoa("me:secret"))
  })

  test("keeps a base url path prefix", () => {
    expect(artifactUrl({ url: "http://remote:4096/proxy/" }, path)).toBe(`http://remote:4096/proxy${path}`)
  })

  test("keeps a base url path prefix without a trailing slash", () => {
    expect(artifactUrl({ url: "http://remote:4096/proxy" }, path)).toBe(`http://remote:4096/proxy${path}`)
  })
})
