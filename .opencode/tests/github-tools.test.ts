import assert from "node:assert/strict"
import path from "node:path"
import { it } from "node:test"
import { Effect } from "@opencode/plugin"
import { Host } from "@opencode/plugin/host"
import { Agent } from "../../packages/core/src/agent.ts"
import { Plugin } from "../../packages/core/src/plugin.ts"
import { PluginHost } from "../../packages/core/src/plugin/host.ts"
import { PluginPromise } from "../../packages/core/src/plugin/promise.ts"
import { Tool } from "../../packages/core/src/tool.ts"
import { Session } from "../../packages/schema/src/session.ts"
import { SessionMessage } from "../../packages/schema/src/session-message.ts"
import { testEffect } from "../../packages/core/test/lib/effect.ts"
import { PluginTestLayer } from "../../packages/core/test/plugin/fixture.ts"
import { discoverPluginTargets } from "../../packages/tui/src/plugin/discovery.ts"

const test = testEffect(PluginTestLayer)

test.effect("v1 GitHub tools broke v2 prompt loading; both register as direct v2 tools", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const registry = yield* Tool.Service
    const { default: plugin } = yield* Effect.promise(() => import("../plugins/github-tools/index.ts"))
    yield* PluginPromise.fromPromise(plugin).effect(yield* PluginHost.make(plugins))
    const registered = yield* registry.list()
    assert.deepEqual(
      registered.filter((tool) => tool.name.startsWith("github-")).map((tool) => tool.options?.codemode),
      [false, false],
    )
    const snapshot = yield* registry.snapshot()
    assert.deepEqual(
      snapshot.definitions.filter((tool) => tool.name.startsWith("github-")).map((tool) => tool.name),
      ["github-pr-search", "github-triage"],
    )
    assert.deepEqual(snapshot.definitions.find((tool) => tool.name === "github-pr-search")?.inputSchema.required, [
      "query",
    ])
    const invalid = yield* snapshot
      .execute({
        sessionID: Session.ID.make("ses_github_tools"),
        agent: Agent.ID.make("triage"),
        messageID: SessionMessage.ID.make("msg_github_tools"),
        call: { type: "tool-call", id: "call_github_tools", name: "github-triage", input: { team: "unknown" } },
      })
      .pipe(Effect.flip)
    assert.match(invalid.message, /Invalid arguments for tool "github-triage"/)
    const search = yield* snapshot
      .execute({
        sessionID: Session.ID.make("ses_github_tools"),
        agent: Agent.ID.make("duplicate-pr"),
        messageID: SessionMessage.ID.make("msg_github_tools"),
        call: { type: "tool-call", id: "call_github_search", name: "github-pr-search", input: {} },
      })
      .pipe(Effect.flip)
    assert.match(search.message, /Invalid arguments for tool "github-pr-search"/)
  }),
)

it("v2 discovers the GitHub tools plugin and its server entrypoint", async () => {
  const directory = path.resolve(import.meta.dir, "../plugins")
  const targets = await discoverPluginTargets([directory])
  assert.ok(targets.includes(path.join(directory, "github-tools")))
  assert.ok(Host.resolve({ directory: path.join(directory, "github-tools") }).server)
})
