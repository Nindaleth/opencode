import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/composer/state"
import { hasDraftContent } from "./draft"

const text = (content: string): Prompt => [{ type: "text", content, start: 0, end: content.length }]

describe("hasDraftContent", () => {
  test.each([
    { name: "an empty prompt", prompt: text(""), context: 0, editing: false, expected: false },
    { name: "no parts at all", prompt: [], context: 0, editing: false, expected: false },
    { name: "whitespace-only text", prompt: text("  \n"), context: 0, editing: false, expected: true },
    {
      name: "an attachment only",
      prompt: [{ type: "path", id: "att_1", filename: "log.txt", mime: "text/plain", path: "/tmp/log.txt" }],
      context: 0,
      editing: false,
      expected: true,
    },
    { name: "file context only", prompt: text(""), context: 1, editing: false, expected: true },
    { name: "an active queue edit", prompt: text(""), context: 0, editing: true, expected: true },
  ] satisfies { name: string; prompt: Prompt; context: number; editing: boolean; expected: boolean }[])(
    "$name",
    (row) => {
      expect(hasDraftContent({ prompt: row.prompt, context: row.context, editing: row.editing })).toBe(row.expected)
    },
  )
})
