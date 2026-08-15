import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory } from "./fixture/tui-sdk"

type SetupInput = {
  onReload?: () => Promise<void>
}

async function setupApp(input: SetupInput) {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch()
  let api!: TuiPluginApi
  let started!: () => void
  const ready = new Promise<void>((resolve) => (started = resolve))
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      url: "http://test",
      directory,
      config: createTuiResolvedConfig({ plugin_enabled: {} }),
      fetch: calls.fetch,
      events: events.source,
      args: {},
      onReload: input.onReload,
      pluginHost: {
        async start(value) {
          api = value.api
          started()
        },
        async dispose() {},
      },
    }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
  )
  await ready
  await setup.renderOnce()
  await setup.renderOnce()
  return {
    api,
    renderer: setup,
    task,
    async cleanup() {
      api.keymap.dispatchCommand("app.exit")
      await task
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      mock.restore()
    },
  }
}

test("registers /reload only when a local reload callback exists", async () => {
  const local = await setupApp({ onReload: async () => {} })
  try {
    const command = local.api.keymap
      .getCommandEntries({ visibility: "registered", namespace: "palette" })
      .find((entry) => entry.command.name === "opencode.reload")?.command
    expect(command?.slashName).toBe("reload")
  } finally {
    await local.cleanup()
  }

  const remote = await setupApp({})
  try {
    expect(
      remote.api.keymap
        .getCommandEntries({ visibility: "registered", namespace: "palette" })
        .some((entry) => entry.command.name === "opencode.reload"),
    ).toBe(false)
  } finally {
    await remote.cleanup()
  }
}, 10_000)

test("runs one reload at a time and reports success", async () => {
  let calls = 0
  let release!: () => void
  const pending = new Promise<void>((resolve) => (release = resolve))
  let finished!: () => void
  const done = new Promise<void>((resolve) => (finished = resolve))
  const app = await setupApp({
    onReload: async () => {
      calls++
      await pending
      finished()
    },
  })
  try {
    app.api.keymap.dispatchCommand("opencode.reload")
    app.api.keymap.dispatchCommand("opencode.reload")
    expect(calls).toBe(1)
    release()
    await done
    await app.renderer.renderOnce()
    expect(app.renderer.captureCharFrame()).toContain("Configuration reloaded")
  } finally {
    await app.cleanup()
  }
})

test("reports reload errors", async () => {
  let called!: () => void
  const done = new Promise<void>((resolve) => (called = resolve))
  const app = await setupApp({
    onReload: async () => {
      called()
      throw new Error("reload failed")
    },
  })
  try {
    app.api.keymap.dispatchCommand("opencode.reload")
    await done
    await Promise.resolve()
    await app.renderer.renderOnce()
    expect(app.renderer.captureCharFrame()).toContain("reload failed")
  } finally {
    await app.cleanup()
  }
})
