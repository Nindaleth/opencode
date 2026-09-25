import { expect, test } from "bun:test"
import { sessionArtifactUrl } from "./session-artifact-url"

test("builds an authenticated download URL on the selected server", () => {
  expect(
    sessionArtifactUrl({
      url: "https://example.test/base/",
      password: "secret",
      sessionID: "session/1",
      messageID: "message?1",
      key: "blob_1",
    }),
  ).toBe(
    "https://example.test/base/api/session/session%2F1/message/message%3F1/artifact/blob_1?auth_token=b3BlbmNvZGU6c2VjcmV0",
  )
})

test("keeps anonymous download URLs free of credentials", () => {
  expect(sessionArtifactUrl({ url: "http://localhost:4096", sessionID: "s", messageID: "m", key: "blob_1" })).toBe(
    "http://localhost:4096/api/session/s/message/m/artifact/blob_1",
  )
})
