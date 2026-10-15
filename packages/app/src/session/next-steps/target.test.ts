import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { nextStepsTarget } from "./target"

const user = { id: "msg_user", type: "user", text: "Fix the bug", time: { created: 1 } } satisfies SessionMessageInfo

const assistant = (id: string, content: Extract<SessionMessageInfo, { type: "assistant" }>["content"]) =>
  ({
    id,
    type: "assistant",
    agent: "build",
    model: { id: "model", providerID: "provider" },
    content,
    time: { created: 2, completed: 3 },
  }) satisfies SessionMessageInfo

const reply = assistant("msg_reply", [{ type: "text", text: "Fixed it." }])

const idle = (outcome: "succeeded" | "failed" | "interrupted") =>
  ({ id: "msg_idle", type: "idle", outcome, time: { created: 4 } }) satisfies SessionMessageInfo

const tool = assistant("msg_tool", [
  {
    type: "tool",
    id: "tool_read",
    name: "read",
    state: { status: "completed", input: {}, content: [{ type: "text", text: "file" }], metadata: {} },
    time: { created: 3, completed: 3 },
  },
])

const base = { sessionID: "ses_1", running: false, pending: 0, blocked: false }
const target = { sessionID: "ses_1", messageID: "msg_reply", idleID: "msg_idle" }

describe("nextStepsTarget", () => {
  test.each([
    ["an eligible successful reply", { messages: [user, reply, idle("succeeded")] }, target],
    ["a running session", { messages: [user, reply, idle("succeeded")], running: true }, undefined],
    ["a pending inbox item", { messages: [user, reply, idle("succeeded")], pending: 1 }, undefined],
    ["a blocked session", { messages: [user, reply, idle("succeeded")], blocked: true }, undefined],
    ["a failed execution", { messages: [user, reply, idle("failed")] }, undefined],
    ["an interrupted execution", { messages: [user, reply, idle("interrupted")] }, undefined],
    [
      "a user message after the idle",
      { messages: [user, reply, idle("succeeded"), { ...user, id: "msg_next" }] },
      undefined,
    ],
    ["a tool-only final assistant", { messages: [user, reply, tool, idle("succeeded")] }, undefined],
    [
      "an assistant with an error",
      {
        messages: [user, { ...reply, error: { type: "unknown", message: "boom" } }, idle("succeeded")],
      },
      undefined,
    ],
    ["an incomplete assistant", { messages: [user, { ...reply, time: { created: 2 } }, idle("succeeded")] }, undefined],
    [
      "an assistant from an earlier execution",
      { messages: [user, reply, { ...idle("succeeded"), id: "msg_old_idle" }, idle("succeeded")] },
      undefined,
    ],
    ["an empty session", { messages: [] }, undefined],
  ] satisfies [
    string,
    { messages: SessionMessageInfo[]; running?: boolean; pending?: number; blocked?: boolean },
    unknown,
  ][])("%s", (_, input, expected) => {
    expect(nextStepsTarget({ ...base, ...input })).toEqual(expected)
  })
})
