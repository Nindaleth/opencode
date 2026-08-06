import { describe, expect, test } from "bun:test"
import { SessionTools } from "@/session/tools"

const limits = { maxBytes: 10 * 1024 * 1024 }
const base64 = (text: string) => Buffer.from(text).toString("base64")

describe("SessionTools.classifyMcpContent", () => {
  test("keeps text content as text", () => {
    const result = SessionTools.classifyMcpContent([{ type: "text", text: "hello" }], limits)

    expect(result.text).toEqual(["hello"])
    expect(result.attachments).toEqual([])
    expect(result.artifacts).toEqual([])
  })

  test("images go to both the model and the download store", () => {
    const result = SessionTools.classifyMcpContent(
      [{ type: "image", mimeType: "image/png", data: base64("png-bytes") }],
      limits,
    )

    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0].mime).toBe("image/png")
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0].mime).toBe("image/png")
  })

  test("whitelisted resource blobs go to both", () => {
    const result = SessionTools.classifyMcpContent(
      [
        {
          type: "resource",
          resource: { uri: "file:///tmp/report.pdf", mimeType: "application/pdf", blob: base64("pdf") },
        },
      ],
      limits,
    )

    expect(result.attachments).toHaveLength(1)
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0].filename).toBe("report.pdf")
  })

  test("non-whitelisted blobs become download-only artifacts with a note", () => {
    const result = SessionTools.classifyMcpContent(
      [
        {
          type: "resource",
          resource: { uri: "file:///tmp/bundle.zip", mimeType: "application/zip", blob: base64("zip") },
        },
      ],
      limits,
    )

    expect(result.attachments).toEqual([])
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts[0].mime).toBe("application/zip")
    expect(result.artifacts[0].filename).toBe("bundle.zip")
    expect(result.text.join("")).toContain("bundle.zip")
    expect(result.text.join("")).toContain("download")
  })

  test("oversized blobs are dropped entirely with a note", () => {
    const result = SessionTools.classifyMcpContent(
      [
        {
          type: "resource",
          resource: { uri: "file:///tmp/huge.zip", mimeType: "application/zip", blob: base64("x".repeat(64)) },
        },
      ],
      { maxBytes: 8 },
    )

    expect(result.attachments).toEqual([])
    expect(result.artifacts).toEqual([])
    expect(result.text.join("")).toContain("exceeds")
  })

  test("resource text is preserved alongside a blob", () => {
    const result = SessionTools.classifyMcpContent(
      [
        {
          type: "resource",
          resource: {
            uri: "file:///tmp/notes.zip",
            mimeType: "application/zip",
            text: "summary line",
            blob: base64("zip"),
          },
        },
      ],
      limits,
    )

    expect(result.text[0]).toBe("summary line")
    expect(result.artifacts).toHaveLength(1)
  })

  test("falls back to a generated filename when the uri has no basename", () => {
    const result = SessionTools.classifyMcpContent(
      [{ type: "image", mimeType: "image/png", data: base64("png") }],
      limits,
    )

    expect(result.artifacts[0].filename).toMatch(/\.png$/)
  })

  test("strips path separators and control characters from filenames", () => {
    const result = SessionTools.classifyMcpContent(
      [
        {
          type: "resource",
          resource: {
            uri: "../../etc/pa\u0000sswd.zip",
            mimeType: "application/zip",
            blob: base64("zip"),
          },
        },
      ],
      limits,
    )

    expect(result.artifacts[0].filename).not.toContain("/")
    expect(result.artifacts[0].filename).not.toContain("..")
    expect(result.artifacts[0].filename).not.toContain("\u0000")
  })

  test("resource.name wins over the uri basename", () => {
    const result = SessionTools.classifyMcpContent(
      [
        {
          type: "resource",
          resource: {
            uri: "mcp://tool/abc123",
            name: "Q3 report.pdf",
            mimeType: "application/pdf",
            blob: base64("pdf"),
          },
        },
      ],
      limits,
    )

    expect(result.artifacts[0].filename).toBe("Q3 report.pdf")
  })

  test("a resource.name that sanitizes to empty falls back to the uri basename", () => {
    const result = SessionTools.classifyMcpContent(
      [
        {
          type: "resource",
          resource: {
            uri: "mcp://tool/abc123.pdf",
            name: "..",
            mimeType: "application/pdf",
            blob: base64("pdf"),
          },
        },
      ],
      limits,
    )

    expect(result.artifacts[0].filename).toBe("abc123.pdf")
  })

  test("an unknown resource mime yields a generated .bin filename", () => {
    const result = SessionTools.classifyMcpContent(
      [
        {
          type: "resource",
          resource: { uri: "mcp://tool/", mimeType: "application/x-unknown-thing", blob: base64("blob") },
        },
      ],
      limits,
    )

    expect(result.artifacts[0].filename).toBe("artifact-1.bin")
  })

  test("an oversized image is dropped from both sinks with a note", () => {
    const result = SessionTools.classifyMcpContent([{ type: "image", mimeType: "image/png", data: "A".repeat(2048) }], {
      maxBytes: 512,
    })

    expect(result.attachments).toEqual([])
    expect(result.artifacts).toEqual([])
    expect(result.text).toHaveLength(1)
    expect(result.text[0]).toContain("exceeds")
  })

  test("a resource mime containing crlf falls back to application/octet-stream", () => {
    const result = SessionTools.classifyMcpContent(
      [
        {
          type: "resource",
          resource: {
            uri: "mcp://tool/thing.bin",
            mimeType: "application/pdf\r\nx-injected: 1",
            blob: base64("blob"),
          },
        },
      ],
      limits,
    )

    expect(result.artifacts[0].mime).toBe("application/octet-stream")
    expect(result.attachments).toEqual([])
  })

  test("a junk resource mime falls back to application/octet-stream", () => {
    const result = SessionTools.classifyMcpContent(
      [
        {
          type: "resource",
          resource: { uri: "mcp://tool/thing.bin", mimeType: "not a mime type at all", blob: base64("blob") },
        },
      ],
      limits,
    )

    expect(result.artifacts[0].mime).toBe("application/octet-stream")
  })

  test("an image mime containing crlf falls back to application/octet-stream", () => {
    const result = SessionTools.classifyMcpContent(
      [{ type: "image", mimeType: "image/png\r\nx-injected: 1", data: base64("png") }],
      limits,
    )

    expect(result.artifacts[0].mime).toBe("application/octet-stream")
    expect(result.attachments[0].mime).toBe("application/octet-stream")
    expect(result.attachments[0].url).not.toContain("\r")
  })

  test("a junk image mime falls back to application/octet-stream", () => {
    const result = SessionTools.classifyMcpContent(
      [{ type: "image", mimeType: "image/png; charset=<script>", data: base64("png") }],
      limits,
    )

    expect(result.artifacts[0].mime).toBe("application/octet-stream")
    expect(result.attachments[0].mime).toBe("application/octet-stream")
  })
})
