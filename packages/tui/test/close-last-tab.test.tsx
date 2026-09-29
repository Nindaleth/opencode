import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

const location = { directory, project: { id: "project", directory, canonical: directory } }
const session = {
  id: "ses_close",
  title: "Session to close",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "provider", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

function render(state: string, sessionID?: string) {
  return createAppFixture({
    state,
    args: sessionID ? { sessionID } : {},
    config: { animations: false, tabs: { mode: "on" } },
    fetch: (url) => {
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }] })
    },
  })
}

function closeTab(setup: Awaited<ReturnType<typeof render>>) {
  setup.mockInput.pressKey("x", { ctrl: true })
  setup.mockInput.pressKey("w")
}

test("Closing the last session tab exits the TUI", async () => {
  await using state = await tmpdir()
  await using setup = await render(state.path, session.id)

  await setup.waitForFrame((frame) => frame.includes("Session to close"))
  closeTab(setup)
  await Promise.race([new Promise<void>((resolve) => setup.renderer.once("destroy", resolve)), Bun.sleep(1000)])

  expect(setup.renderer.isDestroyed).toBe(true)
})

test("Closing an empty new-session tab exits the TUI", async () => {
  await using state = await tmpdir()
  await using setup = await render(state.path)

  await setup.waitForFrame((frame) => frame.includes("Ask anything"))
  closeTab(setup)
  await Promise.race([new Promise<void>((resolve) => setup.renderer.once("destroy", resolve)), Bun.sleep(1000)])

  expect(setup.renderer.isDestroyed).toBe(true)
})

test("Closing a session tab with a new-session tab open keeps the TUI running", async () => {
  await using state = await tmpdir()
  await using setup = await render(state.path, session.id)

  await setup.waitForFrame((frame) => frame.includes("Session to close"))
  await setup.mockInput.typeText("/new")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("New session") && frame.includes("Session to close"))
  closeTab(setup)
  const frame = await setup.waitForFrame(
    (frame) => !frame.includes("New session") && frame.includes("Session to close"),
  )

  expect(frame).toContain("Session to close")
  expect(setup.renderer.isDestroyed).toBe(false)
})
