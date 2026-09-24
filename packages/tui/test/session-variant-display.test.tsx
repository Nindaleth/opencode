import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

const model = { providerID: "fixture", id: "sonnet", variant: "high" }
const parent = {
  id: "ses_parent_variant",
  title: "Parent",
  projectID: "proj_test",
  location: { directory },
  agent: "build",
  model,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
}
const child = {
  ...parent,
  id: "ses_child_variant",
  parentID: parent.id,
  title: "@explore subagent",
  agent: "explore",
  time: { created: 2, updated: 2 },
}

function render(state: string, sessionID: string, variant?: string) {
  const messages = [
    { id: "msg_user", type: "user", text: "Hello", time: { created: 10 } },
    {
      id: "msg_answer",
      type: "assistant",
      agent: sessionID === child.id ? "explore" : "build",
      model: { ...model, variant },
      content: [{ type: "text", text: "Answer" }],
      finish: "stop",
      time: { created: 11, streamed: 12, completed: 13 },
    },
  ]
  return createAppFixture({
    state,
    args: { sessionID },
    config: { animations: false, tabs: { mode: "off" } },
    fetch: (url) => {
      if (url.pathname === "/api/session") return json({ data: [parent, child], cursor: {} })
      if (url.pathname === `/api/session/${parent.id}`) return json({ data: parent })
      if (url.pathname === `/api/session/${child.id}`) return json({ data: child })
      if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: messages.toReversed(), cursor: {} })
      if (/^\/api\/session\/[^/]+\/(inbox|permission)$/.test(url.pathname)) return json({ data: [], cursor: {} })
      if (url.pathname === "/api/agent")
        return json({
          location: { directory },
          data: [
            { id: "build", mode: "primary", hidden: false, permissions: [] },
            { id: "explore", mode: "subagent", hidden: false, permissions: [] },
          ],
        })
      if (url.pathname === "/api/model")
        return json({
          location: { directory },
          data: [{ id: "sonnet", providerID: "fixture", name: "Sonnet", variants: [{ id: "high" }] }],
        })
    },
  })
}

test("completed assistant footer shows its recorded variant", async () => {
  await using state = await tmpdir()
  await using setup = await render(state.path, parent.id, "high")
  const frame = await setup.waitForFrame((frame) => frame.includes("Answer") && frame.includes("Sonnet"))
  expect(frame).toMatch(/Build · Sonnet · high/)
})

test("assistant footer omits the variant when the message has none", async () => {
  await using state = await tmpdir()
  await using setup = await render(state.path, parent.id)
  const frame = await setup.waitForFrame((frame) => frame.includes("Answer") && frame.includes("Sonnet"))
  expect(frame).toMatch(/Build · Sonnet/)
  expect(frame).not.toMatch(/Build · Sonnet · high/)
})

test("subagent view shows its session variant alongside its footer controls", async () => {
  await using state = await tmpdir()
  await using setup = await render(state.path, child.id, "high")
  const frame = await setup.waitForFrame((frame) => frame.includes("Answer") && frame.includes("Subagents"))
  expect(frame).toMatch(/Explore · Sonnet · high/)
  expect(frame).toMatch(/Explore · high/)
})
