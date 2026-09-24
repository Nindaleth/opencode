import { expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Agent } from "@opencode/core/agent"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/schema/session"
import { fromPromise } from "@opencode/plugin/promise/adapter"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

for (const scenario of [
  { pluginID: "opencode-dcp", preview: true, instructions: [] },
  { pluginID: "opencode-dcp", preview: false, instructions: ["Plugin instructions"] },
  { pluginID: "opencode-dcp", preview: undefined, instructions: ["Plugin instructions"] },
  { pluginID: "other-plugin", preview: true, instructions: ["Plugin instructions"] },
]) {
  it.live(`context hook dispatch for ${scenario.pluginID} with preview=${scenario.preview}`, () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      yield* plugins.activate([
        {
          ...fromPromise({
            id: scenario.pluginID,
            async setup(ctx) {
              await ctx.session.hook("context", (event) => {
                event.system.push({ type: "text", text: "Plugin instructions" })
              })
            },
          }),
          revision: "1",
        },
      ])
      yield* plugins.awaitActivation
      const hooks = yield* PluginHooks.Service
      const event = yield* hooks.trigger("session", "context", {
        sessionID: Session.ID.create(),
        agent: Agent.ID.make("build"),
        model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("gpt-5") }),
        preview: scenario.preview,
        system: [],
        messages: [],
        tools: {},
        options: {},
      })
      expect(event.system.map((part) => part.text)).toEqual(scenario.instructions)
    }),
  )
}

it.live("preserves other plugins' preview hook failures", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    yield* plugins.activate([
      {
        id: "other-plugin",
        revision: "1",
        effect: (ctx) => ctx.session.hook("context", () => Effect.die(new Error("Preview hook failed"))),
      },
    ])
    yield* plugins.awaitActivation
    const hooks = yield* PluginHooks.Service
    const result = yield* Effect.exit(
      hooks.trigger("session", "context", {
        sessionID: Session.ID.create(),
        agent: Agent.ID.make("build"),
        model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("gpt-5") }),
        preview: true,
        system: [],
        messages: [],
        tools: {},
        options: {},
      }),
    )
    expect(Exit.isFailure(result)).toBeTrue()
    if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("Preview hook failed")
  }),
)
