import { expect, test } from "bun:test"
import { artifactPresentation } from "./artifact-content"

const artifact = {
  type: "artifact" as const,
  key: "blob_report",
  name: "report.zip",
  mime: "application/zip",
  size: 2048,
}

test("web artifacts expose a filename, size, and download URL", () => {
  const presentation = artifactPresentation(
    artifact,
    "session",
    "assistant",
    (sessionID, messageID, key) => `/api/session/${sessionID}/message/${messageID}/artifact/${key}`,
  )
  expect(presentation).toEqual({
    name: "report.zip",
    size: "2 KB",
    href: "/api/session/session/message/assistant/artifact/blob_report",
  })
})

test("desktop artifacts have no download URL", () => {
  expect(artifactPresentation(artifact, "session", "assistant")).toEqual({
    name: "report.zip",
    size: "2 KB",
    href: undefined,
  })
})
