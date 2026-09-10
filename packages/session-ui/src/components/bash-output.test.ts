import { describe, expect, test } from "bun:test"
import { bashOutput } from "./bash-output"

describe("bashOutput", () => {
  test("joins completed V2 bash text content in order", () => {
    expect(
      bashOutput({
        tool: "bash",
        state: {
          status: "completed",
          content: [
            { type: "text", text: "Thu Sep 10 14:06:18 CEST 2026" },
            { type: "text", text: "Command exited with code 0." },
          ],
        },
      }),
    ).toBe("Thu Sep 10 14:06:18 CEST 2026\nCommand exited with code 0.")
  })

  test("keeps legacy output unchanged", () => {
    expect(
      bashOutput({
        tool: "bash",
        state: { status: "completed", output: "legacy output", content: [{ type: "text", text: "ignored" }] },
      }),
    ).toBe("legacy output")
  })

  test("does not project V2 text for another tool", () => {
    expect(
      bashOutput({
        tool: "read",
        state: { status: "completed", content: [{ type: "text", text: "not shell output" }] },
      }),
    ).toBeUndefined()
  })
})
