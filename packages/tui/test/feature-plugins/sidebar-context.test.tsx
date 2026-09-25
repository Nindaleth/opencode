/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"
import { SidebarContext } from "../../src/feature-plugins/sidebar/context"

function context(options?: {
  cost?: number
  tokens?: number
  descendants?: { id: string; parentID: string; cost: number }[]
}) {
  const color = RGBA.fromInts(200, 200, 200)
  const session = { id: "session", cost: options?.cost ?? 0, location: { directory: "/workspace" } }
  return {
    theme: { text: { base: color, muted: color } },
    data: {
      session: {
        get: () => session,
        list: () => [session, ...(options?.descendants ?? [])],
        cost: () => options?.cost ?? 0,
        message: {
          list: () =>
            options?.tokens
              ? [
                  {
                    id: "message",
                    type: "assistant",
                    model: { providerID: "provider", id: "model" },
                    tokens: {
                      input: options.tokens,
                      output: 0,
                      reasoning: 0,
                      cache: { read: 0, write: 0 },
                    },
                  },
                ]
              : [],
        },
      },
      location: {
        model: { list: () => [] },
      },
    },
  } as unknown as Context
}

test("sidebar omits context before usage is available", async () => {
  const app = await testRender(() => <SidebarContext context={context()} sessionID="session" />, {
    width: 42,
    height: 8,
  })

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Context")
    expect(app.captureCharFrame()).not.toContain("Not measured")
  } finally {
    app.renderer.destroy()
  }
})

test("sidebar includes nested delegated costs and task count", async () => {
  const app = await testRender(
    () => (
      <SidebarContext
        context={context({
          cost: 0.37,
          descendants: [
            { id: "child", parentID: "session", cost: 0.4 },
            { id: "grandchild", parentID: "child", cost: 0.65 },
          ],
        })}
        sessionID="session"
      />
    ),
    { width: 70, height: 8 },
  )

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("$1.42 ($0.37 + $1.05 by 2 tasks) spent")
  } finally {
    app.renderer.destroy()
  }
})

test("sidebar shows a zero-cost task without token usage", async () => {
  const app = await testRender(
    () => (
      <SidebarContext
        context={context({ descendants: [{ id: "child", parentID: "session", cost: 0 }] })}
        sessionID="session"
      />
    ),
    { width: 70, height: 8 },
  )

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Context")
    expect(app.captureCharFrame()).toContain("$0.00 ($0.00 + $0.00 by 1 task) spent")
  } finally {
    app.renderer.destroy()
  }
})

test("sidebar shows available context usage", async () => {
  const app = await testRender(() => <SidebarContext context={context({ tokens: 1234 })} sessionID="session" />, {
    width: 42,
    height: 8,
  })

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Context")
    expect(app.captureCharFrame()).toContain("1,234 tokens")
  } finally {
    app.renderer.destroy()
  }
})
