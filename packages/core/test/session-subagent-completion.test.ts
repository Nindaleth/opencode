import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { SubagentCompletion } from "@opencode/core/session/subagent-completion"
import { SessionMessage } from "@opencode/schema/session-message"
import { Model } from "@opencode/schema/model"
import { Agent } from "@opencode/schema/agent"

const now = DateTime.makeUnsafe(0)
const assistant = (text: string, completed = true) =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: Agent.ID.make("build"),
    model: Model.Ref.parse("test/model"),
    content: [{ type: "text", text }],
    time: { created: now, ...(completed ? { completed: now } : {}) },
  })
const synthetic = (text: string, metadata?: Record<string, unknown>) =>
  SessionMessage.Synthetic.make({
    id: SessionMessage.ID.create(),
    type: "synthetic",
    text,
    ...(metadata ? { metadata } : {}),
    time: { created: now },
  })

describe("SubagentCompletion.text", () => {
  test("preserves the latest completed answer and appends a tagged stop notice", () => {
    expect(
      SubagentCompletion.text([synthetic("limit reached", { notice: "step-gate" }), assistant("partial work")]),
    ).toBe("partial work\nlimit reached")
    expect(SubagentCompletion.text([synthetic("limit reached", { notice: "step-gate" })])).toBe("limit reached")
  })

  test("ignores ordinary synthetic messages and unfinished or failed assistants", () => {
    const failed = { ...assistant("broken"), error: { type: "aborted" as const, message: "failed" } }
    expect(
      SubagentCompletion.text([synthetic("ordinary"), assistant("unfinished", false), failed, assistant("completed")]),
    ).toBe("completed")
    expect(SubagentCompletion.text([synthetic("ordinary")])).toBe(SubagentCompletion.NO_TEXT)
    expect(SubagentCompletion.text([])).toBe(SubagentCompletion.NO_TEXT)
  })

  test("does not append an earlier stop notice to a later completed answer", () => {
    expect(SubagentCompletion.text([assistant("new response"), synthetic("old limit", { notice: "step-gate" })])).toBe(
      "new response",
    )
  })
})
