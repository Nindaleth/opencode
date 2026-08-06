import { describe, expect, mock, test } from "bun:test"
import type { SessionMessageAssistantTool, SessionMessageInfo } from "@opencode-ai/client/promise"
import { normalizeSessionMessages } from "@/utils/session-message"

// Vite-only specifier that bun cannot resolve; stubbing it lets ./rows import in a bun test.
mock.module("../../../../../session-ui/src/components/markdown.worker.ts?worker&url", () => ({ default: "" }))

const { Timeline, TimelineRow } = await import("./rows")

const tool = (
  id: string,
  name: string,
  input: Record<string, string>,
  created: number,
): SessionMessageAssistantTool => ({
  type: "tool",
  id,
  name,
  state: {
    status: "completed",
    input,
    content: [{ type: "text", text: "output" }],
  },
  time: { created, completed: created + 1 },
})

// read and grep merge into one context group row while bash stays standalone, so hiding tool
// calls has to collapse a grouped row and a standalone row alike.
const source = [
  { id: "msg_user", type: "user", text: "go", time: { created: 1 } },
  {
    id: "msg_assistant",
    type: "assistant",
    agent: "build",
    model: { id: "model", providerID: "provider" },
    content: [
      { type: "text", text: "starting" },
      tool("tool_read", "read", { filePath: "a.ts" }, 2),
      tool("tool_grep", "grep", { pattern: "x" }, 3),
      tool("tool_bash", "bash", { command: "ls" }, 4),
      { type: "text", text: "done" },
    ],
    time: { created: 2, completed: 9 },
  },
] satisfies SessionMessageInfo[]

// Row keys embed part IDs, but how many rows those parts occupy depends on how groupParts
// arranges them. A sibling test file installs a process-global mock.module for message-part, so
// assert on row tags and part-ID presence rather than on exact key strings.
const summary = (showToolCalls: boolean, status: "busy" | "idle") => {
  const normalized = normalizeSessionMessages("ses_1", source)
  const messages = new Map(normalized.messages.map((message) => [message.id, message]))
  const rows = Timeline.constructSessionMessageRows(
    source,
    (messageID) => messages.get(messageID),
    (messageID) => normalized.parts.get(messageID) ?? [],
    normalized.messages.filter((message) => message.role === "user"),
    {
      showReasoning: true,
      showToolCalls,
      showFileDownloads: true,
      status,
      inlineComments: true,
      artifactHref: undefined,
    },
  ).rows
  const keys = rows.map(TimelineRow.key)
  return {
    tags: rows.map((row) => row._tag),
    toolRows: keys.filter((key) => ["tool_read", "tool_grep", "tool_bash"].some((id) => key.includes(id))).length,
    textRows: keys.filter((key) => /:text:\d+$/.test(key)).length,
  }
}

describe("timeline tool call visibility", () => {
  test("keeps tool rows when tool calls are shown", () => {
    const shown = summary(true, "idle")
    expect(shown.toolRows).toBeGreaterThan(0)
    expect(shown.textRows).toBe(2)
    expect(shown.tags.filter((tag) => tag === "AssistantPart").length).toBeGreaterThan(2)
  })

  test("drops every tool row and collapses context groups when tool calls are hidden", () => {
    expect(summary(false, "idle")).toEqual({
      tags: ["UserMessage", "AssistantPart", "AssistantPart"],
      toolRows: 0,
      textRows: 2,
    })
  })

  test("shows the thinking row while busy even though text parts are visible", () => {
    expect(summary(false, "busy").tags).toEqual(["UserMessage", "AssistantPart", "AssistantPart", "Thinking"])
  })

  test("omits the thinking row while busy when tool calls are visible", () => {
    expect(summary(true, "busy").tags).not.toContain("Thinking")
  })
})
