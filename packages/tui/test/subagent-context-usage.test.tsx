import { expect, test } from "bun:test"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

const model = { providerID: "fixture", id: "subagent-model" }
const parent: SessionInfo = {
  id: "ses_usage_parent",
  title: "Parent",
  projectID: "proj_test",
  location: { directory },
  agent: "build",
  model: { providerID: "fixture", id: "parent-model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
}
const child: SessionInfo = {
  ...parent,
  id: "ses_usage_child",
  parentID: parent.id,
  title: "Inspect usage",
  agent: "explore",
  model,
}

function render(input: { running?: boolean; width?: number; usage?: boolean; context?: number; tool?: boolean } = {}) {
  const messages: SessionMessageInfo[] = [
    { id: "msg_user", type: "user", text: "Delegate", time: { created: 10 } },
    {
      id: "msg_parent",
      type: "assistant",
      agent: "build",
      model: parent.model!,
      content: [
        {
          id: "tool_subagent",
          type: "tool",
          name: "subagent",
          state: {
            status: input.running ? "running" : "completed",
            input: { agent: "explore", description: "Inspect usage" },
            metadata: { sessionID: child.id },
            content: [{ type: "text", text: "Done" }],
          },
          time: { created: 11 },
        },
      ],
      time: { created: 11 },
    },
  ]
  const childMessages: SessionMessageInfo[] = [
    {
      id: "msg_child",
      type: "assistant",
      agent: "explore",
      model,
      content: [{ type: "text", text: "Child answer" }],
      tokens:
        input.usage === false
          ? undefined
          : { input: 10000, output: 1000, reasoning: 500, cache: { read: 8000, write: 500 } },
      time: { created: 12, completed: 13 },
    },
  ]
  return createAppFixture({
    width: input.width,
    args: { sessionID: parent.id },
    config: { animations: false, tabs: { mode: "off" } },
    fetch: (url) => {
      if (url.pathname === "/api/session") return json({ data: [parent, child], cursor: {} })
      if (url.pathname === "/api/session/active") return json({ data: input.running ? { [child.id]: "running" } : {} })
      if (url.pathname === `/api/session/${parent.id}`) return json({ data: parent })
      if (url.pathname === `/api/session/${child.id}`) return json({ data: child })
      if (url.pathname === `/api/session/${parent.id}/message`)
        return json({ data: (input.tool === false ? messages.slice(0, 1) : messages).toReversed(), cursor: {} })
      if (url.pathname === `/api/session/${child.id}/message`)
        return json({ data: childMessages.toReversed(), cursor: {} })
      if (/^\/api\/session\/[^/]+\/inbox$/.test(url.pathname)) return json({ data: [], cursor: {} })
      if (url.pathname === "/api/model")
        return json({
          location: { directory },
          data: [
            { ...parent.model, name: "Parent model", limit: { context: 200000, output: 10000 } },
            { ...model, name: "Subagent model", limit: { context: input.context ?? 100000, output: 10000 } },
          ],
        })
    },
  })
}

test.each([
  { running: true, width: 100 },
  { running: false, width: 100 },
  { running: true, width: 44 },
  { running: false, width: 44 },
])("subagent context is visible without visiting the child: %j", async (input) => {
  // Subagents omitted context usage in both the transcript and active/inactive picker.
  await using setup = await render(input)
  const transcript = await setup.waitForFrame((frame) => frame.includes("20.0K (20%)"), { maxPasses: 120 })
  expect(transcript).toContain("Inspect usage")

  setup.mockInput.pressArrow("down")
  await setup.waitForFrame((frame) => frame.includes("Subagents"))
  if (!input.running) setup.mockInput.pressKey("a", { ctrl: true })
  const frame = await setup.waitForFrame(
    (frame) => frame.includes("Subagents") && frame.slice(frame.indexOf("Subagents")).includes("Expl"),
  )
  expect(frame.slice(frame.indexOf("Subagents"))).toContain("20.0K (20%)")
})

test("the subagent picker loads usage independently of transcript tool rows", async () => {
  await using setup = await render({ running: true, tool: false })
  await setup.waitForFrame((frame) => frame.includes("Delegate"), { maxPasses: 120 })
  setup.mockInput.pressArrow("down")
  const frame = await setup.waitForFrame(
    (frame) => frame.includes("Subagents") && frame.slice(frame.indexOf("Subagents")).includes("20.0K (20%)"),
    { maxPasses: 120 },
  )
  expect(frame).toContain("Explore: Inspect usage")
})

test("subagent context updates during execution and remains after completion", async () => {
  await using setup = await render({ running: true })
  await setup.waitForFrame((frame) => frame.includes("20.0K (20%)"), { maxPasses: 120 })
  setup.mockInput.pressArrow("down")
  await setup.waitForFrame((frame) => frame.includes("Explore:"))

  setup.events.emit({
    id: "evt_usage",
    type: "session.step.ended",
    durable: { aggregateID: child.id, seq: 1, version: 1 },
    created: 20,
    data: {
      sessionID: child.id,
      assistantMessageID: "msg_child",
      finish: "stop",
      cost: 0,
      tokens: { input: 25000, output: 1000, reasoning: 500, cache: { read: 8000, write: 500 } },
    },
  })
  const active = await setup.waitForFrame((frame) => frame.split("35.0K (35%)").length === 3)
  expect(active.split("\n").find((line) => line.includes("Explore:"))).toContain("35.0K (35%)")

  setup.events.emit({
    id: "evt_done",
    type: "session.execution.succeeded",
    durable: { aggregateID: child.id, seq: 2, version: 1 },
    created: 21,
    data: { sessionID: child.id },
  })
  await setup.waitForFrame((frame) => frame.includes("No active subagents"))
  setup.mockInput.pressKey("a", { ctrl: true })
  const completed = await setup.waitForFrame((frame) => frame.includes("Explore:"))
  expect(completed.split("\n").find((line) => line.includes("Explore:"))).toContain("35.0K (35%)")
})

test("subagent context omits percentage when the model has no context limit", async () => {
  await using setup = await render({ context: 0 })
  await setup.waitForFrame((frame) => frame.includes("20.0K"))
  await setup.waitForVisualIdle()
  expect(setup.captureCharFrame()).toContain("20.0K")
  expect(setup.captureCharFrame()).not.toContain("(20%)")
  setup.mockInput.pressArrow("down")
  await setup.waitForFrame((frame) => frame.includes("Subagents"))
  setup.mockInput.pressKey("a", { ctrl: true })
  const frame = await setup.waitForFrame((frame) => frame.includes("Explore:"))
  expect(frame.split("\n").find((line) => line.includes("Explore:"))).toContain("20.0K")
  expect(frame.split("Subagents")[1]).not.toContain("%")
})

test("subagents do not invent usage before the first report", async () => {
  await using setup = await render({ running: true, usage: false })
  await setup.waitForFrame((frame) => frame.includes("Inspect usage"))
  await setup.waitForVisualIdle()
  expect(setup.captureCharFrame()).not.toContain("K (")
  expect(setup.captureCharFrame()).not.toContain("(0%)")
  setup.mockInput.pressArrow("down")
  const frame = await setup.waitForFrame((frame) => frame.includes("Explore:"))
  expect(frame.split("\n").find((line) => line.includes("Explore:"))).toContain("Running")
  expect(frame.split("Subagents")[1]).not.toContain("K (")
  expect(frame.split("Subagents")[1]).not.toContain("(0%)")
})
