import { describe, expect } from "bun:test"
import { DateTime, Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Agent } from "@opencode/core/agent"
import { Model } from "@opencode/core/model"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { SubagentRouterPlugin } from "@opencode/core/plugin/subagent-router"
import { Provider } from "@opencode/core/provider"
import { Project } from "@opencode/core/project"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { Tool } from "@opencode/schema/tool"
import { it, testEffect } from "../lib/effect"
import { host } from "./host"

const rules = [
  { subagent: "explore", parentModel: ["anthropic/nope", "test/parent"], model: "test/first", variant: "fast" },
  { subagent: "explore", parentModel: "test/*", model: "test/second" },
]

describe("subagent router", () => {
  it.effect("rejects malformed rule configuration during activation", () =>
    Effect.gen(function* () {
      const invalid = [
        [{}, "rules"],
        [{ rules: "wrong" }, "rules"],
        [{ rules: [{ subagent: 1, parentModel: "test/*", model: "test/child" }] }, "subagent"],
        [{ rules: [{ subagent: "explore", parentModel: [1], model: "test/child" }] }, "parentModel"],
        [{ rules: [{ subagent: "explore", parentModel: "test/*", model: "child" }] }, "model"],
        [{ rules: [{ subagent: "explore", parentModel: "test/*", model: "test/child", variant: 1 }] }, "variant"],
      ] as const
      for (const [options, field] of invalid) {
        expect(() => SubagentRouterPlugin.loadOptions(options)).toThrow(field)
        expect(() => SubagentRouterPlugin.configured(options).effect(host())).toThrow(field)
      }
      expect(
        SubagentRouterPlugin.loadOptions({ rules: [{ ...rules[0], model: "test/family/first" }] })[0]?.model.id,
      ).toBe(Model.ID.make("family/first"))
    }),
  )

  it.effect("matches the first anchored wildcard rule for the named subagent", () =>
    Effect.sync(() => {
      const loaded = SubagentRouterPlugin.loadOptions({
        rules: [...rules, { subagent: "*", parentModel: "test/*/v2", model: "test/fallback" }],
      })
      expect(SubagentRouterPlugin.findRoute(loaded, { agent: "explore", parentModel: "test/parent" })?.model.id).toBe(
        Model.ID.make("first"),
      )
      expect(SubagentRouterPlugin.findRoute(loaded, { agent: "explore", parentModel: "test/other" })?.model.id).toBe(
        Model.ID.make("second"),
      )
      expect(
        SubagentRouterPlugin.findRoute(loaded, { agent: "general", parentModel: "test/parent/v2" })?.model.id,
      ).toBe(Model.ID.make("fallback"))
      expect(
        SubagentRouterPlugin.findRoute(loaded, { agent: "general", parentModel: "other/test/parent/v2" }),
      ).toBeUndefined()
      expect(SubagentRouterPlugin.findRoute(loaded, { agent: "general", parentModel: "test/parent" })).toBeUndefined()
    }),
  )

  testEffect(AppNodeBuilder.build(LayerNode.group([PluginHooks.node]))).effect(
    "routes only new subagent calls using the current parent model",
    () =>
      Effect.gen(function* () {
        const hooks = yield* PluginHooks.Service
        let parent = Model.Ref.parse("test/parent")
        const base = host()
        yield* SubagentRouterPlugin.configured({ rules }).effect(
          host({
            session: {
              get: () =>
                Effect.succeed({
                  id: Session.ID.make("ses_parent"),
                  projectID: Project.ID.global,
                  location: base.location,
                  cost: Money.USD.zero,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
                  model: parent,
                }),
            },
            model: {
              ...base.model,
              list: () =>
                Effect.succeed({
                  location: base.location,
                  data: [Model.Info.default(Provider.ID.make("test"), Model.ID.make("first"))],
                }),
            },
            tool: {
              ...base.tool,
              hook: (name, callback) => hooks.register("tool", name, callback),
            },
          }),
        )
        const invoke = (tool: string, input: unknown) =>
          hooks.trigger("tool", "execute.before", {
            tool,
            input,
            sessionID: Session.ID.make("ses_parent"),
            agent: Agent.ID.make("build"),
            messageID: SessionMessage.ID.make("msg_parent"),
            id: Tool.CallID.make("call_parent"),
          })
        const unrelated = { agent: "explore" }
        expect((yield* invoke("read", unrelated)).input).toBe(unrelated)
        expect((yield* invoke("subagent", { agent: "explore", model: "test/explicit" })).input).toEqual({
          agent: "explore",
          model: "test/explicit",
        })
        expect((yield* invoke("subagent", { agent: "explore", sessionID: "ses_child" })).input).toEqual({
          agent: "explore",
          sessionID: "ses_child",
        })
        expect((yield* invoke("subagent", { agent: "explore", model: "", sessionID: "" })).input).toEqual({
          agent: "explore",
          model: "test/first",
          sessionID: "",
        })
        parent = Model.Ref.parse("test/other")
        expect((yield* invoke("subagent", { agent: "explore" })).input).toEqual({
          agent: "explore",
          model: "test/second",
        })
      }),
  )
})
