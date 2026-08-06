import { describe, expect, test } from "bun:test"
import type { FilePart } from "@opencode-ai/sdk/v2"
import { artifact, attached, downloadable, inline, kind, typeLabel } from "./message-file"

function file(part: Partial<FilePart> = {}): FilePart {
  return {
    id: "part_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "file",
    mime: "text/plain",
    url: "file:///repo/README.txt",
    filename: "README.txt",
    ...part,
  }
}

describe("message-file", () => {
  test("treats data URLs as attachments", () => {
    expect(attached(file({ url: "data:text/plain;base64,SGVsbG8=" }))).toBe(true)
    expect(attached(file())).toBe(false)
  })

  test("keeps data-backed file mentions inline", () => {
    expect(
      inline(
        file({
          source: {
            type: "file",
            path: "/repo/README.txt",
            text: { value: "@README.txt", start: 0, end: 11 },
          },
        }),
      ),
    ).toBe(true)

    const mentioned = file({
      url: "data:text/plain;base64,SGVsbG8=",
      source: {
        type: "file",
        path: "/repo/README.txt",
        text: { value: "@README.txt", start: 0, end: 11 },
      },
    })
    expect(inline(mentioned)).toBe(true)
    expect(attached(mentioned)).toBe(false)
  })

  test("recognizes only server artifact urls as downloadable artifacts", () => {
    expect(artifact(file({ url: "/session/ses_1/message/msg_1/part/prt_1/artifact" }))).toBe(true)
    expect(artifact(file({ url: "data:text/plain;base64,SGVsbG8=" }))).toBe(false)
    expect(artifact(file())).toBe(false)
    expect(artifact(file({ url: "/session/ses_1/message/msg_1/part/prt_1" }))).toBe(false)
    expect(artifact(file({ url: "https://example.com/session/a/artifact" }))).toBe(false)
  })

  // renderable() in message-part, partState() in session-turn and FilePartDisplay all
  // delegate the file-part visibility decision to downloadable(), so this is the contract
  // they enforce: only artifact urls become timeline rows, never data:/file:// user
  // attachments, and only when the host can resolve them to a fetchable href
  const resolve = (url: string) => `http://remote:4096${url}`

  test("gates file part visibility on the artifact url shape", () => {
    expect(downloadable(file({ url: "/session/ses_1/message/msg_1/part/prt_1/artifact" }), resolve)).toBe(true)
    expect(downloadable(file({ url: "data:text/plain;base64,SGVsbG8=" }), resolve)).toBe(false)
    expect(downloadable(file({ url: "file:///repo/README.txt" }), resolve)).toBe(false)
  })

  // a host with no resolver (the enterprise share viewer) would otherwise render a chip
  // pointing at its own origin, which is not the server that produced the artifact
  test("suppresses artifacts when the host supplies no href resolver", () => {
    expect(downloadable(file({ url: "/session/ses_1/message/msg_1/part/prt_1/artifact" }), undefined)).toBe(false)
  })

  test("separates image and file attachment kinds", () => {
    expect(kind(file({ mime: "image/png" }))).toBe("image")
    expect(kind(file({ mime: "application/pdf" }))).toBe("file")
  })

  test("labels attachment types from the basename extension", () => {
    expect(typeLabel("list.md", "text/plain", "File")).toBe("Markdown")
    expect(typeLabel("/repo/src/main.ts", "text/plain", "File")).toBe("TypeScript")
    expect(typeLabel("/tmp/report.pdf", "application/pdf", "File")).toBe("PDF")
    expect(typeLabel("notes.xyz", "text/plain", "File")).toBe("XYZ")
    expect(typeLabel("/home/user/my.project/Makefile", "text/plain", "File")).toBe("File")
    expect(typeLabel(".gitignore", "text/plain", "File")).toBe("File")
    expect(typeLabel("/repo/.env", "text/plain", "File")).toBe("File")
  })
})
