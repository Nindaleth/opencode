import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

it.live("previews the selected location's prompt without creating a session", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-debug-prompt-")))
    yield* Effect.promise(() =>
      Bun.write(
        `${tmp.path}/opencode.json`,
        JSON.stringify({
          providers: {
            custom: {
              package: "aisdk:@ai-sdk/openai-compatible",
              settings: { apiKey: "secret", baseURL: "https://example.test/v1" },
              models: { chat: {} },
            },
          },
          model: "custom/chat",
          agents: { reviewer: { mode: "primary", system: "reviewer system" } },
          plugins: [
            {
              package: "prompt-overrides",
              options: { model: { text: "preview base" }, tool: { read: { text: "preview read" } } },
            },
          ],
        }),
      ),
    )
    const server = yield* startServer(tmp.path)
    const url = new URL("/api/debug/prompt", server.base)
    url.searchParams.set("location[directory]", tmp.path)
    const request = (query: { provider?: string; model?: string; agent?: string } = {}) => {
      const selected = new URL(url)
      Object.entries(query).forEach(([key, value]) => {
        if (value !== undefined) selected.searchParams.set(key, value)
      })
      return Effect.promise(() => fetch(selected, { headers: server.headers }))
    }
    const response = yield* request()
    const preview = yield* Effect.promise(() => response.json())
    expect(response.status).toBe(200)
    expect(preview.selection).toEqual({ provider: "custom", model: "chat", agent: "build" })
    expect(preview.system[0]).toContain("preview base")
    expect(preview.tools).toContainEqual({ name: "read", description: "preview read" })
    const explicit = yield* request({ provider: "custom", model: "chat", agent: "build" })
    expect(explicit.status).toBe(200)
    const selected = yield* Effect.promise(() => explicit.json())
    expect(selected.selection).toEqual(preview.selection)
    expect(selected.system[0]).toEqual(preview.system[0])
    expect(selected.tools).toEqual(preview.tools)
    const reviewer = yield* request({ agent: "reviewer", provider: "custom", model: "chat" })
    expect(reviewer.status).toBe(200)
    expect((yield* Effect.promise(() => reviewer.json())).system[0]).toBe("reviewer system")
    for (const query of [{ provider: "custom" }, { agent: "missing" }, { provider: "custom", model: "missing" }]) {
      const invalid = yield* request(query)
      expect(invalid.status).toBe(400)
    }
    const sessions = yield* Effect.promise(() =>
      fetch(new URL("/api/session", server.base), { headers: server.headers }),
    )
    expect(sessions.status).toBe(200)
    expect((yield* Effect.promise(() => sessions.json())).data).toEqual([])
  }),
)
